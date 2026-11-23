import type { RecordingInfo } from '../recording/records'
import { msg } from '../../i18n/messages'
/**
 * Export and restore (spec "Storage and recovery": provide export and restore so browser
 * storage is not the only copy; they transfer the library and practice history between the
 * computer and the iPad).
 *
 * Format `pianissimo-backup` v1, a zip (`*.pianissimo.zip`):
 *
 *   manifest.json                 format, formatVersion, appVersion, createdAt, counts,
 *                                 recordingsExcluded (true when recordings were left out)
 *   settings.json                 { settings: AppSettings | null }
 *   pieces.json                   PieceRecord[]
 *   attempts.json                 AttemptRecord[]
 *   measureHistory.json           BarRecord[]
 *   suggestionState.json          SuggestionStateRecord[]
 *   abandonEvents.json            AbandonRecord[]
 *   sources.json                  [{ scoreVersionId, fileName, packaging, sha256, bytesSha256, size, file }]
 *   sources/<id>.bin              the original source bytes
 *   packages/<id>.json            one ScorePackage per score version
 *   recordings.json               RecordingInfo[] (only when there are takes)
 *   recordings/<id>.mid           a take's MIDI file
 *   recordings/<id>.wav.<i>       its WAV file in stored (not deflated) parts of at most 4 MiB, from 0
 *
 * The layout cache is derived data and is not exported.
 */
import { ABANDON_RETAINED, barKey } from '../history/types'
import type { BarRecord } from '../history/types'
import type { AttemptRecord } from '../model/practice'
import type { ScorePackage, SourceFileRecord } from '../model/score'
import type { AppSettings } from '../model/settings'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from './backupFormat'
import type { BackupCounts, BackupManifest } from './backupFormat'
import { BackupError, MAX_PROBLEMS } from './errors'
import {
  deepEqual,
  incomingPieceWins,
  mergeAbandon,
  mergeBar,
  mergePiece,
  mergeSuggestionState,
  preferPackage,
} from './merge'
import { clearVersionLayouts } from './pieces'
import { isQuotaError } from './persist'
import {
  DamagedTakeError,
  RECORDING_AUDIO_TYPE,
  RECORDING_BLOCK_BYTES,
  filesBytes,
  isLegacyFiles,
  readBlocks,
  writeTake,
} from './recordings'
import type { RecordingFilesRecord } from './recordings'
import type { AbandonRecord, PieceRecord, SuggestionStateRecord } from './records'
import type { BarStoreKey, Db } from './schema'
import { DB_VERSION, INITIAL_LIBRARY_KEY, SETTINGS_KEY } from './schema'
import { normalizeSettings } from './settings'
import { observed, runTx } from './tx'
import {
  abandonProblem,
  attemptProblem,
  barProblem,
  isInt,
  isNum,
  isObj,
  isStr,
  packageProblem,
  pieceProblem,
  recordingProblem,
  sourceMetaProblem,
  suggestionStateProblem,
} from './validate'
import { ZipLimitError, ZipReader, ZipWriter, looksLikeZip } from './zipio'
import type { ZipSource } from './zipio'

const FILE = {
  manifest: 'manifest.json',
  settings: 'settings.json',
  pieces: 'pieces.json',
  attempts: 'attempts.json',
  bars: 'measureHistory.json',
  suggestions: 'suggestionState.json',
  abandons: 'abandonEvents.json',
  sources: 'sources.json',
} as const

const entryName = (id: string): string => encodeURIComponent(id)

async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return undefined
  const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ExportOptions {
  /** Recorded in the manifest. */
  readonly appVersion?: string
  readonly now?: number
  /** Include recorded takes (default true). Without them the manifest says they were left out. */
  readonly includeRecordings?: boolean
}

const RECORDINGS_DIR = 'recordings/'
/** Room for the manifest, which is written last. */
const MANIFEST_ALLOWANCE = 4096

