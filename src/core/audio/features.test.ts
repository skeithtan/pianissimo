import { describe, expect, it } from 'vitest'
import {
  FEATURE_DIM,
  FeatureExtractor,
  Fft,
  HALF_DIM,
  LSE_SHARE,
  SEMITONES,
  binToSemitone,
  frameSize,
  hopSize,
  semitoneOfFrequency,
} from './features'

function sine(freq: number, seconds: number, sampleRate: number, amplitude = 0.5, from = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = Math.round(from * sampleRate); i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  }
  return out
}

describe('FFT and frame geometry', () => {
  it('matches a naive DFT', () => {
    const n = 32
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) + Math.cos(i * i * 0.1)
    const input = Float64Array.from(re)
    new Fft(n).transform(re, im)
    for (let k = 0; k < n; k++) {
      let r = 0
      let j = 0
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n
        r += input[t]! * Math.cos(a)
        j += input[t]! * Math.sin(a)
      }
      expect(re[k]).toBeCloseTo(r, 9)
      expect(im[k]).toBeCloseTo(j, 9)
    }
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => new Fft(24)).toThrow(RangeError)
  })

  it('uses 2048-sample frames and exactly 10 ms hops at 44.1 and 48 kHz', () => {
    expect(frameSize(44100)).toBe(2048)
    expect(frameSize(48000)).toBe(2048)
    expect(hopSize(44100)).toBe(441)
    expect(hopSize(48000)).toBe(480)
  })

  it('bins frequencies to piano semitones and nothing outside the range', () => {
    expect(semitoneOfFrequency(440)).toBe(69 - 21)
    expect(semitoneOfFrequency(27.5)).toBe(0)
    expect(semitoneOfFrequency(4186)).toBe(SEMITONES - 1)
    expect(semitoneOfFrequency(10)).toBe(-1)
    expect(semitoneOfFrequency(8000)).toBe(-1)
    const bins = binToSemitone(44100, 2048)
    expect(bins[0]).toBe(-1)
    expect(bins[Math.round((440 * 2048) / 44100)]).toBe(48)
  })
})

describe('FeatureExtractor', () => {
  it('emits one frame per hop and puts a sine in its semitone', () => {
    const fx = new FeatureExtractor(44100)
    const frames: { semitone: number; silent: boolean; onset: number; time: number }[] = []
    fx.push(sine(440, 1, 44100), (f, index) => {
      let best = -1
      let bestV = -1
      for (let p = 0; p < SEMITONES; p++) {
        if (f.vector[p]! > bestV) {
          bestV = f.vector[p]!
          best = p
        }
      }
      frames.push({ semitone: best, silent: f.silent, onset: f.onset, time: (index + 1) / 100 })
    })
    expect(frames.length).toBe(100)
    expect(fx.frames).toBe(100)
    const steady = frames.filter((f) => f.time > 0.2)
    expect(steady.every((f) => f.semitone === 48 && !f.silent)).toBe(true)
    // Unit vector: the two halves share the energy as LSE_SHARE says.
    const v = new Float32Array(FEATURE_DIM)
    fx.reset()
    fx.push(sine(440, 0.1, 44100), (f) => v.set(f.vector))
    let lse = 0
    let onset = 0
    for (let k = 0; k < HALF_DIM; k++) {
      lse += v[k]! ** 2
      onset += v[HALF_DIM + k]! ** 2
    }
    expect(lse).toBeCloseTo(LSE_SHARE, 5)
    expect(onset).toBeCloseTo(1 - LSE_SHARE, 5)
  })

  it('marks silence and gives it the presence value only', () => {
    const fx = new FeatureExtractor(48000)
    let seen = 0
    fx.push(new Float32Array(4800), (f) => {
      seen++
      expect(f.silent).toBe(true)
      expect(f.power).toBe(0)
      expect(f.vector[SEMITONES]).toBeCloseTo(Math.sqrt(LSE_SHARE), 6)
      for (let p = 0; p < SEMITONES; p++) expect(f.vector[p]).toBe(0)
    })
    expect(seen).toBe(10)
  })

  it('gates frames far below the running peak', () => {
    const fx = new FeatureExtractor(44100)
    const loud = sine(440, 0.5, 44100, 0.5)
    const faint = sine(440, 0.5, 44100, 0.5e-3)
    const audio = new Float32Array(loud.length + faint.length)
    audio.set(loud)
    audio.set(faint, loud.length)
    const silent: boolean[] = []
    fx.push(audio, (f) => silent.push(f.silent))
    expect(silent.slice(10, 50).every((s) => !s)).toBe(true)
    // The faint tail is -60 dB under the peak and under the absolute floor: silent once the
    // frame has left the loud part.
    expect(silent.slice(57, 70).every((s) => s)).toBe(true)
  })

  it('onset strength peaks at an attack and settles while the note sounds', () => {
    const fx = new FeatureExtractor(44100)
    const onsets: number[] = []
    fx.push(sine(440, 1.2, 44100, 0.5, 0.3), (f) => onsets.push(f.onset))
    let peak = 0
    for (let i = 1; i < onsets.length; i++) if (onsets[i]! > onsets[peak]!) peak = i
    expect((peak + 1) / 100).toBeGreaterThan(0.28)
    expect((peak + 1) / 100).toBeLessThan(0.36)
    expect(onsets[80]).toBeLessThan(onsets[peak]! * 0.05)
  })
})
