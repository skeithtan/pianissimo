/**
 * Export and restore (spec "Storage and recovery": provide export and restore so browser
 * storage is not the only copy; they transfer the library and practice history between the
 * computer and the iPad).
 *
 * Format `pianissimo-backup` v1, a zip (`*.pianissimo.zip`):
 *
 *   manifest.json                 format, formatVersion, appVersion, createdAt, counts
 *   settings.json                 { settings: AppSettings | null }
 *   pieces.json                   PieceRecord[]
 *   attempts.json                 AttemptRecord[]
 *   measureHistory.json           BarRecord[]
 *   suggestionState.json          SuggestionStateRecord[]
 *   abandonEvents.json            AbandonRecord[]
 *   sources.json                  [{ scoreVersionId, fileName, packaging, sha256, bytesSha256, size, file }]
 *   sources/<id>.bin              the original source bytes
 *   packages/<id>.json            one ScorePackage per score version
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
import type { AbandonRecord, PieceRecord, SuggestionStateRecord } from './records'
import type { BarStoreKey, Db } from './schema'
import { DB_VERSION, SETTINGS_KEY } from './schema'
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
  sourceMetaProblem,
  suggestionStateProblem,
} from './validate'
import { ZipReader, ZipWriter, looksLikeZip } from './zipio'

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
}

/**
 * Serialize everything the player owns into a backup zip: library, original sources, score
 * packages, settings (including label rules), attempts, measure histories, suggestion state and
 * abandon events. Packages and sources are read and compressed one at a time with yields in
 * between, so exporting a large library does not freeze the page or hold it all in memory twice.
 */