/**
 * Serialize everything the player owns into a backup zip: library, original sources, score
 * packages, settings (including label rules), attempts, measure histories, suggestion state,
 * abandon events and, unless left out, recorded takes. Packages and sources are read and
 * compressed one at a time with yields in between, and a take's audio one block at a time, so
 * exporting does not freeze the page. The archive is a Blob built from parts: no array of the
 * whole file exists, and each audio block is released once it is in the archive.
 *
 * Refuses (`BackupError` 'too-large') a backup that `restoreBackup` would refuse for its size,
 * before reading any audio when the takes alone make it too large.
 */
export async function exportBackup(db: Db, options: ExportOptions = {}): Promise<Blob> {
  const includeRecordings = options.includeRecordings ?? true
  let tooLargeHint = false
  try {
    return await writeBackup(db, options, includeRecordings, (hasTakes) => {
      tooLargeHint = hasTakes
    })
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error
    throw new BackupError(
      'too-large',
      tooLargeHint
        ? msg(
            'The backup was not created because it would be too large to restore. Turn off “Include recordings” and export again.',
          )
        : msg('The backup was not created because it would be too large to restore.'),
    )
  }
}

async function writeBackup(
  db: Db,
  options: ExportOptions,
  includeRecordings: boolean,
  onTakes: (hasTakes: boolean) => void,
): Promise<Blob> {
  const now = options.now ?? Date.now()
  const tx = db.transaction(
    ['pieces', 'settings', 'attempts', 'measureHistory', 'suggestionState', 'abandonEvents', 'packages', 'sources'],
    'readonly',
  )
  const [pieces, settings, attempts, bars, suggestionState, abandons, packageKeys, sourceKeys] = await runTx(tx, () =>
    Promise.all([
      tx.objectStore('pieces').getAll(),
      tx.objectStore('settings').get(SETTINGS_KEY),
      tx.objectStore('attempts').getAll(),
      tx.objectStore('measureHistory').getAll(),
      tx.objectStore('suggestionState').getAll(),
      tx.objectStore('abandonEvents').getAll(),
      tx.objectStore('packages').getAllKeys(),
      tx.objectStore('sources').getAllKeys(),
    ]),
  )

  const zip = new ZipWriter(now)
  await zip.addJson(FILE.settings, { settings: settings ?? null })
  await zip.addJson(FILE.pieces, pieces)
  await zip.addJson(FILE.attempts, attempts)
  await zip.addJson(FILE.bars, bars)
  await zip.addJson(FILE.suggestions, suggestionState)
  await zip.addJson(FILE.abandons, abandons)

  let packages = 0
  for (const key of packageKeys) {
    const pkg = await db.get('packages', key)
    if (!pkg) continue
    await zip.addJson(`packages/${entryName(key)}.json`, pkg)
    packages += 1
  }

  const sourceMetas: unknown[] = []
  for (const key of sourceKeys) {
    const source = await db.get('sources', key)
    if (!source) continue
    const bytes = new Uint8Array(source.bytes)
    const file = `sources/${entryName(key)}.bin`
    // Already-compressed packagings gain nothing from a second deflate.
    await zip.add(file, bytes, source.packaging !== 'mxl')
    const bytesSha256 = await sha256Hex(bytes)
    sourceMetas.push({
      scoreVersionId: key,
      fileName: source.fileName,
      packaging: source.packaging,
      sha256: source.sha256,
      ...(bytesSha256 !== undefined ? { bytesSha256 } : {}),
      size: bytes.length,
      file,
    })
  }
  await zip.addJson(FILE.sources, sourceMetas)

  const recordings = includeRecordings ? await addRecordings(db, zip, onTakes) : []
  if (recordings.length) await zip.addJson('recordings.json', recordings)

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: options.appVersion ?? 'unknown',
    createdAt: now,
    dbVersion: DB_VERSION,
    ...(includeRecordings ? {} : { recordingsExcluded: true }),
    counts: {
      ...(recordings.length ? { recordings: recordings.length } : {}),
      pieces: pieces.length,
      packages,
      sources: sourceMetas.length,
      attempts: attempts.length,
      measureHistory: bars.length,
      suggestionState: suggestionState.length,
      abandonEvents: abandons.length,
      settings: settings ? 1 : 0,
    },
  }
  await zip.addJson(FILE.manifest, manifest)
  return zip.finish()
}

