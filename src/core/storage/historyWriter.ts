import { ingestAbandon, ingestAttempt } from '../history/ingest'
import type { BarRecord, HistoryChanges, IngestResult, PieceHistory } from '../history/types'
import { barKey } from '../history/types'
import type { AbandonEvent, AttemptRecord } from '../model/practice'
import { clearPieceHistory, commitHistory, loadPieceHistory, setPieceSuggestionsDisabled } from './historyStore'
import type { ClearOptions, HistoryUpdate } from './historyStore'
import type { Db } from './schema'

/** Schedules `run` for later and returns a function that cancels it. */
export type Schedule = (run: () => void) => () => void

/** Longest an idle callback may be postponed, and the fallback delay where there is none (Safari). */
export const IDLE_TIMEOUT_MS = 2_000
export const FALLBACK_DELAY_MS = 500
/** A batch that keeps failing is dropped after this many attempts so one bad record cannot wedge the queue. */
export const MAX_FLUSH_FAILURES = 3

interface IdleHost {
  requestIdleCallback?: (run: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

/** Idle callback with a timeout where available, a short timer otherwise. */
export const defaultSchedule: Schedule = (run) => {
  const host = globalThis as unknown as IdleHost
  if (typeof host.requestIdleCallback === 'function') {
    const handle = host.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS })
    return () => host.cancelIdleCallback?.(handle)
  }
  const handle = setTimeout(run, FALLBACK_DELAY_MS)
  return () => clearTimeout(handle)
}

export interface FlushReport {
  readonly attempts: number
  readonly abandons: number
  /** Pieces whose suggestion list changed, so the UI can refresh its suggestions. */
  readonly suggestionsChanged: readonly string[]
  /** Pieces whose measure histories changed. */
  readonly pieces: readonly string[]
}

export interface HistoryWriterOptions {
  readonly schedule?: Schedule
  /**
   * Keep ordinary-reading attempt records. Their traversals always feed the measure histories;
   * the records themselves are only needed for diagnostics, so they are dropped by default.
   */
  readonly keepReadingAttempts?: boolean
  readonly onFlush?: (report: FlushReport) => void
  /**
   * Called with the failure of a background flush; the batch is retried until `MAX_FLUSH_FAILURES`.
   * `droppedItems` is 0 while the batch is kept for a retry, and the number of records lost when
   * the batch (or one malformed record) is dropped, so the app can tell the player.
   */
  readonly onError?: (error: unknown, droppedItems: number) => void
}

type QueueItem =
  | { readonly kind: 'attempt'; readonly attempt: AttemptRecord }
  | { readonly kind: 'abandon'; readonly event: AbandonEvent }

interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface LifecycleTargets {
  readonly window?: EventTargetLike | undefined
  readonly document?: (EventTargetLike & { readonly visibilityState?: string }) | undefined
}

const NO_REPORT: FlushReport = { attempts: 0, abandons: 0, suggestionsChanged: [], pieces: [] }

/**
 * Batches practice records off the input path (spec "Execution and rendering architecture":
 * persist history in asynchronous batches outside the input handler).
 *
 * `queueAttempt` and `queueAbandon` only push onto an array and arm a timer, so they are safe
 * to call anywhere. The actual work happens in `flush`: ingest into the in-memory history of
 * each affected piece (suggestion detection and recovery, `core/history`), then write attempts
 * and the changed history records in one transaction. Flushes run when the browser is idle,
 * on `pagehide` and when the page becomes hidden, and on demand. A failed flush keeps its
 * items for the next one.
 *
 * Histories are cached per piece after the first load; this assumes one writer per database
 * (use `forget` after anything else changes the history stores).
 */
export class HistoryWriter {
  readonly #db: Db
  readonly #schedule: Schedule
  readonly #options: HistoryWriterOptions
  readonly #queue: QueueItem[] = []
  readonly #cache = new Map<string, PieceHistory>()
  readonly #listeners = new Set<(report: FlushReport) => void>()
  #cancelTimer: (() => void) | null = null
  #chain: Promise<unknown> = Promise.resolve()
  #failures = 0
  #disposers: Array<() => void> = []

