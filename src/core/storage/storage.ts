import type { RecordingInfo, RecordingFiles } from '../recording/records'
import { deleteDB } from 'idb'
import { summarizeByContext } from '../history/results'
import type { ContextResults } from '../history/results'
import { selectSuggestions } from '../history/selection'
import type { SuggestionSelection } from '../history/selection'
import type { PieceHistory } from '../history/types'
import { handAssignmentId, type AttemptRecord } from '../model/practice'
import type { ScorePackage, SourceFileRecord } from '../model/score'
import type { AppSettings } from '../model/settings'
import { hasTempo, tempoMapId, userTempoMap } from '../music/tempo'
import { addAttempts, getAttempt, listAttempts, listRecentAttempts } from './attempts'
import type { AttemptQuery } from './attempts'
import type { RestoreOptions, RestoreReport } from './backup'
import { HistoryWriter } from './historyWriter'
import type { HistoryWriterOptions } from './historyWriter'
import { LayoutCache } from './layoutCache'
import type { LayoutCacheStats } from './layoutCache'
import {
  commitImport,
  deletePiece,
  getPackage,
  getPiece,
  getSource,
  listPieces,
  putPackage,
  putPiece,
  updatePiece,
} from './pieces'
import type { ImportCommit } from './pieces'
import type { LayoutCacheLimits, PiecePatch, PieceRecord } from './records'
import {
  RECORDING_AUDIO_TYPE,
  blobBlocks,
  discardAbandonedWrites,
  listTakes,
  markTakes,
  readTakeFiles,
  readTakeMidi,
  removeDiscarded,
  removeLongDiscarded,
  summarizeTakes,
  writeTake,
} from './recordings'
import type { RecordingsSummary } from './recordings'
import { DEFAULT_DB_NAME, SETTINGS_KEY, openPianissimoDb } from './schema'
import { normalizeSettings } from './settings'
import type { ClearOptions } from './historyStore'
import { initializeLibrary, needsInitialPieces, needsLibraryExpansion } from './initialLibrary'
import type { ZipSource } from './zipio'

export interface StorageOptions {
  /** Recorded in exported backups. */
  readonly appVersion?: string
  readonly layoutCache?: Partial<LayoutCacheLimits>
  readonly history?: HistoryWriterOptions
  readonly now?: () => number
  /** The database upgrade waits for another tab that keeps an older version open. */
  readonly onBlocked?: () => void
}

export interface ExportAllOptions {
  /** Include recorded takes (default true). */
  readonly includeRecordings?: boolean
}

/** The persistence API for the views and the practice session. See the module README. */
export interface PianissimoStorage {
  readonly name: string
  /** Batched, asynchronous practice history (attempts, traversals, abandon events). */
  readonly history: HistoryWriter
  close(): void

  // Library
  needsInitialPieces(): Promise<boolean>
  needsLibraryExpansion(): Promise<boolean>
  initializeLibrary(inputs: readonly ImportCommit[], mode?: 'initial' | 'expansion'): Promise<boolean>
  listPieces(): Promise<PieceRecord[]>
  getPiece(id: string): Promise<PieceRecord | undefined>
  putPiece(piece: PieceRecord): Promise<void>
  updatePiece(id: string, patch: PiecePatch): Promise<PieceRecord | undefined>
  deletePiece(id: string): Promise<boolean>
  commitImport(input: ImportCommit): Promise<void>
  getPackage(scoreVersionId: string): Promise<ScorePackage | undefined>
  putPackage(pkg: ScorePackage): Promise<void>
  getSource(scoreVersionId: string): Promise<SourceFileRecord | undefined>

  // Settings
  loadSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>

  // Recordings (see recordings.ts)
  listRecordings(): Promise<RecordingInfo[]>
  /**
   * A take's files as Blobs. The WAV Blob is assembled from the stored blocks, which are read a
   * couple at a time: play it through an object URL and download it without another copy.
   */
  getRecordingFiles(id: string): Promise<RecordingFiles | undefined>
  /** Store a take, reading its WAV Blob one block at a time. Listed only once complete. */
  saveRecording(info: RecordingInfo, files: RecordingFiles): Promise<void>
  /** A take's MIDI file alone (the audio is not read). */
  getRecordingMidi(id: string): Promise<ArrayBuffer | undefined>
  /** Take these out of every list, at once and durably. Their files stay until they are removed. */
  discardRecordings(ids: readonly string[]): Promise<void>
  /** Bring discarded takes back. */
  restoreRecordings(ids: readonly string[]): Promise<void>
  /** Remove discarded takes and their files for good. One that was brought back is left alone. */
  removeDiscardedRecordings(ids: readonly string[]): Promise<void>
  /** How many takes there are and how many bytes their files hold (for the backup choice). */
  recordingsSummary(): Promise<RecordingsSummary>