/**
 * Add every take: its MIDI file, then its audio one stored part per block. Checks first that all
 * of it fits the restore limits, from the files records' sizes. A take that turns out to be
 * damaged (a missing block) is left out of `recordings.json`; its parts already written are
 * ignored by restore.
 */
async function addRecordings(db: Db, zip: ZipWriter, onTakes: (hasTakes: boolean) => void): Promise<RecordingInfo[]> {
  const infos = await db.getAll('recordings')
  const sizes = new Map<string, { bytes: number; parts: number }>()
  const tx = db.transaction('recordingFiles', 'readonly')
  await runTx(tx, async () => {
    let cursor = await tx.store.openCursor()
    while (cursor) {
      const record = cursor.value
      const parts = isLegacyFiles(record) ? record.audio.length : record.blocks
      sizes.set(cursor.key, { bytes: filesBytes(record), parts: Math.max(1, parts) })
      cursor = await cursor.continue()
    }
  })
  const takes = infos.filter((info) => sizes.has(info.id))
  onTakes(takes.length > 0)
  let bytes = new TextEncoder().encode(JSON.stringify(takes)).length + MANIFEST_ALLOWANCE
  let entries = 2
  for (const info of takes) {
    const size = sizes.get(info.id)!
    bytes += size.bytes
    entries += 1 + size.parts
  }
  if (!zip.fits(bytes, entries)) throw new ZipLimitError(RECORDINGS_DIR)

  const added: RecordingInfo[] = []
  for (const info of takes) {
    const record: RecordingFilesRecord | undefined = await db.get('recordingFiles', info.id)
    if (!record) continue
    const path = RECORDINGS_DIR + entryName(info.id)
    await zip.add(path + '.mid', new Uint8Array(record.midi), false)
    let part = 0
    try {
      const blocks = isLegacyFiles(record) ? record.audio : readBlocks(db, info.id, record)
      for await (const block of blocks) await zip.add(path + '.wav.' + part++, new Uint8Array(block), false)
    } catch (error) {
      if (error instanceof DamagedTakeError) continue
      throw error
    }
    // Readers before schema 4 require at least one part, even for a take without audio.
    if (part === 0) await zip.add(path + '.wav.0', new Uint8Array(0), false)
    added.push(info)
  }
  return added
}

export interface RestoreOptions {
  /**
   * `backup` (default): replace this browser's settings with the backup's (label rules, naming,
   * hints, ...). `keep`: leave local settings alone.
   */
  readonly settings?: 'backup' | 'keep'
  /**
   * MIDI route settings (port ids, output verification, echo result), the metronome's audio output
   * and the recording input belong to one browser and connection and say nothing about this one.
   * `keep-local` (default) keeps this browser's when settings are restored; `backup` restores
   * them too.
   */
  readonly route?: 'keep-local' | 'backup'
  /** Clock of the unfinished-write markers of restored takes (tests). */
  readonly now?: () => number
}

export interface MergeCounts {
  added: number
  updated: number
  unchanged: number
  /** Not restored: it belongs to a piece that cannot be restored. */
  skipped: number
}

export type RestoredStore =
  'pieces' | 'packages' | 'sources' | 'attempts' | 'measureHistory' | 'suggestionState' | 'abandonEvents'

/** Takes are immutable: each is added, already here, or could not be stored in this browser. */
export interface RecordingCounts {
  added: number
  /** Already on this device (same id): kept as it is. */
  skipped: number
  /** Could not be stored (quota, a value this browser refuses); named in `warnings`. */
  failed: number
}

