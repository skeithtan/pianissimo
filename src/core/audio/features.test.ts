import { describe, expect, it } from 'vitest'
import {
  Fft,
  LOBE_SPAN,
  SEMITONES,
  SemitoneAnalyzer,
  WINDOW_SKEW,
  analysisWindow,
  binToSemitone,
  frameSize,
  hopSize,
  semitoneOfFrequency,
  windowLobe,
} from './features'

function sine(freq: number, seconds: number, sampleRate: number, amplitude = 0.5, from = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = Math.round(from * sampleRate); i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  }
  return out
}

function loudest(energy: ArrayLike<number>): number {
  let best = 0
  for (let p = 1; p < SEMITONES; p++) if (energy[p]! > energy[best]!) best = p
  return best
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

  it('uses 4096-sample frames and exactly 10 ms hops at 44.1 and 48 kHz', () => {
    expect(frameSize(44100)).toBe(4096)
    expect(frameSize(48000)).toBe(4096)
    expect(frameSize(96000)).toBe(8192)
    expect(hopSize(44100)).toBe(441)
    expect(hopSize(48000)).toBe(480)
  })

  it('bins frequencies to piano semitones and nothing outside the range', () => {
    expect(semitoneOfFrequency(440)).toBe(69 - 21)
    expect(semitoneOfFrequency(27.5)).toBe(0)
    expect(semitoneOfFrequency(4186)).toBe(SEMITONES - 1)
    expect(semitoneOfFrequency(10)).toBe(-1)
    expect(semitoneOfFrequency(8000)).toBe(-1)
    const bins = binToSemitone(44100, 4096)
    expect(bins[0]).toBe(-1)
    expect(bins[Math.round((440 * 4096) / 44100)]).toBe(48)
  })
})

describe('analysis window', () => {
  it('rises over three quarters of the frame and falls over the rest', () => {
    const n = 4096
    const w = analysisWindow(n)
    const top = Math.round(n * WINDOW_SKEW)
    expect(w[0]).toBe(0)
    expect(w[top]).toBeCloseTo(1, 9)
    expect(w[n - 1]).toBeLessThan(1e-5)
    for (let i = 1; i <= top; i++) expect(w[i]!).toBeGreaterThanOrEqual(w[i - 1]!)
    for (let i = top + 1; i < n; i++) expect(w[i]!).toBeLessThanOrEqual(w[i - 1]!)
    // The newest fifth of the frame carries an eighth of the weight (under a Hann window, 2 %).
    let recent = 0
    let all = 0
    for (let i = 0; i < n; i++) {
      all += w[i]! ** 2
      if (i >= n * 0.8) recent += w[i]! ** 2
    }
    expect(recent / all).toBeGreaterThan(0.1)
  })

  it('spreads a partial between bins as its power response says', () => {
    const lobe = windowLobe(4096)
    expect(lobe(0)).toBeCloseTo(1, 9)
    expect(lobe(0.5)).toBeGreaterThan(0.5)
    expect(lobe(0.5)).toBeCloseTo(lobe(-0.5), 9)
    expect(lobe(1)).toBeLessThan(lobe(0.5))
    expect(lobe(3)).toBeLessThan(0.01)
    expect(lobe(LOBE_SPAN)).toBe(0)
    expect(lobe(-LOBE_SPAN - 1)).toBe(0)
  })
})

describe('SemitoneAnalyzer', () => {
  it('emits one frame per hop and puts a sine in its semitone at its power', () => {
    const fx = new SemitoneAnalyzer(44100)
    const frames: { semitone: number; total: number; share: number }[] = []
    fx.push(sine(440, 1, 44100, 0.5), (energy, total) => {
      const p = loudest(energy)
      frames.push({ semitone: p, total, share: energy[p]! / total })
    })
    expect(frames.length).toBe(100)
    expect(fx.frames).toBe(100)
    expect(fx.fillFrames).toBe(10)
    const steady = frames.slice(20)
    expect(steady.every((f) => f.semitone === 48)).toBe(true)
    // A full-scale sine reads 1: amplitude 0.5 reads a quarter, nearly all of it in its semitone.
    for (const f of steady) {
      expect(f.total).toBeCloseTo(0.25, 2)
      expect(f.share).toBeGreaterThan(0.9)
    }
  })

  it('reads the same level at 48 kHz and tells a semitone from its neighbor at middle C', () => {
    const fx = new SemitoneAnalyzer(48000)
    let last = { semitone: -1, total: 0 }
    fx.push(sine(261.63, 0.5, 48000, 0.5), (energy, total) => (last = { semitone: loudest(energy), total }))
    expect(last.semitone).toBe(60 - 21)
    expect(last.total).toBeCloseTo(0.25, 2)
    fx.reset()
    fx.push(sine(277.18, 0.5, 48000, 0.5), (energy) => (last = { semitone: loudest(energy), total: 0 }))
    expect(last.semitone).toBe(61 - 21)
  })

  it('reads silence as zero and starts afresh after a reset', () => {
    const fx = new SemitoneAnalyzer(48000)
    let seen = 0
    fx.push(new Float32Array(4800), (energy, total, index) => {
      expect(index).toBe(seen++)
      expect(total).toBe(0)
      expect(energy.every((v) => v === 0)).toBe(true)
    })
    expect(seen).toBe(10)
    fx.push(sine(440, 0.2, 48000), () => {})
    fx.reset()
    expect(fx.frames).toBe(0)
    const totals: number[] = []
    fx.push(new Float32Array(960), (_, total) => totals.push(total))
    expect(totals).toEqual([0, 0])
  })

  it('lets a new attack into the frame within a few hops', () => {
    const fx = new SemitoneAnalyzer(44100)
    const totals: number[] = []
    fx.push(sine(440, 0.6, 44100, 0.5, 0.3), (_, total) => totals.push(total))
    // Frame i ends at (i + 1) × 10 ms: nothing before the attack at 0.3 s, half the level 40 ms in.
    expect(totals[28]).toBe(0)
    expect(totals[33]!).toBeGreaterThan(0.125)
    expect(totals[45]).toBeCloseTo(0.25, 2)
  })
})
