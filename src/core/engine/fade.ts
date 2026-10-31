/**
 * Label fade curve shared by the engine (temporary hints), the renderer (persistent labels)
 * and the keyboard guide (hiding uses the same transition). Spec: labels "disappear through a
 * smooth opacity fade, not abrupt removal"; proposed duration 300 ms.
 */

/** Smoothstep ease-in-out: 0 → 0, 1 → 1, zero slope at both ends. Input is clamped to [0, 1]. */
export function easeInOut(progress: number): number {
  if (!(progress > 0)) return 0
  if (progress >= 1) return 1
  return progress * progress * (3 - 2 * progress)
}

/**
 * Opacity of a label `elapsedMs` into a fade-out lasting `durationMs`: exactly 1 before the
 * fade starts, exactly 0 from its end on (also for a zero-length fade), eased in between.
 * Pass active-time milliseconds so an ordinary-reading pause freezes the transition.
 */
export function fadeOutOpacity(elapsedMs: number, durationMs: number): number {
  if (elapsedMs >= durationMs) return 0
  if (elapsedMs <= 0) return 1
  return 1 - easeInOut(elapsedMs / durationMs)
}