  constructor(db: Db, options: HistoryWriterOptions = {}) {
    this.#db = db
    this.#options = options
    this.#schedule = options.schedule ?? defaultSchedule
    if (options.onFlush) this.#listeners.add(options.onFlush)
  }

  /** Items waiting to be written. */
  get pending(): number {
    return this.#queue.length
  }

  queueAttempt(attempt: AttemptRecord): void {
    this.#queue.push({ kind: 'attempt', attempt })
    this.#arm()
  }

  queueAbandon(event: AbandonEvent): void {
    this.#queue.push({ kind: 'abandon', event })
    this.#arm()
  }

  /** Called after every flush that wrote something. Returns an unsubscribe function. */
  subscribe(listener: (report: FlushReport) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Write everything queued so far. Resolves once it is stored; rejects if storage refused
   * (the items stay queued for a retry).
   */
  flush(): Promise<FlushReport> {
    this.#disarm()
    const run = this.#chain.then(() => this.#drain())
    this.#chain = run.catch(() => undefined)
    return run
  }

  /**
   * The up-to-date history of a piece, including everything queued so far, for building
   * suggestions between attempts. Never rejects: a failed flush is reported via `onError`
   * and the last stored state is returned.
   */
  async getHistory(pieceId: string): Promise<PieceHistory> {
    await this.flush().catch(() => undefined)
    return this.#history(pieceId)
  }

  /** Drop queued items of a piece that is being deleted; they would only recreate its records. */
  discard(pieceId: string): void {
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const item = this.#queue[i]
      if (item && (item.kind === 'attempt' ? item.attempt.pieceId : item.event.pieceId) === pieceId) {
        this.#queue.splice(i, 1)
      }
    }
  }

  /** Drop cached histories (all, or one piece) after the stores changed behind the writer's back. */
  forget(pieceId?: string): void {
    if (pieceId === undefined) this.#cache.clear()
    else this.#cache.delete(pieceId)
  }

  /** Persist the per-piece "disable suggestions" switch (evidence keeps being recorded). */
  async setSuggestionsDisabled(pieceId: string, disabled: boolean): Promise<void> {
    await this.flush().catch(() => undefined)
    await setPieceSuggestionsDisabled(this.#db, pieceId, disabled)
    this.forget(pieceId)
  }

  /** "Clear the piece's practice history": see `clearPieceHistory`. Queued records are written first. */
  async clearHistory(pieceId: string, options: ClearOptions = {}): Promise<void> {
    await this.flush().catch(() => undefined)
    await clearPieceHistory(this.#db, pieceId, options)
    this.forget(pieceId)
  }

  /**
   * Flush when the page is being hidden or closed: `pagehide`, and `visibilitychange` to
   * hidden (the reliable signals on iPadOS). Returns a function that detaches the listeners.
   */
  attachLifecycle(targets: LifecycleTargets = defaultTargets()): () => void {
    const onHide = (): void => {
      void this.flush().catch(() => undefined)
    }
    const onVisibility = (): void => {
      if (targets.document?.visibilityState === 'hidden') onHide()
    }
    targets.window?.addEventListener('pagehide', onHide)
    targets.document?.addEventListener('visibilitychange', onVisibility)
    const detach = (): void => {
      targets.window?.removeEventListener('pagehide', onHide)
      targets.document?.removeEventListener('visibilitychange', onVisibility)
    }
    this.#disposers.push(detach)
    return detach
  }

  /** Detach lifecycle listeners and write what is left. */
  async dispose(): Promise<void> {
    for (const detach of this.#disposers.splice(0)) detach()
    this.#disarm()
    await this.flush().catch(() => undefined)
  }

  #arm(): void {
    if (this.#cancelTimer) return
    this.#cancelTimer = this.#schedule(() => {
      this.#cancelTimer = null
      this.flush().catch(() => undefined)
    })
  }

  #disarm(): void {
    this.#cancelTimer?.()
    this.#cancelTimer = null
  }

