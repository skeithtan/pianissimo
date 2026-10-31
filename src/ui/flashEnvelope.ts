/**
 * Pure intensity curve for the wrong-note "damage" flash (spec "Mistake feedback and hints":
 * about 300 ms of red feedback, and repeated errors extend the feedback instead of producing
 * rapid flashing).
 *
 * One envelope = attack (ease-out to peak) -> hold -> decay (ease-in to zero). A new hit during
 * an active flash starts its attack from the *current* intensity, never from zero, and moves the
 * decay later, so the flash can only ever stay high or fall, never strobe.
 *
 * A soft hit (a right pitch pressed too early) uses a gentler envelope peaking at
 * `SOFT_FLASH_PEAK` with a shorter decay. Full and soft hits run as two layers and the overlay
 * shows the larger, so a soft hit never raises a running full flash and a full hit always wins.
 */

export interface FlashTiming {
  /** Time to rise from zero to the peak. */
  readonly attackMs: number
  /** Time spent at the peak. */
  readonly holdMs: number
  /** Time to fall from the peak to zero. */
  readonly decayMs: number
}

/** About 320 ms in total for a single hit. */
export const FLASH_TIMING: FlashTiming = { attackMs: 50, holdMs: 20, decayMs: 250 }

/** Reduced motion: a plain short fade in and out. */
export const FLASH_TIMING_REDUCED: FlashTiming = { attackMs: 70, holdMs: 30, decayMs: 200 }

export interface FlashEnvelope {
  /** Clock time of the hit that started this envelope. */
  readonly start: number
  /** Intensity at `start` (non-zero when the hit landed on a flash still fading). */
  readonly from: number
  /** Intensity reached after the attack and held until the decay (1 for a full hit). */
  readonly peak: number
  readonly attackMs: number
  readonly holdMs: number
  readonly decayMs: number
}

const easeOut = (p: number): number => 1 - (1 - p) ** 3
const easeIn = (p: number): number => p * p

/** Intensity (0..1) of `envelope` at `now`; 0 when there is none or it has finished. */
export function intensityAt(envelope: FlashEnvelope | null, now: number): number {
  if (!envelope) return 0
  const t = now - envelope.start
  if (t < 0) return envelope.from
  const peak = envelope.peak
  if (t < envelope.attackMs) return envelope.from + (peak - envelope.from) * easeOut(t / envelope.attackMs)
  const afterAttack = t - envelope.attackMs
  if (afterAttack < envelope.holdMs) return peak
  const decayed = (afterAttack - envelope.holdMs) / envelope.decayMs
  return decayed >= 1 ? 0 : peak * (1 - easeIn(decayed))
}

/** Clock time at which the envelope reaches zero. */
export function envelopeEnd(envelope: FlashEnvelope): number {
  return envelope.start + envelope.attackMs + envelope.holdMs + envelope.decayMs
}

export function isActive(envelope: FlashEnvelope | null, now: number): boolean {
  return envelope !== null && now < envelopeEnd(envelope)
}

/**
 * The envelope after a wrong attack at `now`. The attack shortens in proportion to how much
 * of the rise to `peak` is already showing. `untilMs` (the engine's `wrongFeedbackUntil`)
 * stretches the hold so the flash never ends before the engine says the feedback does.
 */
export function hitEnvelope(
  previous: FlashEnvelope | null,
  now: number,
  timing: FlashTiming = FLASH_TIMING,
  untilMs?: number,
  peak = 1,
): FlashEnvelope {
  return envelopeFrom(intensityAt(previous, now), now, timing, untilMs, peak)
}

function envelopeFrom(
  from: number,
  now: number,
  timing: FlashTiming,
  untilMs: number | undefined,
  peak: number,
): FlashEnvelope {
  const top = Math.max(peak, from)
  const attackMs = top > 0 ? timing.attackMs * (1 - from / top) : 0
  const naturalEnd = now + attackMs + timing.holdMs + timing.decayMs
  const extraHold = untilMs !== undefined && untilMs > naturalEnd ? untilMs - naturalEnd : 0
  return { start: now, from, peak: top, attackMs, holdMs: timing.holdMs + extraHold, decayMs: timing.decayMs }
}

/** Peak of a soft hit, as a fraction of the full flash. */
export const SOFT_FLASH_PEAK = 0.35

/** A soft hit's timing: the same attack and hold, a shorter decay (80%). */
export function softTiming(timing: FlashTiming): FlashTiming {
  return { attackMs: timing.attackMs, holdMs: timing.holdMs, decayMs: Math.round(timing.decayMs * 0.8) }
}

export interface FlashHitOptions {
  /** A gentler hit (too-early press): peak `SOFT_FLASH_PEAK`, shorter decay, never above a full flash. */
  readonly soft?: boolean
}

/** The two flash layers; the overlay shows the larger of their intensities. */
export interface FlashState {
  readonly full: FlashEnvelope | null
  readonly soft: FlashEnvelope | null
}

export const NO_FLASH: FlashState = { full: null, soft: null }

export function flashIntensity(state: FlashState, now: number): number {
  return Math.max(intensityAt(state.full, now), intensityAt(state.soft, now))
}

export function flashActive(state: FlashState, now: number): boolean {
  return isActive(state.full, now) || isActive(state.soft, now)
}

/**
 * The flash after a hit at `now`. A full hit rises from the intensity currently showing (either
 * layer) to 1. A soft hit only re-raises the soft layer, so it never lifts a running full flash
 * above its current intensity.
 */
export function hitFlash(
  state: FlashState,
  now: number,
  timing: FlashTiming = FLASH_TIMING,
  untilMs?: number,
  options: FlashHitOptions = {},
): FlashState {
  if (options.soft) {
    return { full: state.full, soft: hitEnvelope(state.soft, now, softTiming(timing), untilMs, SOFT_FLASH_PEAK) }
  }
  return { full: envelopeFrom(flashIntensity(state, now), now, timing, untilMs, 1), soft: state.soft }
}
