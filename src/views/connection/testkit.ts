/** Test helpers for the Connection view. */
import type { EchoClock } from './PlaybackStep'

/** A clock whose timers fire only when the test says so (the test notes' listening window). */
export function manualClock(): EchoClock & { fire(): void } {
  const timers: (() => void)[] = []
  return {
    now: () => performance.now(),
    setTimeout: (fn) => {
      timers.push(fn)
      return timers.length
    },
    fire: () => {
      for (const fn of timers.splice(0)) fn()
    },
  }
}