  async #history(pieceId: string): Promise<PieceHistory> {
    const cached = this.#cache.get(pieceId)
    if (cached) return cached
    const loaded = await loadPieceHistory(this.#db, pieceId)
    this.#cache.set(pieceId, loaded)
    return loaded
  }

  async #drain(): Promise<FlushReport> {
    const items = this.#queue.splice(0)
    if (items.length === 0) return NO_REPORT
    try {
      const prepared = await this.#prepare(items)
      await commitHistory(this.#db, prepared.batch)
      for (const update of prepared.batch.updates) this.#cache.set(update.history.pieceId, update.history)
      this.#failures = 0
      for (const listener of this.#listeners) listener(prepared.report)
      return prepared.report
    } catch (error) {
      this.#failures += 1
      if (this.#failures >= MAX_FLUSH_FAILURES) {
        this.#failures = 0
        this.#options.onError?.(error, items.length)
      } else {
        this.#queue.unshift(...items)
        this.#options.onError?.(error, 0)
        this.#arm()
      }
      throw error
    }
  }

  async #prepare(items: readonly QueueItem[]): Promise<{
    batch: { attempts: AttemptRecord[]; updates: HistoryUpdate[] }
    report: FlushReport
  }> {
    const byPiece = new Map<string, QueueItem[]>()
    for (const item of items) {
      const pieceId = item.kind === 'attempt' ? item.attempt.pieceId : item.event.pieceId
      const list = byPiece.get(pieceId)
      if (list) list.push(item)
      else byPiece.set(pieceId, [item])
    }

    const attempts: AttemptRecord[] = []
    const updates: HistoryUpdate[] = []
    const suggestionsChanged: string[] = []
    let attemptCount = 0
    let abandonCount = 0
    for (const [pieceId, list] of byPiece) {
      let history = await this.#history(pieceId)
      const bars = new Map<string, BarRecord>()
      const abandonKeys = new Set<string>()
      let suggestions = false
      for (const item of list) {
        let result: IngestResult
        try {
          result =
            item.kind === 'attempt'
              ? ingestAttempt(history, item.attempt, item.attempt.createdAt)
              : ingestAbandon(history, item.event, item.event.at)
        } catch (error) {
          // A malformed record is dropped on its own; it must not take the rest of the batch with it.
          this.#options.onError?.(error, 1)
          continue
        }
        history = result.history
        for (const bar of result.changes.bars) bars.set(barKey(bar.measureContextKey, bar.occ), bar)
        for (const key of result.changes.abandonKeys) abandonKeys.add(key)
        suggestions ||= result.changes.suggestionsChanged
        if (item.kind === 'attempt') {
          attemptCount += 1
          if (this.#keeps(item.attempt)) attempts.push(item.attempt)
        } else {
          abandonCount += 1
        }
      }
      const changes: HistoryChanges = {
        bars: [...bars.values()],
        suggestionsChanged: suggestions,
        abandonKeys: [...abandonKeys],
      }
      updates.push({ history, changes })
      if (suggestions) suggestionsChanged.push(pieceId)
    }
    return {
      batch: { attempts, updates },
      report: { attempts: attemptCount, abandons: abandonCount, suggestionsChanged, pieces: [...byPiece.keys()] },
    }
  }

  /** Preview records no result, and reading attempts are optional diagnostics. */
  #keeps(attempt: AttemptRecord): boolean {
    if (attempt.context.hands === 'none') return false
    return attempt.kind === 'scored' || this.#options.keepReadingAttempts === true
  }
}

function defaultTargets(): LifecycleTargets {
  const host = globalThis as unknown as LifecycleTargets
  return { window: host.window, document: host.document }
}
