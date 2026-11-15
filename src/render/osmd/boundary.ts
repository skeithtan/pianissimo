/** Longest wait for a frame before a stage boundary goes on without one (a hidden tab gets none). */
export const FRAME_WAIT_MS = 100

/**
 * A real yield between engraving stages: pending input, a frame (and the session's frame work
 * before it) and due timers run before the next stage starts. A bare `setTimeout(0)` let the next
 * stage start first, so a cancel triggered by the learner's input arrived a stage late. Resolves
 * one macrotask after the next animation frame, or after `FRAME_WAIT_MS` when no frame comes.
 */
export function stageBoundary(frameWaitMs = FRAME_WAIT_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const go = (): void => {
      if (done) return
      done = true
      clearTimeout(fallback)
      setTimeout(resolve, 0)
    }
    const fallback = setTimeout(go, frameWaitMs)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go)
  })
}