export async function exportBackup(db: Db, options: ExportOptions = {}): Promise<Uint8Array> {
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

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: options.appVersion ?? 'unknown',
    createdAt: now,
    dbVersion: DB_VERSION,
    counts: {
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

export interface RestoreOptions {
  /**
   * `backup` (default): replace this browser's settings with the backup's (label rules, naming,
   * hints, ...). `keep`: leave local settings alone.
   */
  readonly settings?: 'backup' | 'keep'
  /**
   * MIDI route settings (port ids, output verification, echo result) belong to one browser and
   * connection and say nothing about this one. `keep-local` (default) keeps this browser's
   * route when settings are restored; `backup` restores it too.
   */
  readonly route?: 'keep-local' | 'backup'
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

export interface RestoreReport {
  readonly manifest: BackupManifest
  readonly stores: Readonly<Record<RestoredStore, MergeCounts>>
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
    throw new BackupError('not-a-backup', 'This zip file is not a Pianissimo backup (it has no manifest.json).')
  }
  const raw = zip.json(FILE.manifest)
  if (!isObj(raw) || raw['format'] !== BACKUP_FORMAT) {
    throw new BackupError('not-a-backup', 'This file is not a Pianissimo backup.')
  }
  const version = raw['formatVersion']
  if (!isInt(version) || version < 1) {
    throw new BackupError('damaged', 'The backup manifest has no valid format version.')
  }
  if (version > BACKUP_FORMAT_VERSION) {
    const app = isStr(raw['appVersion']) ? ` (made by Pianissimo ${raw['appVersion']})` : ''
    throw new BackupError(
      'unsupported-version',
      `This backup${app} uses format ${version}, which this version of Pianissimo cannot read. Update the app and try again.`,
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
    throw new BackupError('damaged', 'The backup manifest has no valid record counts.')
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: version,
    appVersion: isStr(raw['appVersion']) ? raw['appVersion'] : 'unknown',
    createdAt: isNum(raw['createdAt']) ? raw['createdAt'] : 0,
    dbVersion: isInt(raw['dbVersion']) ? raw['dbVersion'] : 0,
    counts: counts as unknown as BackupCounts,
  }
}

function list<T>(zip: ZipReader, file: string, check: (v: unknown) => string | null, problems: string[]): T[] {
  if (!zip.has(file)) throw new BackupError('damaged', `The backup is incomplete: ${file} is missing.`)
  const raw = zip.json(file)
  if (!Array.isArray(raw)) throw new BackupError('damaged', `${file} in the backup is not a list.`)
  raw.forEach((item, i) => {
    const problem = check(item)
    if (problem !== null && problems.length < MAX_PROBLEMS) problems.push(`${file}[${i}] ${problem}`)
  })
  return raw as T[]
}

/** Read and validate the whole backup without touching storage. */
async function readBackup(bytes: Uint8Array): Promise<ParsedBackup> {
  if (!looksLikeZip(bytes)) {
    throw new BackupError('not-a-backup', 'This file is not a Pianissimo backup (it is not a zip archive).')
  }
  const zip = new ZipReader(bytes)
  const manifest = parseManifest(zip)
  const problems: string[] = []

  if (!zip.has(FILE.settings))
    throw new BackupError('damaged', `The backup is incomplete: ${FILE.settings} is missing.`)
  const settingsFile = zip.json(FILE.settings)
  const settings = isObj(settingsFile) ? (settingsFile['settings'] ?? null) : null

  const pieces = list<PieceRecord>(zip, FILE.pieces, pieceProblem, problems)
  const attempts = list<AttemptRecord>(zip, FILE.attempts, attemptProblem, problems)
  const bars = list<BarRecord>(zip, FILE.bars, barProblem, problems)
  const suggestionStates = list<SuggestionStateRecord>(zip, FILE.suggestions, suggestionStateProblem, problems)
  const abandons = list<AbandonRecord>(zip, FILE.abandons, abandonProblem, problems)
  const sources = list<SourceMeta>(zip, FILE.sources, sourceMetaProblem, problems)

  const counts = manifest.counts
  const mismatches: Array<[string, number, number]> = [
    ['pieces', pieces.length, counts.pieces],
    ['attempts', attempts.length, counts.attempts],
    ['measure histories', bars.length, counts.measureHistory],
    ['suggestion records', suggestionStates.length, counts.suggestionState],
    ['abandon records', abandons.length, counts.abandonEvents],
    ['sources', sources.length, counts.sources],
  ]
  for (const [what, actual, expected] of mismatches) {
    if (actual !== expected) {
      throw new BackupError('damaged', `The backup is incomplete: it lists ${expected} ${what} but contains ${actual}.`)
    }
  }
  if ((settings === null ? 0 : 1) !== counts.settings) {
    throw new BackupError('damaged', 'The backup is incomplete: its settings do not match the manifest.')
  }

  const packageFiles = zip.names('packages/')
  if (packageFiles.length !== counts.packages) {
    throw new BackupError(
      'damaged',
      `The backup is incomplete: it lists ${counts.packages} score packages but contains ${packageFiles.length}.`,
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
      if (problems.length < MAX_PROBLEMS) problems.push(`${name}: file name does not match its score version`)
      continue
    }
    packages.set(id, name)
  }

  for (const meta of sources) {
    if (sourceMetaProblem(meta) !== null) continue
    const size = zip.size(meta.file)
    if (size === undefined) {
      problems.push(`${FILE.sources}: ${meta.fileName} has no data in the backup`)
      continue
    }
    if (size !== meta.size) {
      problems.push(`${meta.fileName}: size does not match the backup index`)
      continue
    }
    if (meta.bytesSha256 !== undefined) {
      const actual = await sha256Hex(zip.read(meta.file))
      if (actual !== undefined && actual !== meta.bytesSha256) {
        problems.push(`${meta.fileName}: the stored copy is damaged (checksum mismatch)`)
      }
    }
  }

  if (problems.length > 0) {
    throw new BackupError(
      'invalid',
      `The backup contains records this version cannot read (${problems[0]}). Nothing was restored.`,
      problems.slice(0, MAX_PROBLEMS),
    )
  }
  return { zip, manifest, settings, pieces, attempts, bars, suggestionStates, abandons, packages, sources }
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
 * Validate a backup completely, then merge it into the database in one transaction: either
 * everything is restored or nothing is. Records merge by id and nothing local is deleted:
 * attempts and sources are immutable (kept if present), pieces and bar histories resolve by
 * recency, suggestions and abandon events are unioned, and a package is
 * replaced when the backup's one carries more user input (confirmed hands, tempo) or, with
 * equal input, when the backup's piece records of that version win the merge.
 * Throws `BackupError` with a readable message and writes nothing when the file is not a
 * Pianissimo backup, is damaged, is newer than this app understands, or holds invalid records.
 */
export async function restoreBackup(db: Db, bytes: Uint8Array, options: RestoreOptions = {}): Promise<RestoreReport> {
  const backup = await readBackup(bytes)
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
    ],
    'readwrite',
  )
  await runTx(tx, async () => {
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
      warnings.push(`"${p.title}" was skipped: its score data is not in the backup.`)
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
        const local = await tx.objectStore('settings').get(SETTINGS_KEY)
        const next: AppSettings =
          options.route === 'backup' ? incoming : { ...incoming, route: normalizeSettings(local).route }
        await tx.objectStore('settings').put(next, SETTINGS_KEY)
        settingsOutcome = 'restored'
      }
    }
  })

  return { manifest: backup.manifest, stores, settings: settingsOutcome, warnings }
}
