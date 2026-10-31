/**
 * Motion helpers shared by every view. Durations and easings also exist as CSS tokens
 * (`--dur-*`, `--ease-*` in global.css); these mirror them for inline styles and timers.
 */

/** Spec default for label and hint fades ("Offer ... a proposed default of 300 ms"). */
export const HINT_FADE_MS = 300

/** Reduced-motion users keep the fade (it conveys state) but it is short and carries no movement. */
export const REDUCED_FADE_MS = 90

/** True when the user asked the system to minimize motion. Safe where `matchMedia` is missing. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** A fade of `ms` shortened, never removed, under reduced motion. */
export function fadeDuration(ms: number, reduced: boolean = prefersReducedMotion()): number {
  return reduced ? Math.min(ms, REDUCED_FADE_MS) : ms
}