export interface RestoreReport {
  readonly manifest: BackupManifest
  readonly stores: Readonly<Record<RestoredStore, MergeCounts>>
  readonly recordings: Readonly<RecordingCounts>
  readonly settings: 'restored' | 'kept' | 'not-in-backup'
  readonly warnings: readonly string[]
}

interface SourceMeta {
  readonly scoreVersionId: string
  readonly fileName: string
  readonly packaging: SourceFileRecord['packaging']
  readonly sha256: string
  readonly bytesSha256?: string
  readonly size: number
  readonly file: string
}

interface ParsedBackup {
  readonly recordings: RecordingInfo[]
  readonly zip: ZipReader
  readonly manifest: BackupManifest
  readonly settings: unknown
  readonly pieces: PieceRecord[]
  readonly attempts: AttemptRecord[]
  readonly bars: BarRecord[]
  readonly suggestionStates: SuggestionStateRecord[]
  readonly abandons: AbandonRecord[]
  readonly packages: ReadonlyMap<string, string>
  readonly sources: SourceMeta[]
}

function parseManifest(zip: ZipReader): BackupManifest {
  if (!zip.has(FILE.manifest)) {
    throw new BackupError('not-a-backup', msg('This zip file is not a Pianissimo backup (it has no manifest.json).'))
  }
  const raw = zip.json(FILE.manifest)
  if (!isObj(raw) || raw['format'] !== BACKUP_FORMAT) {
    throw new BackupError('not-a-backup', msg('This file is not a Pianissimo backup.'))
  }
  const version = raw['formatVersion']
  if (!isInt(version) || version < 1) {
    throw new BackupError('damaged', msg('The backup manifest has no valid format version.'))
  }
  if (version > BACKUP_FORMAT_VERSION) {
    const app = isStr(raw['appVersion']) ? msg(' (made by Pianissimo {0})', raw['appVersion']) : ''
    throw new BackupError(
      'unsupported-version',
      msg(
        'This backup{0} uses format {1}, which this version of Pianissimo cannot read. Update the app and try again.',
        app,
        version,
      ),
    )
  }
  const counts = raw['counts']
  const keys = [
    'pieces',
    'packages',
    'sources',
    'attempts',
    'measureHistory',
    'suggestionState',
    'abandonEvents',
    'settings',
  ]
  if (!isObj(counts) || !keys.every((k) => isInt(counts[k]) && (counts[k] as number) >= 0)) {
    throw new BackupError('damaged', msg('The backup manifest has no valid record counts.'))
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: version,
    appVersion: isStr(raw['appVersion']) ? raw['appVersion'] : 'unknown',
    createdAt: isNum(raw['createdAt']) ? raw['createdAt'] : 0,
    dbVersion: isInt(raw['dbVersion']) ? raw['dbVersion'] : 0,
    ...(raw['recordingsExcluded'] === true ? { recordingsExcluded: true } : {}),
    counts: counts as unknown as BackupCounts,
  }
}

function list<T>(zip: ZipReader, file: string, check: (v: unknown) => string | null, problems: string[]): T[] {
  if (!zip.has(file)) throw new BackupError('damaged', msg('The backup is incomplete: {0} is missing.', file))
  const raw = zip.json(file)
  if (!Array.isArray(raw)) throw new BackupError('damaged', msg('{0} in the backup is not a list.', file))
  raw.forEach((item, i) => {
    const problem = check(item)
    if (problem !== null && problems.length < MAX_PROBLEMS) problems.push(`${file}[${i}] ${problem}`)
  })
  return raw as T[]
}

/**
 * Read and validate the whole backup without touching storage. Everything but the takes' files
 * is loaded into memory (it is small, and the main transaction reads it synchronously); the
 * takes' files stay in the source until each take is restored.
 */
