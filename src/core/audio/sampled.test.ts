/**
 * The follower on real piano sound (DECISIONS P16): performances rendered with the app's own
 * sampled grand (`public/samples/salamander`) through a small room model, played the way a
 * learner plays. Needs `ffmpeg` on the PATH to decode the samples; skipped without it.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importBytes } from '../../../tests/unit/import/fixtures'
import { generateLongScore } from '../../../tests/fixtures/generate-long-score'
import type { ScoreModel } from '../model/score'
import { type PerformOptions, evaluateAudio, perform } from './evaluate'
import { createAudioFollower } from './index'
import { type PlayedNote, rng } from './testkit'

const SAMPLES = resolve(import.meta.dirname, '../../../public/samples/salamander')
const SR = 48000
const SLOW = 120_000

function ffmpeg(args: string[]): Buffer | null {
  const run = spawnSync('ffmpeg', args, { maxBuffer: 1 << 26 })
  return run.status === 0 ? run.stdout : null
}
const available = ffmpeg(['-version']) !== null

interface Sample {
  readonly data: Float32Array
  /** First sample of the attack. */
  readonly attack: number
  readonly peak: number
}

let bank: Map<number, Sample> | null = null
/** The sampled notes (every minor third), decoded to mono at SR. */
function samples(): Map<number, Sample> {
  if (bank) return bank
  bank = new Map()
  const manifest = JSON.parse(readFileSync(resolve(SAMPLES, 'manifest.json'), 'utf8')) as {
    samples: Record<string, number>
    extension: string
  }
  for (const [name, midi] of Object.entries(manifest.samples)) {
    const file = resolve(SAMPLES, `${name}.${manifest.extension}`)
    const pcm = ffmpeg(['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'])
    if (!pcm) throw new Error(`ffmpeg could not decode ${file}`)
    const data = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
    let peak = 0
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!))
    let attack = 0
    while (attack < data.length && Math.abs(data[attack]!) < 0.02 * peak) attack++
    bank.set(midi, { data, attack, peak })
  }
  return bank
}

/** Renders notes with the nearest sample, repitched; dampers fall on release below F#6. */
function renderSampled(notes: readonly PlayedNote[], tail = 1.5): Float32Array {
  const all = samples()
  let lastEnd = 0
  for (const n of notes) lastEnd = Math.max(lastEnd, n.end)
  const out = new Float32Array(Math.ceil((lastEnd + tail) * SR))
  for (const n of notes) {
    let root = 21
    for (const r of all.keys()) if (Math.abs(r - n.midi) < Math.abs(root - n.midi)) root = r
    const s = all.get(root)!
    const rate = 2 ** ((n.midi - root) / 12)
    const gain = (0.25 + 0.75 * n.velocity) ** 2 / s.peak
    const from = Math.round(n.start * SR)
    const release = Math.round(n.end * SR)
    const damping = n.midi < 90 ? Math.exp(-1 / ((n.midi < 45 ? 0.18 : 0.09) * SR)) : 1
    const lead = Math.min(s.attack, Math.round(0.002 * SR))
    let env = 1
    for (let i = 0; from + i < out.length; i++) {
      const x = s.attack - lead + i * rate
      const k = Math.floor(x)
      if (k + 1 >= s.data.length) break
      if (from + i >= release) {
        env *= damping
        if (env < 1e-4) break
      }
      const v = s.data[k]! * (1 - (x - k)) + s.data[k + 1]! * (x - k)
      if (from + i >= 0) out[from + i] = out[from + i]! + gain * env * v
    }
  }
  return out
}

/**
 * A living room and a small microphone: comb-filter reverberation mixed in at `wet`, a 120 Hz
 * high-pass, the piano's peak at `peak` and pink noise at `noiseDb` dBFS.
 */
