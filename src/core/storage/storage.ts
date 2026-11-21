import type { RecordingInfo, RecordingFiles } from '../recording/records'
import { runTx } from './tx'
import { deleteDB } from 'idb'
import { summarizeByContext } from '../history/results'
import type { ContextResults } from '../history/results'
import { selectSuggestions } from '../history/selection'
import type { SuggestionSelection } from '../history/selection'
import type { PieceHistory } from '../history/types'
import type { AttemptRecord } from '../model/practice'
import type { ScorePackage, SourceFileRecord } from '../model/score'
import type { AppSettings } from '../model/settings'
import { addAttempts, getAttempt, listAttempts } from './attempts'
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
import { DEFAULT_DB_NAME, SETTINGS_KEY, openPianissimoDb } from './schema'
import { normalizeSettings } from './settings'
import type { ClearOptions } from './historyStore'
import { initializeLibrary, needsInitialPieces, needsLibraryExpansion } from './initialLibrary'

export interface StorageOptions {
  /** Recorded in exported backups. */
  readonly appVersion?: string
  readonly layoutCache?: Partial<LayoutCacheLimits>
  readonly history?: HistoryWriterOptions
  readonly now?: () => number
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

  listRecordings(): Promise<RecordingInfo[]>
  getRecordingFiles(id: string): Promise<RecordingFiles | undefined>
  saveRecording(info: RecordingInfo, files: RecordingFiles): Promise<void>
  deleteRecording(id: string): Promise<void>

  // Results
  addAttempts(records: readonly AttemptRecord[]): Promise<void>
  listAttempts(query: AttemptQuery): Promise<AttemptRecord[]>
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
  exportAll(): Promise<Uint8Array>
  restore(bytes: Uint8Array, options?: RestoreOptions): Promise<RestoreReport>
}

/** Open (creating on first use) the IndexedDB database `name`. */
export async function openStorage(
  name: string = DEFAULT_DB_NAME,
  options: StorageOptions = {},
): Promise<PianissimoStorage> {
  const db = await openPianissimoDb(name)
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
      return selectSuggestions(pieceHistory, pkg.model.occurrences, {
        scoreVersionId: piece.scoreVersionId,
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

    listRecordings: () => db.getAll('recordings'),
    async getRecordingFiles(id) {
      const files = await db.get('recordingFiles', id)
      if (!files) return undefined
      return {
        midi: new Blob([files.midi], { type: 'audio/midi' }),
        audio: new Blob(files.audio, { type: 'audio/wav' }),
      }
    },
    async saveRecording(info, files) {
      // WebKit can capture and play a Blob in a session that rejects storing Blobs in IndexedDB.
      // Read binary blocks before opening the transaction so the transaction cannot auto-commit.
      const midi = await files.midi.arrayBuffer()
      const audio: ArrayBuffer[] = []
      const blockSize = 4 * 1024 * 1024
      for (let offset = 0; offset < files.audio.size; offset += blockSize) {
        audio.push(await files.audio.slice(offset, offset + blockSize).arrayBuffer())
      }
      const tx = db.transaction(['recordings', 'recordingFiles'], 'readwrite')
      await runTx(tx, async () => {
        await tx.objectStore('recordings').put(info)
        await tx.objectStore('recordingFiles').put({ midi, audio }, info.id)
      })
    },
    async deleteRecording(id) {
      const tx = db.transaction(['recordings', 'recordingFiles'], 'readwrite')
      await runTx(tx, async () => {
        await tx.objectStore('recordings').delete(id)
        await tx.objectStore('recordingFiles').delete(id)
      })
    },
    getLayout: (key) => layouts.get(key),
    putLayout: (key, scoreVersionId, value, approxBytes) => layouts.put(key, scoreVersionId, value, approxBytes),
    clearLayouts: (scoreVersionId) => layouts.clear(scoreVersionId),
    layoutCacheStats: () => layouts.stats(),

    async exportAll() {
      await settleHistory()
      // The zip layer is a separate chunk, fetched only when the player exports or restores.
      const { exportBackup } = await import('./backup')
      return exportBackup(db, {
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.now ? { now: options.now() } : {}),
      })
    },
    async restore(bytes, restoreOptions) {
      await settleHistory()
      const { restoreBackup } = await import('./backup')
      try {
        return await restoreBackup(db, bytes, restoreOptions)
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
