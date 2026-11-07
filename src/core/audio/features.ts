/**
 * Audio features for score following (spike, DECISIONS P14): one feature vector per ~46 ms
 * frame with a 10 ms hop. Pure and worker-safe (no DOM, no Web Audio): the caller feeds raw mono
 * samples.
 *
 * The vector has two halves, each L2-normalized and then weighted (the weights' squares sum to
 * 1, so the dot product of two vectors is a weighted sum of two cosines):
 *
 * - **LSE**, the log-spectral energy: Hann-windowed power spectrum (in-repo radix-2 FFT) summed
 *   into one bin per semitone of the piano range (MIDI 21–108), compressed as
 *   log(1 + γ·E/Emax) relative to the frame's loudest semitone, plus a constant presence value.
 * - **Onset**: the half-wave rectified frame-to-frame rise of log(1 + γ·E/peak) per semitone
 *   (peak = the stream's running loudest frame), plus a constant "steady" value. Sustained or
 *   pedaled notes rise nowhere, so this half tells attacks apart where the LSE cannot (repeated
 *   chords, notes ringing on under the pedal), as in Dixon's onset-sensitive feature.
 *
 * A frame below the gate is silence: its LSE half is the presence value alone. Live frames and
 * reference frames go through the same `FrameEncoder`.
 */

export const PIANO_LOW = 21
export const PIANO_HIGH = 108
export const SEMITONES = PIANO_HIGH - PIANO_LOW + 1
/** Length of each half: one value per semitone plus its constant (last). */
export const HALF_DIM = SEMITONES + 1
/** Feature length: LSE half then onset half. */
export const FEATURE_DIM = 2 * HALF_DIM
export const HOP_SEC = 0.01
export const FRAME_SEC = 0.046
/** Log compression strength. */
export const LOG_GAMMA = 1000
/** Presence value of a sounding frame's LSE half before normalization (silence is presence only). */
export const PRESENCE = 0.5
/** Steady value of the onset half before normalization (no rise is steady only). */
export const STEADY = 0.5
/**
 * Share of the LSE half in the dot product (the onset half has the rest). 0.8 after sweeping
 * 0.3–1.0 on synthetic performances: more onset weight loses the pedaled reference piece,
 * pure LSE loses mistake recovery and repeated chords (DECISIONS P14).
 */
export const LSE_SHARE = 0.8
/** Relative gate: a frame this far below the running peak is silence (−45 dB). */
export const GATE_RELATIVE = 10 ** -4.5
/** Running-peak decay per frame (about 20 dB per second). */
export const PEAK_DECAY = 0.955

/** Power-of-two frame length nearest to FRAME_SEC (2048 at 44.1 and 48 kHz). */
export function frameSize(sampleRate: number): number {
  return 2 ** Math.round(Math.log2(sampleRate * FRAME_SEC))
}

/** Hop in samples (441 at 44.1 kHz, 480 at 48 kHz: exactly 10 ms). */
export function hopSize(sampleRate: number): number {
  return Math.round(sampleRate * HOP_SEC)
}

/** Semitone bin (0-based from MIDI 21) of a frequency, or -1 outside the piano range. */
export function semitoneOfFrequency(freq: number): number {
  if (!(freq > 0)) return -1
  const p = Math.round(69 + 12 * Math.log2(freq / 440))
  return p >= PIANO_LOW && p <= PIANO_HIGH ? p - PIANO_LOW : -1
}

/** Semitone bin of each FFT bin 0..n/2 (-1 when outside the piano range). */
export function binToSemitone(sampleRate: number, n: number): Int16Array {
  const out = new Int16Array(n / 2 + 1)
  for (let k = 0; k <= n / 2; k++) out[k] = semitoneOfFrequency((k * sampleRate) / n)
  return out
}

/** In-place iterative radix-2 complex FFT (n a power of two). */
export class Fft {
  readonly n: number
  readonly #cos: Float64Array
  readonly #sin: Float64Array
  readonly #rev: Uint32Array

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new RangeError(`FFT size ${n} is not a power of two`)
    this.n = n
    this.#cos = new Float64Array(n / 2)
    this.#sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.#cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.#sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
    this.#rev = new Uint32Array(n)
    const bits = Math.log2(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.#rev[i] = r
    }
  }

  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n
    const rev = this.#rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]!
      if (j > i) {
        let t = re[i]!
        re[i] = re[j]!
        re[j] = t
        t = im[i]!
        im[i] = im[j]!
        im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.#cos[k * step]!
          const wi = this.#sin[k * step]!
          const a = start + k
          const b = a + half
          const xr = re[b]! * wr - im[b]! * wi
          const xi = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - xr
          im[b] = im[a]! - xi
          re[a] = re[a]! + xr
          im[a] = im[a]! + xi
        }
      }
    }
  }
}

/**
 * Turns a stream of semitone energies into feature vectors (stateful: the running peak of the
 * total semitone energy and the previous frame's log energies). Only ratios within one stream
 * matter, so live audio and the reference need no common loudness scale.
 */
export class FrameEncoder {
  readonly #prevLog = new Float64Array(SEMITONES)
  #peak = 0

  reset(): void {
    this.#prevLog.fill(0)
    this.#peak = 0
  }

