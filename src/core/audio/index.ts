/**
 * Audio score follower (spike on branch `mic-follower-spike`, DECISIONS P14): estimates the
 * player's position in a score from microphone samples, for Play-through (P12) on an acoustic
 * piano. Pure and worker-safe: the caller (an AudioWorklet or worker) passes mono samples.
 * See README.md.
 */
import { type Rational, ZERO, rat, toNumber } from '../music/rational'
import type { TempoMapData } from '../music/tempo'
import type { ScoreModel } from '../model/score'
import type { Timeline } from '../engine/timeline'
import { FeatureExtractor, type FeatureOptions } from './features'
import { OnlineTimeWarping, type OltwOptions } from './oltw'
import { type Reference, type ReferenceNoteOptions, buildReference, frameAt, framePosition } from './reference'

export { FeatureExtractor, Fft, FEATURE_DIM, HOP_SEC, frameSize, hopSize } from './features'
export { OnlineTimeWarping } from './oltw'
export {
  buildReference,
  framePosition,
  frameAt,
  referenceNotes,
  sustainSpans,
  type Reference,
  type ReferenceNote,
} from './reference'

export interface AudioFollowerOptions extends FeatureOptions, OltwOptions, ReferenceNoteOptions {}

export interface AudioEstimate {
  /** Float performance position in whole notes. */
  readonly position: number
  /** 0..1; act on positions only above a threshold (about 0.5 on synthetic audio). */
  readonly confidence: number
  /** Stream time (seconds, the caller's clock) of the end of the latest analyzed frame. */
  readonly time: number
  /** Frames analyzed by this push. */
  readonly frames: number
}

export interface AudioFollower {
  /**
   * Feeds mono samples starting at stream time `time` (seconds). Any block size: a frame is
   * analyzed every 10 ms of audio. A different sample rate than before restarts the follower
   * at its current position.
   */
  push(samples: Float32Array, sampleRate: number, time: number): AudioEstimate
  /** Restarts at a performance position (default the start), e.g. after a seek. */
  reset(position?: Rational): void
}

/**
 * An audio follower for `model` at `tempo` × `multiplier`. The reference is built lazily for the
 * first sample rate seen (it bins partials like the live FFT does).
 */
export function createAudioFollower(
  model: ScoreModel,
  tempo: TempoMapData,
  multiplier: number,
  options: AudioFollowerOptions = {},
): AudioFollower {
  let ref: Reference | null = null
  let features: FeatureExtractor | null = null
  let oltw: OnlineTimeWarping | null = null
  let start: Rational = ZERO
  /** Samples pushed since the extractor started (frame i ends at sample (i + 1) × hop). */
  let pushed = 0
  let last: AudioEstimate = { position: toNumber(start), confidence: 0, time: 0, frames: 0 }

  const restart = (): void => {
    if (!ref || !oltw) return
    const j = frameAt(ref, start)
    // At the start the whole lead-in is a candidate; elsewhere the half second before.
    oltw.reset(j - 1, toNumber(start) === 0 ? j : 50)
    features?.reset()
    pushed = 0
  }

  return {
    push(samples, sampleRate, time) {
      if (!features || features.sampleRate !== sampleRate) {
        if (ref && oltw) start = rat(Math.round(framePosition(ref, oltw.frame) * 1e6), 1e6)
        ref = buildReference(model, tempo, multiplier, sampleRate, options)
        features = new FeatureExtractor(sampleRate, options)
        oltw = new OnlineTimeWarping(ref, options)
        restart()
      }
      const fx = features
      const tw = oltw!
      const blockStart = pushed
      pushed += samples.length
      let frames = 0
      let lastIndex = -1
      fx.push(samples, (frame, index) => {
        tw.step(frame.vector, frame.onset, frame.silent)
        frames++
        lastIndex = index
      })
      last =
        frames > 0
          ? {
              position: framePosition(ref!, tw.frame),
              confidence: tw.confidence,
              time: time + ((lastIndex + 1) * fx.hop - blockStart) / sampleRate,
              frames,
            }
          : { ...last, frames: 0 }
      return last
    },
    reset(position = ZERO) {
      start = position
      restart()
    },
  }
}

/**
 * Index of the last group of `timeline` at or before `position` (−1 before the first). A session
 * would call `PlayFollower.transportArrived` (or release gates) when it increases with enough
 * confidence; groups are compared in float whole notes with a 1e-6 tolerance.
 */
export function groupReached(timeline: Timeline, position: number): number {
  const gs = timeline.groups
  let lo = 0
  let hi = gs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (toNumber(gs[mid]!.position) <= position + 1e-6) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}
