/** A take is long when it reaches 20 minutes: the recorder says so once. */
export const TAKE_WARNING_MS = 20 * 60_000
/** A take stops by itself at 60 minutes (about 690 MB of 48 kHz stereo audio) and is saved. */
export const TAKE_LIMIT_MS = 60 * 60_000
/** How often the recorder looks at the elapsed time (the timer shows whole seconds). */
export const TAKE_CLOCK_MS = 500

export interface TakeClockEvents {
  /** Whole seconds since the take started. */
  tick(seconds: number): void
  /** The take reached `TAKE_WARNING_MS` (once). */
  warn(): void
  /** The take reached `TAKE_LIMIT_MS` (once): stop it as Stop would. Nothing fires afterward. */
  limit(): void
}

/**
 * Follow a take's elapsed time by polling a clock, never per MIDI event. `now` and `every`
 * (a repeating timer that returns its cancel function) are injected. Returns a stop function.
 */
export function startTakeClock(
  now: () => number,
  every: (run: () => void, ms: number) => () => void,
  events: TakeClockEvents,
): () => void {
  const start = now()
  let warned = false
  let done = false
  const cancel = every(() => {
    if (done) return
    const elapsed = now() - start
    events.tick(Math.floor(elapsed / 1000))
    if (!warned && elapsed >= TAKE_WARNING_MS) {
      warned = true
      events.warn()
    }
    if (elapsed >= TAKE_LIMIT_MS) {
      done = true
      cancel()
      events.limit()
    }
  }, TAKE_CLOCK_MS)
  return () => {
    done = true
    cancel()
  }
}
