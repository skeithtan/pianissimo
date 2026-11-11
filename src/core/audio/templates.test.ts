import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { buildTimeline } from '../engine'
import { buildScore } from '../engine/testkit'
import { toNumber } from '../music/rational'
import { SEMITONES } from './features'
import { attackGroups, attackTemplates, groupPositions, pitchTemplate } from './templates'

function argmax(v: ArrayLike<number>): number {
  let best = 0
  for (let p = 1; p < SEMITONES; p++) if (v[p]! > v[best]!) best = p
  return best
}

describe('attackGroups', () => {
  it('lists the pitches struck at each position in order', () => {
    const model = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 0, midi: 48, hand: 'L' },
        { at: 1, midi: 62 },
        { at: 2, midi: 64 },
        { at: 2, midi: 64, voice: '2' },
      ],
    })
    const groups = attackGroups(model)
    expect(groups.map((g) => g.pitches)).toEqual([[48, 60], [62], [64]])
    expect(Array.from(groupPositions(groups))).toEqual([0, 0.25, 0.5])
  })

  it.each(['two-hands', 'ties', 'rolls', 'repeats', 'cue-notes', 'tuplets'])(
    'has the practice timeline’s positions and pitches for both hands (%s)',
    async (name) => {
      const { model } = (await importFixture(`${name}.musicxml`)).package
      const timeline = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
      const groups = attackGroups(model)
      expect(groups.map((g) => toNumber(g.position))).toEqual(timeline.groups.map((g) => toNumber(g.position)))
      expect(groups.map((g) => g.pitches)).toEqual(timeline.groups.map((g) => g.pitches))
    },
  )
})

describe('pitch templates', () => {
  it('put the fundamental in its semitone at 1, with weaker partials above it', () => {
    const a4 = pitchTemplate(69, 44100)
    expect(argmax(a4)).toBe(48)
    expect(a4[48]).toBe(1)
    // The octave partial lands 12 semitones up, the fifth above it 19 up.
    expect(a4[48 + 12]!).toBeGreaterThan(0.3)
    expect(a4[48 + 12]!).toBeLessThan(0.7)
    expect(a4[48 + 19]!).toBeGreaterThan(0.15)
    expect(a4[48 + 12]!).toBeGreaterThan(a4[48 + 19]!)
    // Nothing a tritone away.
    expect(a4[48 + 6]!).toBeLessThan(0.01)
  })

  it('bin at 48 kHz as the analyzer does', () => {
    expect(argmax(pitchTemplate(81, 48000))).toBe(60)
    expect(argmax(pitchTemplate(100, 48000))).toBe(79)
    expect(argmax(pitchTemplate(60, 48000))).toBe(39)
    // Far below middle C the FFT bins are wider than semitones: the fundamental may land in a
    // neighbor and the template leans on its partials; live frames are binned the same way.
    expect(Math.abs(argmax(pitchTemplate(40, 48000)) - 19)).toBeLessThanOrEqual(12)
  })

  it('keeps neighboring semitones apart in the middle of the keyboard', () => {
    const cosine = (a: Float64Array, b: Float64Array): number => {
      let dot = 0
      let na = 0
      let nb = 0
      for (let p = 0; p < SEMITONES; p++) {
        dot += a[p]! * b[p]!
        na += a[p]! ** 2
        nb += b[p]! ** 2
      }
      return dot / Math.sqrt(na * nb)
    }
    for (const midi of [60, 67, 72, 79]) {
      const t = pitchTemplate(midi, 48000)
      expect(cosine(t, pitchTemplate(midi + 1, 48000))).toBeLessThan(0.5)
      expect(cosine(t, pitchTemplate(midi + 2, 48000))).toBeLessThan(0.2)
    }
  })
})

describe('attackTemplates', () => {
  const model = buildScore({
    notes: [
      { at: 0, midi: 60 },
      { at: 0, midi: 64 },
      { at: 1, midi: 60 },
      { at: 2, midi: 64 },
      { at: 2, midi: 60 },
    ],
  })

  it('sum the pitches of a group, sparsely', () => {
    const groups = attackGroups(model)
    const templates = attackTemplates(groups, 44100)
    expect(templates.length).toBe(3)
    const [chord, single] = templates
    expect(chord!.index.length).toBeGreaterThan(single!.index.length)
    expect(chord!.index.length).toBeLessThan(SEMITONES)
    const c4 = pitchTemplate(60, 44100)
    const e4 = pitchTemplate(64, 44100)
    chord!.index.forEach((p, i) => expect(chord!.value[i]).toBeCloseTo(c4[p]! + e4[p]!, 5))
    for (let i = 1; i < chord!.index.length; i++) expect(chord!.index[i]!).toBeGreaterThan(chord!.index[i - 1]!)
  })

  it('share one template between groups of the same pitches', () => {
    const templates = attackTemplates(attackGroups(model), 44100)
    expect(templates[2]).toBe(templates[0])
    expect(templates[1]).not.toBe(templates[0])
  })
})
