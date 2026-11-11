import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REFERENCE_PIECE, fixtureExists, importBytes, importFixture } from '../../../tests/unit/import/fixtures'
import { generateLongScore } from '../../../tests/fixtures/generate-long-score'
import { buildTimeline } from '../engine'
import { buildScore } from '../engine/testkit'
import type { ScoreModel } from '../model/score'
import { toNumber } from '../music/rational'
import { type EvaluateOptions, type PerformOptions, evaluate, perform } from './evaluate'
import { createAudioFollower, groupReached } from './index'
import { renderNotes } from './testkit'

const FACTORS = [1, 0.8, 1.25]
const MISTAKES = { wrongAt: [0.3, 0.6], missingAt: [0.45] }
/** A learner stopping to find the next notes: keys held, hands off, short and long. */
const HESITATIONS = [
  { at: 0.15, seconds: 1.5, held: true },
  { at: 0.35, seconds: 3, held: false },
  { at: 0.55, seconds: 4, held: true },
  { at: 0.8, seconds: 0.8, held: false },
]
const SLOW = 60_000

async function fixture(name: string): Promise<ScoreModel> {
  return (await importFixture(`${name}.musicxml`)).package.model
}

async function longScore(): Promise<ScoreModel> {
  const xml = new TextEncoder().encode(generateLongScore(24))
  return (await importBytes('long.musicxml', xml)).package.model
}

function run(model: ScoreModel, options: PerformOptions, evaluation: EvaluateOptions = {}) {
  return evaluate(model, perform(model, model.tempo, options), evaluation)
}

