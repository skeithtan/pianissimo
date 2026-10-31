/**
 * Throttled piece updates (last speed, hands, passage, resume position, repeat target). The
 * session saves on pause, seek and hide (`immediate`) and debounces everything else; nothing
 * is written from the MIDI input path (spec "Persist history in asynchronous batches outside
 * the input handler").
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
  let chain: Promise<unknown> = Promise.resolve()
  let disposed = false

  const run = (): Promise<void> => {
    if (handle !== null) timers.clearTimeout(handle)
    handle = null
    const patch = pending
    pending = null
    if (!patch) return chain.then(() => undefined)
    chain = chain.then(() => write(patch)).catch(() => undefined)
    return chain.then(() => undefined)
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