  // Results
  addAttempts(records: readonly AttemptRecord[]): Promise<void>
  listAttempts(query: AttemptQuery): Promise<AttemptRecord[]>
  /**
   * The piece's most recent attempts, newest first, at most `limit` (all score versions and
   * contexts: the caller filters). Reads only what it returns: a cursor over the `pieceId` index
   * from the end, never the piece's whole history.
   */
  listRecentAttempts(pieceId: string, limit: number): Promise<AttemptRecord[]>
  getAttempt(id: string): Promise<AttemptRecord | undefined>

  // Suggested practice
  /** Up-to-date measure histories and suggestion state for a piece (flushes queued records first). */
  loadPieceHistory(pieceId: string): Promise<PieceHistory>
  /**
   * The suggestions to show for a piece's current score version (up to three, plus Improved),
   * honoring the global and per-piece switches and the session's dismissals.
   */
  loadSuggestions(pieceId: string, dismissed?: { has(id: string): boolean }): Promise<SuggestionSelection>
  /** Scorecards grouped by comparison context for a piece's current score version, latest first. */
  loadResults(pieceId: string): Promise<ContextResults[]>
  setSuggestionsDisabled(pieceId: string, disabled: boolean): Promise<void>
  clearPracticeHistory(pieceId: string, options?: ClearOptions): Promise<void>

  // Renderer layout cache (derived data)
  getLayout(key: string): Promise<unknown | undefined>
  putLayout(key: string, scoreVersionId: string, value: unknown, approxBytes: number): Promise<boolean>
  clearLayouts(scoreVersionId?: string): Promise<void>
  layoutCacheStats(): Promise<LayoutCacheStats>

  // Export / restore
  /** The backup archive as a Blob assembled from parts (save it as `backupFileName()`). */
  exportAll(options?: ExportAllOptions): Promise<Blob>
  /** Restore a backup from a picked file (read by slices) or bytes. */
  restore(source: ZipSource, options?: RestoreOptions): Promise<RestoreReport>
}