function room(dry: Float32Array, o: { wet?: number; peak?: number; noiseDb?: number } = {}): Float32Array {
  const rand = rng(11)
  const wet = o.wet ?? 0.2
  const echo = new Float32Array(dry.length)
  for (const delay of [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]) {
    const d = Math.round((delay * SR) / 44100)
    const line = new Float32Array(d)
    let at = 0
    let low = 0
    for (let i = 0; i < dry.length; i++) {
      const y = line[at]!
      low = y * 0.8 + low * 0.2
      line[at] = dry[i]! * 0.015 + low * 0.84
      at = at + 1 === d ? 0 : at + 1
      echo[i] = echo[i]! + y
    }
  }
  let dryPower = 0
  let echoPower = 0
  for (let i = 0; i < dry.length; i++) {
    dryPower += dry[i]! ** 2
    echoPower += echo[i]! ** 2
  }
  const level = echoPower > 0 ? Math.sqrt(dryPower / echoPower) : 0
  const mixed = new Float32Array(dry.length)
  const a = Math.exp((-2 * Math.PI * 120) / SR)
  let l1 = 0
  let l2 = 0
  let top = 0
  for (let i = 0; i < dry.length; i++) {
    const x = (1 - wet) * dry[i]! + wet * level * echo[i]!
    l1 = a * l1 + (1 - a) * x
    const h1 = x - l1
    l2 = a * l2 + (1 - a) * h1
    mixed[i] = h1 - l2
    top = Math.max(top, Math.abs(mixed[i]!))
  }
  const gain = top > 0 ? (o.peak ?? 0.25) / top : 1
  const noise = 10 ** ((o.noiseDb ?? -55) / 20)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < mixed.length; i++) {
    // Paul Kellet's economy pink filter, about unit RMS.
    const w = (rand() * 2 - 1) * 1.732
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    mixed[i] = mixed[i]! * gain + noise * (b0 + b1 + b2 + w * 0.1848) * 0.25
  }
  return mixed
}

async function longScore(): Promise<ScoreModel> {
  const xml = new TextEncoder().encode(generateLongScore(24))
  return (await importBytes('long.musicxml', xml)).package.model
}

function run(model: ScoreModel, options: PerformOptions, mic: Parameters<typeof room>[1] = {}) {
  const perf = perform(model, model.tempo, options)
  return evaluateAudio(model, room(renderSampled(perf.notes), mic), SR, perf.onsets, perf.mistakes)
}

describe.skipIf(!available)('audio follower on a sampled grand in a room', () => {
  it(
    'follows steady playing at 0.8×, 1× and 1.3×',
    async () => {
      const model = await longScore()
      for (const factor of [0.8, 1, 1.3]) {
        const ev = run(model, { factor })
        expect(ev.within150).toBeGreaterThanOrEqual(0.93)
        expect(ev.ahead).toBeLessThanOrEqual(0.02)
        expect(ev.medianAbsMs).toBeLessThan(90)
      }
    },
    SLOW,
  )

  it(
    'waits through a learner’s stops and mistakes at 0.6× and does not run ahead',
    async () => {
      const ev = run(await longScore(), {
        factor: 0.6,
        hesitations: [
          { at: 0.1, seconds: 2, held: true },
          { at: 0.25, seconds: 3 },
          { at: 0.4, seconds: 1, held: true },
          { at: 0.55, seconds: 4, held: true },
          { at: 0.7, seconds: 2 },
          { at: 0.85, seconds: 3, held: true },
        ],
        wrongAt: [0.2, 0.5, 0.8],
        missingAt: [0.35, 0.65],
      })
      expect(ev.within150).toBeGreaterThanOrEqual(0.9)
      expect(ev.ahead).toBeLessThanOrEqual(0.03)
    },
    SLOW,
  )

  it(
    'follows in a noisy room (noise 28 dB under the piano) and with the pedal held through',
    async () => {
      const model = await longScore()
      const noisy = run(model, { factor: 0.8 }, { noiseDb: -40 })
      expect(noisy.within150).toBeGreaterThanOrEqual(0.93)
      expect(noisy.ahead).toBeLessThanOrEqual(0.02)
      const pedal = run(model, { factor: 0.8, sustain: 1 })
      expect(pedal.within150).toBeGreaterThanOrEqual(0.9)
      expect(pedal.ahead).toBeLessThanOrEqual(0.02)
    },
    SLOW,
  )

  it(
    'hears nothing in a chord that rings on, in a talk-level noise before the first note or after the last',
    async () => {
      const model = await longScore()
      const perf = perform(model, model.tempo, { factor: 1, lead: 4 })
      const cut = perf.onsets[20]!.time - 0.05
      const notes = perf.notes.filter((n) => n.start < cut).map((n) => (n.end > cut - 0.3 ? { ...n, end: cut + 6 } : n))
      const audio = room(renderSampled(notes, 4), { noiseDb: -45 })
      const follower = createAudioFollower(model)
      let before = 0
      let after = 0
      let group = -1
      for (let s = 0; s + 512 <= audio.length; s += 512) {
        const est = follower.push(audio.subarray(s, s + 512), SR, s / SR)
        if (est.moved && est.time < perf.onsets[0]!.time - 0.05) before++
        if (est.time < cut + 0.3) group = est.group
        else if (est.moved) after++
      }
      expect(before).toBe(0)
      expect(group).toBe(19)
      expect(after).toBe(0)
    },
    SLOW,
  )
})
