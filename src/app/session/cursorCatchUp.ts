/**
 * Follow's drawn cursor (DECISIONS U162). The transport's musical time jumps to a note the player
 * reaches ahead of it (early, skipping, or several groups at once from the microphone). The jump is
 * kept as a distance the drawn cursor is behind, and a critically damped spring closes it: the
 * drawing starts and lands without a step, never overshoots, never goes back, and lags nothing while
 * the player keeps the written time. Display only; gates, sound and targets are never late.
 */

/** The spring's rate per second, near the strip's way back from browsing: 90% closed in 0.28 s. */
export const CATCH_UP_RATE = 14
/** Never drawn further behind than this (whole notes): a longer jump lands here, then glides on. */
export const CATCH_UP_MOST = 2
/** Closer than this (whole notes; far below a pixel) it has arrived. */
const ARRIVED = 1e-4

export class CursorCatchUp {
  #behind = 0
  /** Whole notes per second (never positive: the distance only closes). */
  #speed = 0
  #at = 0

  /** Musical time jumped `distance` whole notes ahead at `now` (ms). */
  jump(distance: number, now: number): void {
    const behind = this.behind(now)
    this.#speed = this.#speedAt(now)
    this.#behind = Math.min(behind + Math.max(0, distance), CATCH_UP_MOST)
    this.#at = now
  }

  /** How far behind musical time the cursor is drawn (whole notes); 0 once it has arrived. */
  behind(now: number): number {
    if (this.#behind === 0) return 0
    const t = Math.max(0, now - this.#at) / 1000
    const left = (this.#behind + this.#slope() * t) * Math.exp(-CATCH_UP_RATE * t)
    if (left >= ARRIVED) return left
    this.reset()
    return 0
  }

  /** The cursor is drawn at musical time at once (a seek). */
  reset(): void {
    this.#behind = this.#speed = 0
  }

  #slope(): number {
    return this.#speed + CATCH_UP_RATE * this.#behind
  }

  #speedAt(now: number): number {
    if (this.#behind === 0) return 0
    const t = Math.max(0, now - this.#at) / 1000
    return (this.#speed - CATCH_UP_RATE * this.#slope() * t) * Math.exp(-CATCH_UP_RATE * t)
  }
}