describe('audio follower on synthetic performances', () => {
  describe.each(['two-hands', 'unequal-rhythms', 'tuplets', 'tempo-changes', 'repeats', 'rolls'])('%s', (name) => {
    it.each(FACTORS)(
      'reaches at least 90 % of the onsets within 150 ms when played at %s× without mistakes',
      async (factor) => {
        const ev = run(await fixture(name), { factor })
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
        expect(ev.ahead).toBe(0)
        expect(ev.medianAbsMs).toBeLessThan(90)
      },
      SLOW,
    )

    it.each(FACTORS)(
      'recovers within a second after wrong and missing notes at %s×',
      async (factor) => {
        // (A wrong note may be the next note of the piece: the follower then moves on with it.)
        const ev = run(await fixture(name), { factor, ...MISTAKES })
        expect(ev.recovered).toBeGreaterThanOrEqual(0.9)
      },
      SLOW,
    )
  })

  describe('a 24-bar generated piece', () => {
    it.each(FACTORS)(
      'reaches at least 95 % of the onsets within 150 ms at %s×',
      async (factor) => {
        const ev = run(await longScore(), { factor })
        expect(ev.onsets).toBeGreaterThan(100)
        expect(ev.within150).toBeGreaterThanOrEqual(0.95)
        expect(ev.ahead).toBe(0)
        expect(ev.medianAbsMs).toBeLessThan(90)
      },
      SLOW,
    )

    it.each([0.4, 2])(
      'needs no tempo: follows at %s× the score tempo',
      async (factor) => {
        const ev = run(await longScore(), { factor })
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
        expect(ev.ahead).toBe(0)
      },
      SLOW,
    )

    it.each(FACTORS)(
      'keeps 90 % within 150 ms with wrong and missing notes at %s× and recovers',
      async (factor) => {
        const ev = run(await longScore(), { factor, ...MISTAKES })
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
        expect(ev.recovered).toBeGreaterThanOrEqual(0.95)
      },
      SLOW,
    )

    it(
      'follows rubato (±30 % tempo swings)',
      async () => {
        const ev = run(await longScore(), { factor: 1, rubato: 0.3 })
        expect(ev.within150).toBeGreaterThanOrEqual(0.95)
      },
      SLOW,
    )

    it(
      'copes with the sustain pedal held through (notes ringing on a second)',
      async () => {
        const ev = run(await longScore(), { factor: 1, sustain: 1 })
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
        expect(ev.ahead).toBe(0)
      },
      SLOW,
    )

    it(
      'waits through a learner’s stops, keys held or released, and never runs ahead',
      async () => {
        const ev = run(await longScore(), { factor: 0.7, hesitations: HESITATIONS })
        expect(ev.within150).toBeGreaterThanOrEqual(0.95)
        expect(ev.ahead).toBe(0)
      },
      SLOW,
    )

    it(
      'waits just the same in a noisy room (noise 30 dB under the piano)',
      async () => {
        const ev = run(await longScore(), { factor: 0.7, hesitations: HESITATIONS }, { noise: 0.016 })
        expect(ev.within150).toBeGreaterThanOrEqual(0.95)
        expect(ev.ahead).toBe(0)
      },
      SLOW,
    )

    it(
      'costs well under the 10 ms frame budget per frame',
      async () => {
        const model = await longScore()
        const ev = evaluate(model, perform(model, model.tempo, { factor: 1 }), { clock: () => performance.now() })
        expect(ev.frames).toBeGreaterThan(1000)
        expect(ev.msPerFrame).toBeLessThan(2)
      },
      SLOW,
    )
  })

  it(
    'hears nothing in a chord that rings on, in silence or in noise',
    async () => {
      const model = await fixture('unequal-rhythms')
      const perf = perform(model, model.tempo, { factor: 1 })
      const sr = 44100
      // The first half of the piece, its last notes held for five seconds, then five of noise.
      const cut = perf.onsets[Math.floor(perf.onsets.length / 2)]!.time - 0.05
      const notes = perf.notes.filter((n) => n.start < cut).map((n) => (n.end > cut - 0.3 ? { ...n, end: cut + 5 } : n))
      const audio = renderNotes(notes, { sampleRate: sr, tail: 5, noise: 0.01 })
      const follower = createAudioFollower(model)
      const hop = sr / 100
      let at = -1
      let moves = 0
      for (let s = 0; s + hop <= audio.length; s += hop) {
        const est = follower.push(audio.subarray(s, s + hop), sr, s / sr)
        if (s / sr < cut + 0.3) at = est.group
        else if (est.moved) moves++
      }
      expect(at).toBeGreaterThan(0)
      expect(at).toBeLessThan(follower.groups.length - 1)
      expect(moves).toBe(0)
    },
    SLOW,
  )

  it(
    'restarts from a position after a reset',
    async () => {
      const model = await fixture('two-hands')
      const timeline = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
      const perf = perform(model, model.tempo, { factor: 1 })
      const sr = 44100
      const audio = renderNotes(perf.notes, { sampleRate: sr })
      const follower = createAudioFollower(model)
      const hop = sr / 100
      const g = 3
      const target = timeline.groups[g]!
      follower.push(audio.subarray(0, hop), sr, 0)
      follower.reset(target.position)
      expect(follower.push(new Float32Array(hop), sr, 0).group).toBe(g - 1)
      // Listen from half a second before the target's attack to just before the next one.
      const from = Math.round((perf.onsets[g]!.time - 0.5) * sr)
      const to = Math.round((perf.onsets[g + 1]!.time - 0.05) * sr)
      let est = follower.push(new Float32Array(0), sr, 0)
      for (let s = from; s + hop <= to; s += hop) est = follower.push(audio.subarray(s, s + hop), sr, s / sr)
      expect(est.group).toBe(g)
      expect(est.position).toBe(toNumber(target.position))
      expect(est.confidence).toBeGreaterThan(0.5)
    },
    SLOW,
  )

  it(
    'finds the player again after a jump of a few bars, forward or back',
    async () => {
      // 36 quarter notes that never repeat (a stride of fifths over three octaves), so a place
      // in the piece is recognizable from its notes alone.
      const model = buildScore({
        tempo: { bpm: 120 },
        notes: Array.from({ length: 36 }, (_, k) => ({ at: k, dur: 1, midi: 48 + ((k * 7) % 36) })),
      })
      const perf = perform(model, model.tempo, { factor: 1 })
      const sr = 44100
      const audio = renderNotes(perf.notes, { sampleRate: sr })
      const hop = sr / 100
      const play = (follower: ReturnType<typeof createAudioFollower>, fromOnset: number, toOnset: number): number => {
        const from = Math.round((perf.onsets[fromOnset]!.time - 0.1) * sr)
        const to = Math.round((perf.onsets[toOnset]!.time - 0.05) * sr)
        let group = -1
        for (let s = from; s + hop <= to; s += hop) group = follower.push(audio.subarray(s, s + hop), sr, s / sr).group
        return group
      }
      const forward = createAudioFollower(model)
      expect(play(forward, 0, 6)).toBe(5)
      // The player skips three bars ahead: one attack there is not enough, a few are.
      expect(play(forward, 17, 18)).toBe(5)
      expect(play(forward, 18, 24)).toBe(23)
      const back = createAudioFollower(model)
      expect(play(back, 0, 24)).toBe(23)
      // And goes back to repeat from an earlier bar.
      expect(play(back, 8, 14)).toBe(13)
    },
    SLOW,
  )

  it('starts listening afresh at its position when the sample rate changes', async () => {
    const model = await fixture('two-hands')
    const follower = createAudioFollower(model)
    follower.reset(follower.groups[2]!.position)
    expect(follower.push(new Float32Array(4410), 44100, 0).group).toBe(1)
    const est = follower.push(new Float32Array(4800), 48000, 0.1)
    expect(est.group).toBe(1)
    expect(est.frames).toBe(10)
    expect(est.time).toBeCloseTo(0.2, 6)
  })

  it('maps a float position to the last group at or before it', async () => {
    const model = await fixture('two-hands')
    const timeline = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    const groups = timeline.groups
    expect(groupReached(timeline, -0.1)).toBe(-1)
    expect(groupReached(timeline, toNumber(groups[0]!.position))).toBe(0)
    const p3 = toNumber(groups[3]!.position)
    expect(groupReached(timeline, p3)).toBe(3)
    expect(groupReached(timeline, p3 - 1e-9)).toBe(3)
    expect(groupReached(timeline, (p3 + toNumber(groups[4]!.position)) / 2)).toBe(3)
    expect(groupReached(timeline, 1e9)).toBe(groups.length - 1)
  })

  describe.skipIf(!fixtureExists(REFERENCE_PIECE))('the reference piece (private fixture)', () => {
    async function reference(): Promise<ScoreModel> {
      const bytes = new Uint8Array(readFileSync(REFERENCE_PIECE))
      return (await importBytes('reference.musicxml', bytes)).package.model
    }

    it(
      'reaches at least 90 % of its onsets within 150 ms at 1×',
      async () => {
        const ev = run(await reference(), { factor: 1 })
        expect(ev.onsets).toBeGreaterThan(500)
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
        expect(ev.ahead).toBeLessThan(0.01)
        expect(ev.medianAbsMs).toBeLessThan(90)
      },
      SLOW,
    )

    it(
      'recovers after mistakes at 1.25×',
      async () => {
        const ev = run(await reference(), { factor: 1.25, ...MISTAKES })
        expect(ev.within150).toBeGreaterThanOrEqual(0.85)
        expect(ev.recovered).toBeGreaterThanOrEqual(0.85)
      },
      SLOW,
    )

    it(
      'tracks it played with the sustain pedal as marked (notes ringing to each pedal lift)',
      async () => {
        // The weakest case: soft notes under a lot of ringing sound are heard one note late.
        const ev = run(await reference(), { factor: 1, pedal: true })
        expect(ev.within150).toBeGreaterThanOrEqual(0.8)
        expect(ev.ahead).toBeLessThan(0.01)
      },
      SLOW,
    )

    it(
      'waits through a learner’s stops at 0.6×',
      async () => {
        const ev = run(await reference(), { factor: 0.6, hesitations: HESITATIONS })
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
        expect(ev.ahead).toBeLessThan(0.01)
      },
      SLOW,
    )
  })
})