async function readBackup(source: ZipSource): Promise<ParsedBackup> {
  if (!(await looksLikeZip(source))) {
    throw new BackupError('not-a-backup', msg('This file is not a Pianissimo backup (it is not a zip archive).'))
  }
  const zip = await ZipReader.open(source)
  await zip.load((name) => !name.startsWith(RECORDINGS_DIR))
  const manifest = parseManifest(zip)
  const problems: string[] = []

  if (!zip.has(FILE.settings))
    throw new BackupError('damaged', msg('The backup is incomplete: {0} is missing.', FILE.settings))
  const settingsFile = zip.json(FILE.settings)
  const settings = isObj(settingsFile) ? (settingsFile['settings'] ?? null) : null

  const pieces = list<PieceRecord>(zip, FILE.pieces, pieceProblem, problems)
  const attempts = list<AttemptRecord>(zip, FILE.attempts, attemptProblem, problems)
  const bars = list<BarRecord>(zip, FILE.bars, barProblem, problems)
  const suggestionStates = list<SuggestionStateRecord>(zip, FILE.suggestions, suggestionStateProblem, problems)
  const abandons = list<AbandonRecord>(zip, FILE.abandons, abandonProblem, problems)
  const sources = list<SourceMeta>(zip, FILE.sources, sourceMetaProblem, problems)

  const recordings = zip.has('recordings.json')
    ? list<RecordingInfo>(zip, 'recordings.json', recordingProblem, problems)
    : []
  const ids = new Set<string>()
  for (const info of recordings) {
    if (recordingProblem(info)) continue
    const path = RECORDINGS_DIR + entryName(info.id)
    const parts = zip.names(path + '.wav.')
    if (
      ids.has(info.id) ||
      !zip.has(path + '.mid') ||
      !parts.length ||
      !parts.every((_, i) => zip.has(path + '.wav.' + i))
    ) {
      problems.push(msg('{0}: {1} has no data in the backup', 'recordings.json', info.title))
    }
    ids.add(info.id)
  }
  const counts = manifest.counts
  const mismatches: Array<[string, number, number]> = [
    ['recordings', recordings.length, counts.recordings ?? 0],
    ['pieces', pieces.length, counts.pieces],
    ['attempts', attempts.length, counts.attempts],
    [msg('measure histories'), bars.length, counts.measureHistory],
    [msg('suggestion records'), suggestionStates.length, counts.suggestionState],
    [msg('abandon records'), abandons.length, counts.abandonEvents],
    ['sources', sources.length, counts.sources],
  ]
  for (const [what, actual, expected] of mismatches) {
    if (actual !== expected) {
      throw new BackupError(
        'damaged',
        msg('The backup is incomplete: it lists {0} {1} but contains {2}.', expected, what, actual),
      )
    }
  }
  if ((settings === null ? 0 : 1) !== counts.settings) {
    throw new BackupError('damaged', msg('The backup is incomplete: its settings do not match the manifest.'))
  }

  const packageFiles = zip.names('packages/')
  if (packageFiles.length !== counts.packages) {
    throw new BackupError(
      'damaged',
      msg(
        'The backup is incomplete: it lists {0} score packages but contains {1}.',
        counts.packages,
        packageFiles.length,
      ),
    )
  }
  const packages = new Map<string, string>()
  for (const name of packageFiles) {
    const pkg = zip.json(name)
    const problem = packageProblem(pkg)
    if (problem !== null) {
      if (problems.length < MAX_PROBLEMS) problems.push(`${name}: ${problem}`)
      continue
    }
    const id = (pkg as ScorePackage).model.scoreVersionId
    if (name !== `packages/${entryName(id)}.json`) {
      if (problems.length < MAX_PROBLEMS) problems.push(msg('{0}: file name does not match its score version', name))
      continue
    }
    packages.set(id, name)
  }

  for (const meta of sources) {
    if (sourceMetaProblem(meta) !== null) continue
    const size = zip.size(meta.file)
    if (size === undefined) {
      problems.push(msg('{0}: {1} has no data in the backup', FILE.sources, meta.fileName))
      continue
    }
    if (size !== meta.size) {
      problems.push(msg('{0}: size does not match the backup index', meta.fileName))
      continue
    }
    if (meta.bytesSha256 !== undefined) {
      const actual = await sha256Hex(zip.read(meta.file))
      if (actual !== undefined && actual !== meta.bytesSha256) {
        problems.push(msg('{0}: the stored copy is damaged (checksum mismatch)', meta.fileName))
      }
    }
  }

  if (problems.length > 0) {
    throw new BackupError(
      'invalid',
      msg('The backup contains records this version cannot read ({0}). Nothing was restored.', problems[0]),
      problems.slice(0, MAX_PROBLEMS),
    )
  }
  return { zip, manifest, recordings, settings, pieces, attempts, bars, suggestionStates, abandons, packages, sources }
}

