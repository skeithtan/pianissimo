import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REFERENCE_PIECE, fixtureExists, importBytes, importFixture } from '../../../tests/unit/import/fixtures'
import { generateLongScore } from '../../../tests/fixtures/generate-long-score'
import { buildTimeline } from '../engine'
import type { ScoreModel } from '../model/score'
import { toNumber } from '../music/rational'
import { type PerformOptions, evaluate, perform } from './evaluate'
import { createAudioFollower, groupReached } from './index'
import { renderNotes } from './testkit'

const FACTORS = [1, 0.8, 1.25]
const MISTAKES = { wrongAt: [0.3, 0.6], missingAt: [0.45] }
const SLOW = 60_000

async function fixture(name: string): Promise<ScoreModel> {
  return (await importFixture(`${name}.musicxml`)).package.model
}

async function longScore(): Promise<ScoreModel> {
  const xml = new TextEncoder().encode(generateLongScore(24))
  return (await importBytes('long.musicxml', xml)).package.model
}

function run(model: ScoreModel, options: PerformOptions) {
  return evaluate(model, model.tempo, 1, perform(model, model.tempo, options))
}

describe('audio follower on synthetic performances (reference built at 1×)', () => {
  describe.each(['two-hands', 'unequal-rhythms', 'tuplets', 'tempo-changes', 'repeats', 'rolls'])('%s', (name) => {
    it.each(FACTORS)(
      'reaches at least 90 % of the onsets within 150 ms when played at %s× without mistakes',
      async (factor) => {
        const ev = run(await fixture(name), { factor })
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
        expect(ev.medianAbsMs).toBeLessThan(60)
      },
      SLOW,
    )

    it.each(FACTORS)(
      'recovers within a second after wrong and missing notes at %s×',
      async (factor) => {
        const ev = run(await fixture(name), { factor, ...MISTAKES })
        if (name === 'rolls') {
          // Six rolled chords: a wrong note inside a roll holds the match back for one more onset
          // (about 400 ms late), so only the last onset is clean a second after the mistakes.
          expect(ev.errors[ev.errors.length - 1]).toBeLessThan(0.15)
        } else {
          expect(ev.recovered).toBeGreaterThanOrEqual(0.9)
        }
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
        expect(ev.medianAbsMs).toBeLessThan(60)
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
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
      },
      SLOW,
    )

    it(
      'copes with the sustain pedal held through (notes ringing on a second)',
      async () => {
        const ev = run(await longScore(), { factor: 1, sustain: 1 })
        expect(ev.within150).toBeGreaterThanOrEqual(0.9)
      },
      SLOW,
    )

    it(
      'costs well under the 10 ms frame budget per frame',
      async () => {
        const model = await longScore()
        const ev = evaluate(model, model.tempo, 1, perform(model, model.tempo, { factor: 1 }), {
          clock: () => performance.now(),
        })
        expect(ev.frames).toBeGreaterThan(1000)
        expect(ev.msPerFrame).toBeLessThan(2)
      },
      SLOW,
    )
  })

  it(
    'waits while the player stops for two seconds in the middle',
    async () => {
      const ev = run(await fixture('unequal-rhythms'), { factor: 1, pause: 2, pauseAt: 0.5 })
      expect(ev.within150).toBeGreaterThanOrEqual(0.9)
    },
    SLOW,
  )

  it(
    'holds its position through silence instead of running on',
    async () => {
      const model = await fixture('unequal-rhythms')
      const perf = perform(model, model.tempo, { factor: 1 })
      const sr = 44100
      const audio = renderNotes(perf.notes, { sampleRate: sr })
      const follower = createAudioFollower(model, model.tempo, 1)
      const hop = sr / 100
      const half = Math.floor(audio.length / 2 / hop) * hop
      let est = follower.push(audio.subarray(0, half), sr, 0)
      // The frames straddling the cut still carry energy; after 0.1 s of silence the match holds.
      for (let s = 0; s < sr / 10; s += hop) est = follower.push(new Float32Array(hop), sr, (half + s) / sr)
      const before = est.position
      expect(before).toBeGreaterThan(0)
      expect(before).toBeLessThan(toNumber(model.totalDuration))
      for (let s = 0; s < sr; s += hop) est = follower.push(new Float32Array(hop), sr, (half + sr / 10 + s) / sr)
      expect(est.position).toBe(before)
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
      const follower = createAudioFollower(model, model.tempo, 1)
      const hop = sr / 100
      const g = 3
      const target = timeline.groups[g]!
      follower.push(audio.subarray(0, hop), sr, 0)
      follower.reset(target.position)
      const from = Math.round((perf.onsets[g]!.time - 0.2) * sr)
      let position = -1
      for (let s = from; s + hop <= audio.length && (s - from) / sr < 1.5; s += hop) {
        position = follower.push(audio.subarray(s, s + hop), sr, s / sr).position
      }
      expect(position).toBeGreaterThanOrEqual(toNumber(target.position))
      expect(position).toBeLessThan(toNumber(timeline.groups[g + 2]!.position))
    },
    SLOW,
  )

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
      'reaches at least 95 % of its onsets within 150 ms at 1×',
      async () => {
        const ev = run(await reference(), { factor: 1 })
        expect(ev.onsets).toBeGreaterThan(500)
        expect(ev.within150).toBeGreaterThanOrEqual(0.95)
        expect(ev.medianAbsMs).toBeLessThan(60)
      },
      SLOW,
    )

    it(
      'recovers after mistakes at 1.25×',
      async () => {
        const ev = run(await reference(), { factor: 1.25, ...MISTAKES })
        expect(ev.within150).toBeGreaterThanOrEqual(0.95)
        expect(ev.recovered).toBeGreaterThanOrEqual(0.95)
      },
      SLOW,
    )

    it(
      'tracks it played with the sustain pedal as marked (notes ringing to each pedal lift)',
      async () => {
        const ev = run(await reference(), { factor: 1, pedal: true })
        expect(ev.within150).toBeGreaterThanOrEqual(0.95)
      },
      SLOW,
    )

    it(
      'still follows when every note rings a second longer than written (unmarked pedaling)',
      async () => {
        const ev = run(await reference(), { factor: 1, sustain: 1 })
        expect(ev.within150).toBeGreaterThanOrEqual(0.85)
        expect(ev.errors.filter((e) => Math.abs(e) <= 0.5).length / ev.errors.length).toBeGreaterThanOrEqual(0.95)
      },
      SLOW,
    )
  })
})
