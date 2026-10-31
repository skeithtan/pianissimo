/**
 * The app's single AudioContext (spec "Execution and rendering architecture": one
 * AudioContext for the explicit browser-audio alternative, scheduled against currentTime).
 * Created lazily on first use, which must follow a user gesture (autoplay policies); shared by
 * browser sound and the metronome click. Loading this module creates nothing.
 */

let shared: AudioContext | null = null

/** True when the browser offers Web Audio. */
export function isWebAudioSupported(): boolean {
  return typeof globalThis.AudioContext === 'function'
}

/**
 * Get (or create) the shared context and resume it. Call from a user gesture handler the
 * first time. `create` is injectable for tests.
 */
export function sharedAudioContext(
  create: () => AudioContext = () => new AudioContext({ latencyHint: 'interactive' }),
): AudioContext {
  if (!shared || shared.state === 'closed') shared = create()
  if (shared.state === 'suspended') void shared.resume().catch(() => undefined)
  return shared
}

/** The shared context if one was created, without creating it. */
export function existingAudioContext(): AudioContext | null {
  return shared
}

/** Test hook: forget the shared context. */
export function resetSharedAudioContext(): void {
  shared = null
}

/**
 * Convert a performance.now()-timebase time (ms) to context seconds. Uses the output
 * timestamp when available so sound is heard at `time`; never returns a time in the past.
 */
export function contextTimeFor(ctx: BaseAudioContext, now: number, time: number): number {
  const withTs = ctx as BaseAudioContext & { getOutputTimestamp?: () => AudioTimestamp }
  const ts = typeof withTs.getOutputTimestamp === 'function' ? withTs.getOutputTimestamp() : undefined
  if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
    return Math.max(ctx.currentTime, ts.contextTime + (time - ts.performanceTime) / 1000)
  }
  return ctx.currentTime + Math.max(0, time - now) / 1000
}
