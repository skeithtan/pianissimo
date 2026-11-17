/**
 * Throttled piece updates (last speed, hands, passage, resume position, repeat target, speed
 * ladder). The session saves the learner's own changes, pause, seek and hide `immediate`ly and
 * debounces everything else (the ladder's speed step, the periodic resume position); nothing is
 * written from the MIDI input path (spec "Persist history in asynchronous batches outside the
 * input handler"). Immediate saves are cheap: at most one write is in flight and everything saved
 * meanwhile merges into the single write that follows it, so `flush()` resolves only once all
 * that was saved before it is written.
 */
import type { TimerApi } from '../../core/playback'
import type { PiecePatch, PieceSink } from './types'

export interface PieceSaver extends PieceSink {
  /** Write anything pending now (leaving the view, page hide). */
  flush(): Promise<void>
  dispose(): void
}

export const PIECE_SAVE_DEBOUNCE_MS = 1000

export function createPieceSaver(
  write: (patch: PiecePatch) => Promise<unknown>,
  timers: TimerApi,
  debounceMs = PIECE_SAVE_DEBOUNCE_MS,
): PieceSaver {
  let pending: PiecePatch | null = null
  let handle: unknown = null
  let inFlight: Promise<void> | null = null
  let disposed = false

  // Writes `pending` until nothing is left. Patches saved during a write merge into one following
  // write, so an immediate save never queues more than one write behind the one in flight.
  const drain = async (): Promise<void> => {
    // Always suspend first: `run` stores this promise in `inFlight` before any of the body (so
    // before the `finally`) runs, even when `write` throws synchronously or returns at once.
    await Promise.resolve()
    try {
      while (pending) {
        const patch = pending
        pending = null
        try {
          await write(patch)
        } catch {
          // A failed write is dropped; the next save carries its own fields.
        }
      }
    } finally {
      // The same synchronous step as the loop's last check: no save can fall between them.
      inFlight = null
    }
  }

  const run = (): Promise<void> => {
    if (handle !== null) timers.clearTimeout(handle)
    handle = null
    if (inFlight) return inFlight
    if (!pending) return Promise.resolve()
    // `drain` suspends at its first line, so its `finally` clears this only after the assignment.
    inFlight = drain()
    return inFlight
  }

  return {
    save(patch, immediate = false) {
      if (disposed) return
      pending = { ...(pending ?? {}), ...patch }
      if (immediate) {
        void run()
        return
      }
      if (handle === null) handle = timers.setTimeout(() => void run(), debounceMs)
    },
    flush: run,
    dispose() {
      void run()
      disposed = true
    },
  }
}
