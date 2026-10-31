/**
 * Imperative driver for the wrong-note flash: one short-lived rAF loop that writes the opacity of
 * the overlay straight to the DOM, so a wrong attack never causes a
 * Preact re-render. The loop stops itself when the envelope has finished.
 */
import {
  FLASH_TIMING,
  FLASH_TIMING_REDUCED,
  NO_FLASH,
  flashActive,
  flashIntensity,
  hitFlash,
  type FlashHitOptions,
  type FlashState,
} from './flashEnvelope'

export interface FlashDriverOptions {
  /** Element that is a full-viewport overlay; only its opacity is written. */
  readonly overlay: HTMLElement
  /** Monotonic clock in ms, same domain as the `now`/`until` passed to `hit`. */
  readonly now?: () => number
  readonly reducedMotion?: () => boolean
  readonly requestFrame?: (callback: () => void) => number
  readonly cancelFrame?: (handle: number) => void
}

export class FlashDriver {
  private readonly overlay: HTMLElement
  private readonly clock: () => number
  private readonly reduced: () => boolean
  private readonly requestFrame: (callback: () => void) => number
  private readonly cancelFrame: (handle: number) => void
  private state: FlashState = NO_FLASH
  private frame = 0

  constructor(options: FlashDriverOptions) {
    this.overlay = options.overlay
    this.clock = options.now ?? (() => performance.now())
    this.reduced =
      options.reducedMotion ??
      (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb))
    this.cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h))
  }

  /** Current overlay intensity, 0..1. */
  get intensity(): number {
    return flashIntensity(this.state, this.clock())
  }

  /**
   * A wrong attack happened. Starts the flash, or extends a running one from its current
   * intensity. `untilMs` is the engine's feedback deadline in the same clock. `soft` (a right
   * pitch pressed too early) uses the gentler envelope and never raises a running full flash.
   */
  hit(now: number = this.clock(), untilMs?: number, options?: FlashHitOptions): void {
    const reduced = this.reduced()
    this.state = hitFlash(this.state, now, reduced ? FLASH_TIMING_REDUCED : FLASH_TIMING, untilMs, options)
    this.write(now)
    if (this.frame === 0) this.frame = this.requestFrame(this.tick)
  }

  /** Remove the flash immediately (seek, restart, correct completion of the group). */
  clear(): void {
    this.state = NO_FLASH
    if (this.frame !== 0) this.cancelFrame(this.frame)
    this.frame = 0
    this.write(this.clock())
  }

  dispose(): void {
    this.clear()
  }

  private readonly tick = (): void => {
    this.frame = 0
    const now = this.clock()
    this.write(now)
    if (flashActive(this.state, now)) this.frame = this.requestFrame(this.tick)
    else this.state = NO_FLASH
  }

  private write(now: number): void {
    const value = flashIntensity(this.state, now)
    this.overlay.style.opacity = value === 0 ? '0' : value.toFixed(3)
  }
}
