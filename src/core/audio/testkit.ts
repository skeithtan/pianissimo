/**
 * Test helpers for the audio follower: a deterministic additive piano-like synthesizer. Pure (no
 * Node APIs). The synthesizer deliberately differs from the follower's templates (partial
 * amplitudes, inharmonicity, per-partial decay, velocity), so tests do not match a copy.
 */
import { PIANO_LOW } from './features'

/** Decay time constant of a sounding piano string by pitch (rough: long in the bass, short in the treble). */
export function decaySec(midi: number): number {
  return 3 * 2 ** (-(midi - PIANO_LOW) / 24)
}

export interface PlayedNote {
  readonly midi: number
  /** Seconds in the rendered audio. */
  readonly start: number
  readonly end: number
  /** 0..1 */
  readonly velocity: number
}

/** Mulberry32: deterministic uniform [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SynthOptions {
  readonly sampleRate?: number
  /** Extra seconds after the last release. */
  readonly tail?: number
  /** White-noise amplitude (default 3e-4, about -70 dBFS). */
  readonly noise?: number
  readonly seed?: number
}

/** Renders notes as decaying inharmonic partials plus noise, peak-normalized to 0.5. */
export function renderNotes(notes: readonly PlayedNote[], options: SynthOptions = {}): Float32Array {
  const sr = options.sampleRate ?? 44100
  const rand = rng(options.seed ?? 1)
  let lastEnd = 0
  for (const n of notes) lastEnd = Math.max(lastEnd, n.end)
  const length = Math.ceil((lastEnd + 0.3 + (options.tail ?? 1)) * sr)
  const out = new Float32Array(length)
  const B = 0.0004
  const release = 0.08
  for (const n of notes) {
    const f0 = 440 * 2 ** ((n.midi - 69) / 12)
    const tau = decaySec(n.midi) * 1.5
    const s0 = Math.max(0, Math.round(n.start * sr))
    const sEnd = Math.round(n.end * sr)
    const sLast = Math.min(length, sEnd + Math.round(release * 6 * sr))
    for (let h = 1; h <= 6; h++) {
      const f = h * f0 * Math.sqrt(1 + B * h * h)
      if (f > 0.45 * sr) break
      const amp = n.velocity * 0.6 ** (h - 1) * (0.8 + 0.4 * rand())
      const tauH = tau / (1 + 0.4 * (h - 1))
      // Rotating phasor and multiplicative envelopes: no transcendental calls per sample.
      const phase = rand() * 2 * Math.PI
      const w = (2 * Math.PI * f) / sr
      const cw = Math.cos(w)
      const sw = Math.sin(w)
      let re = Math.cos(phase)
      let im = Math.sin(phase)
      const decay = Math.exp(-1 / (tauH * sr))
      const damp = Math.exp(-1 / (release * sr))
      const attack = Math.round(0.003 * sr)
      let env = amp
      for (let s = s0; s < sLast; s++) {
        const k = s - s0
        out[s] = out[s]! + (k < attack ? (env * k) / attack : env) * im
        const r = re * cw - im * sw
        im = re * sw + im * cw
        re = r
        env *= s >= sEnd ? decay * damp : decay
        if (env < 1e-5 * amp && k > attack) break
      }
    }
  }
  let peak = 0
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]!))
  const g = peak > 0 ? 0.5 / peak : 1
  const noise = options.noise ?? 3e-4
  for (let i = 0; i < length; i++) out[i] = out[i]! * g + noise * (rand() * 2 - 1) * 1.73
  return out
}