/** Open (creating on first use) the IndexedDB database `name`. */
export async function openStorage(
  name: string = DEFAULT_DB_NAME,
  options: StorageOptions = {},
): Promise<PianissimoStorage> {
  const db = await openPianissimoDb(name, options.onBlocked ? { onBlocked: options.onBlocked } : {})
  const now = options.now ?? Date.now
  // Takes whose blocks a closed page left half written are never listed; free their space.
  await discardAbandonedWrites(db, now()).catch(() => undefined)
  await removeLongDiscarded(db, now()).catch(() => undefined)
  const history = new HistoryWriter(db, options.history)
  const layouts = new LayoutCache(db, options.layoutCache, options.now)
  const settleHistory = (): Promise<unknown> => history.flush().catch(() => undefined)

  return {
    name,
    history,
    close: () => {
      db.close()
    },

    needsInitialPieces: () => needsInitialPieces(db),
    needsLibraryExpansion: () => needsLibraryExpansion(db),
    initializeLibrary: (inputs, mode) => initializeLibrary(db, inputs, mode),
    listPieces: () => listPieces(db),
    getPiece: (id) => getPiece(db, id),
    putPiece: (piece) => putPiece(db, piece),
    updatePiece: (id, patch) => updatePiece(db, id, patch),
    async deletePiece(id) {
      history.discard(id)
      await settleHistory()
      const removed = await deletePiece(db, id)
      history.forget(id)
      return removed
    },
    commitImport: (input) => commitImport(db, input),
    getPackage: (id) => getPackage(db, id),
    putPackage: (pkg) => putPackage(db, pkg),
    getSource: (id) => getSource(db, id),

    async loadSettings() {
      return normalizeSettings(await db.get('settings', SETTINGS_KEY))
    },
    async saveSettings(settings) {
      const normalized = normalizeSettings(settings)
      await db.put('settings', normalized, SETTINGS_KEY)
      return normalized
    },

    addAttempts: (records) => addAttempts(db, records),
    listAttempts: (query) => listAttempts(db, query),
    listRecentAttempts: (pieceId, limit) => listRecentAttempts(db, pieceId, limit),
    getAttempt: (id) => getAttempt(db, id),

    loadPieceHistory: (pieceId) => history.getHistory(pieceId),
    async loadSuggestions(pieceId, dismissed) {
      const piece = await getPiece(db, pieceId)
      const none: SuggestionSelection = { active: [], improved: [], disabled: false }
      if (!piece) return none
      // Ingest persists suggestion state with its evidence. Check that small record before
      // cloning a score or caching its histories just to discover there is nothing to show.
      await settleHistory()
      const [state, settings] = await Promise.all([
        db.get('suggestionState', pieceId),
        db.get('settings', SETTINGS_KEY).then(normalizeSettings),
      ])
      if (!settings.suggestions.enabled || state?.disabled) {
        // A piece whose package is missing has always returned the ordinary empty result.
        const exists = (await db.getKey('packages', piece.scoreVersionId)) !== undefined
        return { ...none, disabled: exists }
      }
      if (!state?.suggestions.some((s) => s.context.scoreVersionId === piece.scoreVersionId)) return none
      const [pkg, pieceHistory] = await Promise.all([getPackage(db, piece.scoreVersionId), history.getHistory(pieceId)])
      if (!pkg) return none
      const handsId = handAssignmentId(pkg.model.hands)
      const tempo = hasTempo(pkg.model.tempo)
        ? pkg.model.tempo
        : piece.userTempo
          ? userTempoMap(piece.userTempo.beatBpm, piece.userTempo.beatUnit)
          : null
      return selectSuggestions(pieceHistory, pkg.model.occurrences, {
        scoreVersionId: piece.scoreVersionId,
        handsId,
        ...(tempo ? { tempoMapId: tempoMapId(tempo) } : {}),
        enabled: settings.suggestions.enabled,
        ...(dismissed ? { dismissed } : {}),
      })
    },
    async loadResults(pieceId) {
      const piece = await getPiece(db, pieceId)
      if (!piece) return []
      await settleHistory()
      return summarizeByContext(await listAttempts(db, { pieceId, scoreVersionId: piece.scoreVersionId }))
    },
    setSuggestionsDisabled: (pieceId, disabled) => history.setSuggestionsDisabled(pieceId, disabled),
    clearPracticeHistory: (pieceId, clearOptions) => history.clearHistory(pieceId, clearOptions),

    listRecordings: () => listTakes(db),
    getRecordingFiles: (id) => readTakeFiles(db, id),
    async saveRecording(info, files) {
      // WebKit can capture and play a Blob in a session that rejects storing Blobs in IndexedDB,
      // so the audio is stored as ArrayBuffer blocks read from the Blob one at a time.
      await writeTake(
        db,
        {
          info,
          midi: await files.midi.arrayBuffer(),
          type: files.audio.type || RECORDING_AUDIO_TYPE,
          audio: blobBlocks(files.audio),
          bytes: files.audio.size,
        },
        now,
      )
    },
    getRecordingMidi: (id) => readTakeMidi(db, id),
    discardRecordings: (ids) => markTakes(db, ids, now()),
    restoreRecordings: (ids) => markTakes(db, ids, null),
    async removeDiscardedRecordings(ids) {
      for (const id of ids) await removeDiscarded(db, id)
    },
    recordingsSummary: () => summarizeTakes(db),
    getLayout: (key) => layouts.get(key),
    putLayout: (key, scoreVersionId, value, approxBytes) => layouts.put(key, scoreVersionId, value, approxBytes),
    clearLayouts: (scoreVersionId) => layouts.clear(scoreVersionId),
    layoutCacheStats: () => layouts.stats(),

    async exportAll(exportOptions = {}) {
      await settleHistory()
      // The zip layer is a separate chunk, fetched only when the player exports or restores.
      const { exportBackup } = await import('./backup')
      return exportBackup(db, {
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.now ? { now: options.now() } : {}),
        ...(exportOptions.includeRecordings !== undefined
          ? { includeRecordings: exportOptions.includeRecordings }
          : {}),
      })
    },
    async restore(source, restoreOptions = {}) {
      await settleHistory()
      const { restoreBackup } = await import('./backup')
      try {
        return await restoreBackup(db, source, { now, ...restoreOptions })
      } finally {
        history.forget()
      }
    },
  }
}

/** Delete a database (tests, "reset everything"). Close any open storage on it first. */
export function deleteStorage(name: string = DEFAULT_DB_NAME): Promise<void> {
  return deleteDB(name)
}