  /**
   * Writes the feature into `out` (FEATURE_DIM) and returns the onset strength (sum of the
   * rises). `forceSilent` adds an outside gate (the live absolute floor).
   */
  encode(energy: ArrayLike<number>, forceSilent: boolean, out: Float32Array): FrameResult {
    const semis = SEMITONES
    let max = 0
    let total = 0
    for (let p = 0; p < semis; p++) {
      const e = energy[p]!
      total += e
      if (e > max) max = e
    }
    this.#peak = Math.max(total, this.#peak * PEAK_DECAY)
    const peak = this.#peak
    const silent = forceSilent || !(total > 0) || total < peak * GATE_RELATIVE
    out.fill(0)
    // LSE half.
    if (silent) {
      out[semis] = Math.sqrt(LSE_SHARE)
    } else {
      let norm = PRESENCE * PRESENCE
      for (let p = 0; p < semis; p++) {
        const v = Math.log1p((LOG_GAMMA * energy[p]!) / max)
        out[p] = v
        norm += v * v
      }
      out[semis] = PRESENCE
      const s = Math.sqrt(LSE_SHARE / norm)
      for (let p = 0; p <= semis; p++) out[p] = out[p]! * s
    }
    // Onset half: rises of log energy relative to the running peak.
    const o = HALF_DIM
    let flux = 0
    let norm = STEADY * STEADY
    for (let p = 0; p < semis; p++) {
      const l = silent ? 0 : Math.log1p((LOG_GAMMA * energy[p]!) / peak)
      const d = l - this.#prevLog[p]!
      this.#prevLog[p] = l
      if (d > 0) {
        out[o + p] = d
        flux += d
        norm += d * d
      }
    }
    out[o + semis] = STEADY
    const s = Math.sqrt((1 - LSE_SHARE) / norm)
    for (let p = 0; p <= semis; p++) out[o + p] = out[o + p]! * s
    return { onset: flux, silent }
  }
}

export interface FrameResult {
  /** Sum of the per-semitone rises (spectral flux of log energy). */
  readonly onset: number
  readonly silent: boolean
}

export interface FeatureFrame extends FrameResult {
  /** Feature vector (FEATURE_DIM). Reused buffer: copy to keep. */
  readonly vector: Float32Array
  /** Mean power of the windowed frame (before the gate). */
  readonly power: number
}

export interface FeatureOptions {
  /** Absolute gate: mean frame power below this is silence (default 1e-6, about -60 dBFS). */
  readonly gateFloor?: number
}

/**
 * Streaming feature extractor: push any block size; every hop it analyzes the last frameSize
 * samples (zero-padded before the first samples) and calls `onFrame`. Frame `i` ends at sample
 * `(i + 1) · hop` of the stream.
 */
export class FeatureExtractor {
  readonly sampleRate: number
  readonly n: number
  readonly hop: number
  readonly #fft: Fft
  readonly #window: Float64Array
  readonly #bins: Int16Array
  readonly #ring: Float32Array
  #write = 0
  #sinceFrame = 0
  #frames = 0
  readonly #re: Float64Array
  readonly #im: Float64Array
  readonly #energy = new Float64Array(SEMITONES)
  readonly #vector = new Float32Array(FEATURE_DIM)
  readonly #encoder = new FrameEncoder()
  readonly #gateFloor: number

  constructor(sampleRate: number, options: FeatureOptions = {}) {
    this.sampleRate = sampleRate
    this.n = frameSize(sampleRate)
    this.hop = hopSize(sampleRate)
    this.#fft = new Fft(this.n)
    this.#window = new Float64Array(this.n)
    let wsum = 0
    for (let i = 0; i < this.n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n)
      this.#window[i] = w
      wsum += w * w
    }
    // Scale so a full-scale sine's mean power reads about 0.5 whatever the frame size.
    const scale = 1 / Math.sqrt(wsum / this.n)
    for (let i = 0; i < this.n; i++) this.#window[i] = this.#window[i]! * scale
    this.#bins = binToSemitone(sampleRate, this.n)
    this.#ring = new Float32Array(this.n)
    this.#re = new Float64Array(this.n)
    this.#im = new Float64Array(this.n)
    this.#gateFloor = options.gateFloor ?? 1e-6
  }

  /** Frames analyzed so far. */
  get frames(): number {
    return this.#frames
  }

  reset(): void {
    this.#ring.fill(0)
    this.#write = 0
    this.#sinceFrame = 0
    this.#frames = 0
    this.#encoder.reset()
  }

  push(samples: Float32Array, onFrame: (frame: FeatureFrame, index: number) => void): void {
    const n = this.n
    for (let i = 0; i < samples.length; i++) {
      this.#ring[this.#write] = samples[i]!
      this.#write = (this.#write + 1) & (n - 1)
      if (++this.#sinceFrame === this.hop) {
        this.#sinceFrame = 0
        onFrame(this.#analyze(), this.#frames++)
      }
    }
  }

  #analyze(): FeatureFrame {
    const n = this.n
    const ring = this.#ring
    const win = this.#window
    const w0 = this.#write
    const re = this.#re
    const im = this.#im
    let power = 0
    for (let i = 0; i < n; i++) {
      const x = ring[(w0 + i) & (n - 1)]! * win[i]!
      re[i] = x
      im[i] = 0
      power += x * x
    }
    power /= n
    this.#fft.transform(re, im)
    const e = this.#energy
    e.fill(0)
    const bins = this.#bins
    for (let k = 1; k <= n / 2; k++) {
      const p = bins[k]!
      if (p >= 0) e[p] = e[p]! + re[k]! * re[k]! + im[k]! * im[k]!
    }
    const r = this.#encoder.encode(e, power < this.#gateFloor, this.#vector)
    return { vector: this.#vector, power, onset: r.onset, silent: r.silent }
  }
}