const CHUNK = 200

function emptyCounts(): MergeCounts {
  return { added: 0, updated: 0, unchanged: 0, skipped: 0 }
}

/** Merge records in chunks: look up the existing ones in parallel, then write what changed. */
async function mergeRecords<T>(
  records: readonly T[],
  counts: MergeCounts,
  io: {
    get(record: T): Promise<T | undefined>
    put(record: T): Promise<unknown>
    merge(local: T, incoming: T): T
  },
): Promise<void> {
  for (let at = 0; at < records.length; at += CHUNK) {
    const chunk = records.slice(at, at + CHUNK)
    const existing = await Promise.all(chunk.map((r) => io.get(r)))
    const writes: Promise<unknown>[] = []
    chunk.forEach((incoming, i) => {
      const local = existing[i]
      if (local === undefined) {
        counts.added += 1
        writes.push(observed(io.put(incoming)))
        return
      }
      const merged = io.merge(local, incoming)
      if (deepEqual(merged, local)) {
        counts.unchanged += 1
      } else {
        counts.updated += 1
        writes.push(observed(io.put(merged)))
      }
    })
    await Promise.all(writes)
  }
}

/**
 * Score versions whose package restore takes from the backup when both sides carry one of equal
 * user input: those whose most recently opened piece after the merge is the backup's record
 * (`mergePiece` resolves each piece by recency, ties keeping the local one). The package then
 * matches the piece records' practice tempo and hands (ST3).
 */
function versionsWonByBackup(
  local: readonly PieceRecord[],
  incoming: readonly PieceRecord[],
  available: ReadonlySet<string>,
): Set<string> {
  const localById = new Map(local.map((p) => [p.id, p]))
  const latest = new Map<string, { at: number; incoming: boolean }>()
  const note = (piece: PieceRecord, fromBackup: boolean): void => {
    const current = latest.get(piece.scoreVersionId)
    if (!current || piece.lastOpenedAt > current.at || (!fromBackup && piece.lastOpenedAt === current.at)) {
      latest.set(piece.scoreVersionId, { at: piece.lastOpenedAt, incoming: fromBackup })
    }
  }
  const replaced = new Set<string>()
  const winners: PieceRecord[] = []
  for (const p of incoming) {
    if (!available.has(p.scoreVersionId)) continue
    const mine = localById.get(p.id)
    if (mine && !incomingPieceWins(mine, p)) continue
    replaced.add(p.id)
    winners.push(p)
  }
  for (const p of local) if (!replaced.has(p.id)) note(p, false)
  for (const p of winners) note(p, true)
  const won = new Set<string>()
  for (const [version, entry] of latest) if (entry.incoming) won.add(version)
  return won
}

/**
 * Validate a backup completely, then merge the library, results, histories and settings into
 * the database in one transaction: either all of that is restored or nothing is. Records merge
 * by id and nothing local is deleted: attempts and sources are immutable (kept if present),
 * pieces and bar histories resolve by recency, suggestions and abandon events are unioned, and
 * a package is replaced when the backup's one carries more user input (confirmed hands, tempo)
 * or, with equal input, when the backup's piece records of that version win the merge.
 * Throws `BackupError` with a readable message and writes nothing when the file is not a
 * Pianissimo backup, is damaged, is newer than this app understands, or holds invalid records.
 *
 * Takes are restored after that transaction has committed, each on its own and read from the
 * source a block at a time. One already here is kept; one that cannot be stored (storage full,
 * a value this browser refuses) is left out, named in `warnings` and counted as failed, and
 * never undoes the rest.
 */
