/**
 * Spectral front end of the audio follower (DECISIONS P16): the energy of each piano semitone
 * (MIDI 21–108) in a frame of about 85 ms, every 10 ms. Pure and worker-safe (no DOM, no Web
 * Audio): the caller feeds raw mono samples.
 *
 * The frame is long enough to tell neighboring semitones apart down to about middle C (a frame
 * half as long confuses a note with its neighbor twice as often, measured on real piano
 * samples), and its window is skewed, rising over three quarters of the frame and falling over
 * the last quarter, so a new attack weighs in sooner than under a symmetric window.
 */

export const PIANO_LOW = 21
export const PIANO_HIGH = 108
export const SEMITONES = PIANO_HIGH - PIANO_LOW + 1
export const HOP_SEC = 0.01
export const FRAME_SEC = 0.085
/** Share of the frame over which the window rises (0.5 would be a Hann window). */
export const WINDOW_SKEW = 0.75

/** Power-of-two frame length nearest to FRAME_SEC (4096 at 44.1 and 48 kHz). */
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

/** The analysis window: sin² up over `WINDOW_SKEW` of the frame, cos² down over the rest. */
export function analysisWindow(n: number): Float64Array {
  const up = Math.round(n * WINDOW_SKEW)
  const down = n - up
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    w[i] = i < up ? Math.sin((Math.PI / 2) * (i / up)) ** 2 : Math.cos((Math.PI / 2) * ((i - up) / down)) ** 2
  }
  return w
}

/** Fractional-bin steps per bin and the bins covered each side by `windowLobe`. */
const LOBE_STEPS = 16
export const LOBE_SPAN = 4

/**
 * Power response of the analysis window `d` FFT bins away from a steady partial (1 at d = 0):
 * how a partial that falls between bins spreads over them. Returns a lookup for |d| < LOBE_SPAN.
 */
export function windowLobe(n: number): (d: number) => number {
  const w = analysisWindow(n)
  const table = new Float64Array(2 * LOBE_SPAN * LOBE_STEPS + 1)
  let dc = 0
  for (let i = 0; i < n; i++) dc += w[i]!
  for (let j = 0; j < table.length; j++) {
    const d = (j - LOBE_SPAN * LOBE_STEPS) / LOBE_STEPS
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const phase = (2 * Math.PI * d * i) / n
      re += w[i]! * Math.cos(phase)
      im += w[i]! * Math.sin(phase)
    }
    table[j] = (re * re + im * im) / (dc * dc)
  }
  return (d) => {
    const x = (d + LOBE_SPAN) * LOBE_STEPS
    if (!(x > 0) || x >= table.length - 1) return 0
    const i = Math.floor(x)
    const f = x - i
    return table[i]! * (1 - f) + table[i + 1]! * f
  }
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
 * Streaming semitone analyzer: push any block size; every hop it analyzes the last frameSize
 * samples (zeros before the first samples) and calls `onFrame` with the energy per semitone and
 * their sum. Energies are scaled so a full-scale sine reads about 1 whatever the frame size.
 * Frame `i` ends at sample `(i + 1) · hop` of the stream.
 */
export class SemitoneAnalyzer {
  readonly sampleRate: number
  readonly n: number
  readonly hop: number
  readonly #fft: Fft
  readonly #window: Float64Array
  readonly #bins: Int16Array
  readonly #ring: Float32Array
  readonly #re: Float64Array
  readonly #im: Float64Array
  /** Reused buffer: copy to keep. */
  readonly #energy = new Float64Array(SEMITONES)
  readonly #scale: number
  #write = 0
  #sinceFrame = 0
  #frames = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.n = frameSize(sampleRate)
    this.hop = hopSize(sampleRate)
    this.#fft = new Fft(this.n)
    this.#window = analysisWindow(this.n)
    let w2 = 0
    for (let i = 0; i < this.n; i++) w2 += this.#window[i]! * this.#window[i]!
    this.#scale = 4 / (this.n * w2)
    this.#bins = binToSemitone(sampleRate, this.n)
    this.#ring = new Float32Array(this.n)
    this.#re = new Float64Array(this.n)
    this.#im = new Float64Array(this.n)
  }

  /** Frames analyzed so far. */
  get frames(): number {
    return this.#frames
  }

  /** Frames until the analysis frame holds only samples pushed after a `reset`. */
  get fillFrames(): number {
    return Math.ceil(this.n / this.hop)
  }

  reset(): void {
    this.#ring.fill(0)
    this.#write = 0
    this.#sinceFrame = 0
    this.#frames = 0
  }

  push(samples: Float32Array, onFrame: (energy: Float64Array, total: number, index: number) => void): void {
    const n = this.n
    for (let i = 0; i < samples.length; i++) {
      this.#ring[this.#write] = samples[i]!
      this.#write = (this.#write + 1) & (n - 1)
      if (++this.#sinceFrame === this.hop) {
        this.#sinceFrame = 0
        onFrame(this.#energy, this.#analyze(), this.#frames++)
      }
    }
  }

  #analyze(): number {
    const n = this.n
    const ring = this.#ring
    const win = this.#window
    const w0 = this.#write
    const re = this.#re
    const im = this.#im
    for (let i = 0; i < n; i++) {
      re[i] = ring[(w0 + i) & (n - 1)]! * win[i]!
      im[i] = 0
    }
    this.#fft.transform(re, im)
    const e = this.#energy
    e.fill(0)
    const bins = this.#bins
    const scale = this.#scale
    let total = 0
    for (let k = 1; k <= n / 2; k++) {
      const p = bins[k]!
      if (p < 0) continue
      const v = (re[k]! * re[k]! + im[k]! * im[k]!) * scale
      e[p] = e[p]! + v
      total += v
    }
    return total
  }
}
