import type { TimingDirection } from '../../core/model/practice'

/** The near-beat window for feedback, also usable with the tightest scoring tolerance. */
export function timingFeedbackThreshold(toleranceMs: number): number {
  return Math.min(30, toleranceMs / 2)
}

/** Three consecutive onset groups show drift; two close to the beat clear the cue. */
export class TimingDrift {
  #older: number | null = null
  #previous: number | null = null
  direction: TimingDirection | null = null

  observe(offsetMs: number, toleranceMs: number): void {
    const older = this.#older
    const previous = this.#previous
    this.#older = previous
    this.#previous = offsetMs
    if (previous === null) return

    const threshold = timingFeedbackThreshold(toleranceMs)
    if (Math.abs(previous) <= threshold && Math.abs(offsetMs) <= threshold) {
      this.direction = null
    } else if (older !== null) {
      if (previous < -threshold && older > previous && previous > offsetMs && older - offsetMs >= threshold) {
        this.direction = 'rushing'
      } else if (previous > threshold && older < previous && previous < offsetMs && offsetMs - older >= threshold) {
        this.direction = 'dragging'
      }
    }
  }

  reset(): void {
    this.#older = null
    this.#previous = null
    this.direction = null
  }
}
