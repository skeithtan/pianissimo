/**
 * Online time warping against a reference feature sequence (spike, DECISIONS P14), in the
 * spirit of Arzt and Widmer's windowed OLTW: one accumulated-cost row per live frame, computed
 * only inside a bounded window of reference frames around the current best match, so each live
 * frame costs O(window × FEATURE_DIM) whatever the length of the piece.
 *
 * Recursion per live frame t and reference frame j (local cost c = 1 − the dot product of the
 * two feature vectors: a weighted sum of the LSE and onset cosines, see `features.ts`):
 *
 *   D(t, j) = c(t, j) + λ · min(D(t−1, j−1), D(t−1, j) + p, D(t−1, j−2) + p)
 *
 * Each live frame advances the reference by 0, 1 or 2 frames (tempo 0–2× the reference), every
 * path to row t has exactly t steps (rows are comparable without length normalization), `p` is
 * a small tempo prior for the non-diagonal steps and λ < 1 forgets old costs (a time constant of
 * about a second) so the match recovers after wrong notes. The current position is the argmin of
 * the row. A silent live frame while the best reference frame sounds holds the match (the player
 * stopped; the reference must not run on). Floats only: positions in reference frames.
 */
import { FEATURE_DIM, LSE_SHARE, SEMITONES } from './features'
import type { Reference } from './reference'

/** LSE presence value of a silent frame (sounding frames have less). */
const SILENT_PRESENCE = Math.sqrt(LSE_SHARE) - 1e-6

export interface OltwOptions {
  /** Reference frames kept behind the best match (default 100: 1 s). */
  readonly behind?: number
  /** Reference frames computed ahead of the best match (default 300: 3 s). */
  readonly ahead?: number
  /** Forgetting factor per frame (default 0.99). */
  readonly forget?: number
  /** Penalty of the hold and double steps (default 0.02). */
  readonly stepPenalty?: number
  /** Weight of the onset-strength difference in the local cost (default 0). */
  readonly onsetWeight?: number
  /** Smoothing of the confidence (default 0.1 per frame). */
  readonly confidenceRate?: number
}

export interface OltwResult {
  /** Best reference frame. */
  readonly frame: number
  /** 0..1: smoothed similarity of recent live frames to the matched reference frames. */
  readonly confidence: number
  /** True when this frame was held (silent live frame) rather than aligned. */
  readonly held: boolean
}

export class OnlineTimeWarping {
  readonly ref: Reference
  readonly #behind: number
  readonly #ahead: number
  readonly #forget: number
  readonly #pen: number
  readonly #onsetWeight: number
  readonly #rate: number
  #prev: Float64Array
  #cur: Float64Array
  #prevLo = 0
  #prevHi = 0
  #best = 0
  #confidence = 0
  #held = false

  constructor(ref: Reference, options: OltwOptions = {}) {
    this.ref = ref
    this.#behind = options.behind ?? 100
    this.#ahead = options.ahead ?? 300
    this.#forget = options.forget ?? 0.99
    this.#pen = options.stepPenalty ?? 0.02
    this.#onsetWeight = options.onsetWeight ?? 0
    this.#rate = options.confidenceRate ?? 0.1
    this.#prev = new Float64Array(ref.count)
    this.#cur = new Float64Array(ref.count)
    this.reset(0)
  }

  get frame(): number {
    return this.#best
  }

  /** The latest frame was held (silent live frame while the reference sounds). */
  get held(): boolean {
    return this.#held
  }

  get confidence(): number {
    return this.#confidence
  }

  /**
   * Restarts at reference frame `start`: the match may begin anywhere in the `spread` frames
   * up to it (the player may start a little early), with no confidence.
   */
  reset(start: number, spread = 0): void {
    const s = Math.min(this.ref.count - 1, Math.max(0, Math.round(start)))
    const lo = Math.max(0, s - Math.max(0, Math.round(spread)))
    for (let j = lo; j <= s; j++) this.#prev[j] = 0
    this.#prevLo = lo
    this.#prevHi = s + 1
    this.#best = s
    this.#confidence = 0
    this.#held = false
  }

  /** Aligns one live frame (feature vector, onset strength, gate). */
  step(lse: Float32Array, onset: number, silent: boolean): OltwResult {
    const ref = this.ref
    const frames = ref.frames
    if (silent && frames[this.#best * FEATURE_DIM + SEMITONES]! < SILENT_PRESENCE) {
      this.#confidence *= 1 - this.#rate
      this.#held = true
      return { frame: this.#best, confidence: this.#confidence, held: true }
    }
    const lo = Math.max(0, this.#best - this.#behind)
    const hi = Math.min(ref.count, this.#best + this.#ahead)
    const prev = this.#prev
    const cur = this.#cur
    const pLo = this.#prevLo
    const pHi = this.#prevHi
    const lam = this.#forget
    const pen = this.#pen
    const ow = this.#onsetWeight
    const liveOnset = ow > 0 ? Math.tanh(onset / 4) : 0
    const dim = FEATURE_DIM
    let best = -1
    let bestD = Infinity
    let bestC = 1
    for (let j = lo; j < hi; j++) {
      let m = j >= pLo && j < pHi ? prev[j]! + pen : Infinity
      if (j - 1 >= pLo && j - 1 < pHi && prev[j - 1]! < m) m = prev[j - 1]!
      if (j - 2 >= pLo && j - 2 < pHi && prev[j - 2]! + pen < m) m = prev[j - 2]! + pen
      if (m === Infinity) {
        cur[j] = Infinity
        continue
      }
      let dot = 0
      const row = j * dim
      for (let k = 0; k < dim; k++) dot += lse[k]! * frames[row + k]!
      let c = 1 - dot
      if (ow > 0) c = (1 - ow) * c + ow * Math.abs(liveOnset - Math.tanh(ref.onset[j]! / 4))
      const d = c + lam * m
      cur[j] = d
      if (d < bestD) {
        bestD = d
        best = j
        bestC = c
      }
    }
    this.#held = best < 0
    if (best < 0) return { frame: this.#best, confidence: this.#confidence, held: true }
    this.#prev = cur
    this.#cur = prev
    this.#prevLo = lo
    this.#prevHi = hi
    this.#best = best
    this.#confidence += this.#rate * (1 - bestC - this.#confidence)
    return { frame: best, confidence: this.#confidence, held: false }
  }
}