export async function restoreBackup(db: Db, source: ZipSource, options: RestoreOptions = {}): Promise<RestoreReport> {
  const backup = await readBackup(source)
  const stores: Record<RestoredStore, MergeCounts> = {
    pieces: emptyCounts(),
    packages: emptyCounts(),
    sources: emptyCounts(),
    attempts: emptyCounts(),
    measureHistory: emptyCounts(),
    suggestionState: emptyCounts(),
    abandonEvents: emptyCounts(),
  }
  const warnings: string[] = []
  let settingsOutcome: RestoreReport['settings'] = 'not-in-backup'

  const tx = db.transaction(
    [
      'pieces',
      'packages',
      'sources',
      'settings',
      'attempts',
      'measureHistory',
      'suggestionState',
      'abandonEvents',
      'layoutCache',
      'layoutMeta',
      'libraryState',
    ],
    'readwrite',
  )
  await runTx(tx, async () => {
    // An explicit restore, including an intentionally empty backup, chooses this library.
    await tx.objectStore('libraryState').put('complete', INITIAL_LIBRARY_KEY)
    const localPackages = new Set<string>(await tx.objectStore('packages').getAllKeys())
    const localPieces = await tx.objectStore('pieces').getAll()
    const localPieceIds = new Set<string>(localPieces.map((p) => p.id))
    const incomingWins = versionsWonByBackup(
      localPieces,
      backup.pieces,
      new Set([...localPackages, ...backup.packages.keys()]),
    )

    // Packages first: a piece is only restorable when its package exists in the backup or locally.
    for (const [id, name] of backup.packages) {
      const incoming = backup.zip.json(name) as ScorePackage
      const local = await tx.objectStore('packages').get(id)
      if (!local) {
        stores.packages.added += 1
        await tx.objectStore('packages').put(incoming, id)
        localPackages.add(id)
        continue
      }
      const chosen = preferPackage(local, incoming, incomingWins.has(id))
      if (chosen === local || deepEqual(chosen, local)) {
        stores.packages.unchanged += 1
      } else {
        stores.packages.updated += 1
        await tx.objectStore('packages').put(chosen, id)
        // Cached layouts carry the old package's hands.
        await clearVersionLayouts(tx, id)
      }
    }

    for (const meta of backup.sources) {
      const local = await tx.objectStore('sources').get(meta.scoreVersionId)
      if (local) {
        stores.sources.unchanged += 1
        continue
      }
      const data = backup.zip.read(meta.file)
      const record: SourceFileRecord = {
        fileName: meta.fileName,
        packaging: meta.packaging,
        bytes: data.slice().buffer,
        sha256: meta.sha256,
      }
      stores.sources.added += 1
      await tx.objectStore('sources').put(record, meta.scoreVersionId)
    }

    const restorable = backup.pieces.filter((p) => {
      if (localPackages.has(p.scoreVersionId)) return true
      warnings.push(msg('"{0}" was skipped: its score data is not in the backup.', p.title))
      return false
    })
    stores.pieces.skipped = backup.pieces.length - restorable.length
    const accepted = new Set<string>([...localPieceIds, ...restorable.map((p) => p.id)])

    await mergeRecords(restorable, stores.pieces, {
      get: (p) => tx.objectStore('pieces').get(p.id),
      put: (p) => tx.objectStore('pieces').put(p),
      merge: mergePiece,
    })

    const known = <T extends { pieceId: string }>(records: readonly T[], counts: MergeCounts): T[] => {
      const kept = records.filter((r) => accepted.has(r.pieceId))
      counts.skipped = records.length - kept.length
      return kept
    }

    await mergeRecords(known(backup.attempts, stores.attempts), stores.attempts, {
      get: (a) => tx.objectStore('attempts').get(a.id),
      put: (a) => tx.objectStore('attempts').put(a),
      merge: (local) => local,
    })

    const barStoreKey = (b: BarRecord): BarStoreKey => [b.pieceId, barKey(b.measureContextKey, b.occ)]
    await mergeRecords(known(backup.bars, stores.measureHistory), stores.measureHistory, {
      get: (b) => tx.objectStore('measureHistory').get(barStoreKey(b)),
      put: (b) => tx.objectStore('measureHistory').put(b, barStoreKey(b)),
      merge: mergeBar,
    })

    await mergeRecords(known(backup.suggestionStates, stores.suggestionState), stores.suggestionState, {
      get: (s) => tx.objectStore('suggestionState').get(s.pieceId),
      put: (s) => tx.objectStore('suggestionState').put(s),
      merge: mergeSuggestionState,
    })

    const abandonKey = (r: AbandonRecord): BarStoreKey => [r.pieceId, barKey(r.measureContextKey, r.occ)]
    const trimmed = backup.abandons.map((r) => ({ ...r, events: r.events.slice(-ABANDON_RETAINED) }))
    await mergeRecords(known(trimmed, stores.abandonEvents), stores.abandonEvents, {
      get: (r) => tx.objectStore('abandonEvents').get(abandonKey(r)),
      put: (r) => tx.objectStore('abandonEvents').put(r, abandonKey(r)),
      merge: mergeAbandon,
    })

    if (backup.settings !== null) {
      if (options.settings === 'keep') {
        settingsOutcome = 'kept'
      } else {
        const incoming = normalizeSettings(backup.settings)
        const local = normalizeSettings(await tx.objectStore('settings').get(SETTINGS_KEY))
        // The metronome's audio output and the recording input name devices of the machine that
        // made the backup, like the MIDI route: all stay this device's unless the route is
        // restored too.
        const next: AppSettings =
          options.route === 'backup'
            ? incoming
            : {
                ...incoming,
                route: local.route,
                metronome: { ...incoming.metronome, outputId: local.metronome.outputId },
                recording: local.recording,
              }
        await tx.objectStore('settings').put(next, SETTINGS_KEY)
        settingsOutcome = 'restored'
      }
    }
  })

  const recordings = await restoreTakes(db, backup, warnings, options.now ?? Date.now)
  return { manifest: backup.manifest, stores, recordings, settings: settingsOutcome, warnings }
}

