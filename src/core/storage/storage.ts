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
      const [pkg, settings, pieceHistory] = await Promise.all([
        getPackage(db, piece.scoreVersionId),
        db.get('settings', SETTINGS_KEY).then(normalizeSettings),
        history.getHistory(pieceId),
      ])
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