/** Restore each take of the backup on its own (see `restoreBackup`). */
async function restoreTakes(
  db: Db,
  backup: ParsedBackup,
  warnings: string[],
  now: () => number,
): Promise<RecordingCounts> {
  const counts: RecordingCounts = { added: 0, skipped: 0, failed: 0 }
  const zip = backup.zip
  for (const info of backup.recordings) {
    const path = RECORDINGS_DIR + entryName(info.id)
    const parts = zip.names(path + '.wav.').map((_, i) => `${path}.wav.${i}`)
    try {
      if ((await db.getKey('recordings', info.id)) !== undefined) {
        counts.skipped += 1
        continue
      }
      const midi = (await zip.fetch(path + '.mid')).slice().buffer
      const added = await writeTake(
        db,
        {
          info,
          midi,
          type: RECORDING_AUDIO_TYPE,
          audio: (async function* () {
            for (const part of parts) yield* zip.pieces(part, RECORDING_BLOCK_BYTES)
          })(),
          bytes: parts.reduce((sum, part) => sum + (zip.size(part) ?? 0), 0),
        },
        now,
      )
      if (added) counts.added += 1
      else counts.skipped += 1
    } catch (error) {
      counts.failed += 1
      warnings.push(
        isQuotaError(error)
          ? msg('The recording "{0}" was not restored because this browser’s storage is full.', info.title)
          : msg('The recording "{0}" could not be restored in this browser.', info.title),
      )
    }
  }
  return counts
}
