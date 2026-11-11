import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { buildScore } from '../engine/testkit'
import type { ScoreModel } from '../model/score'
import { ZERO, rat, toNumber } from '../music/rational'
import { perform, scoreNotes, sustainSpans } from './evaluate'

describe('sustainSpans', () => {
  const model = (marks: { at: number; type: 'start' | 'stop' | 'change' | 'continue' }[]): ScoreModel =>
    ({
      totalDuration: rat(4, 1),
      pedals: marks.map((m) => ({ at: rat(m.at, 8), occ: 0, kind: 'sustain', type: m.type })),
    }) as unknown as ScoreModel

  it('pairs starts with stops, splits at changes and closes an open pedal at the end', () => {
    const spans = sustainSpans(
      model([
        { at: 0, type: 'start' },
        { at: 4, type: 'change' },
        { at: 6, type: 'stop' },
        { at: 10, type: 'start' },
      ]),
    )
    expect(spans.map(([a, b]) => [toNumber(a), toNumber(b)])).toEqual([
      [0, 0.5],
      [0.5, 0.75],
      [1.25, 4],
    ])
  })

  it('ignores stops without a start and continues', () => {
    expect(
      sustainSpans(
        model([
          { at: 2, type: 'stop' },
          { at: 3, type: 'continue' },
        ]),
      ),
    ).toEqual([])
  })
})

describe('scoreNotes', () => {
  it('lists sounding notes in seconds at the multiplier, ties merged, cue notes skipped', async () => {
    const { model } = (await importFixture('ties.musicxml')).package
    const notes = scoreNotes(model, model.tempo)
    expect(notes.length).toBe(model.notes.filter((n) => !n.tieContinuation && !n.cue && !n.grace).length)
    for (let i = 1; i < notes.length; i++) expect(notes[i]!.start).toBeGreaterThanOrEqual(notes[i - 1]!.start)
    const twice = scoreNotes(model, model.tempo, 2)
    expect(twice[twice.length - 1]!.start).toBeCloseTo(notes[notes.length - 1]!.start / 2, 6)
  })

  it('holds a note released under a marked sustain pedal until the pedal lifts', () => {
    const base = buildScore({
      tempo: { bpm: 60 },
      notes: [
        { at: 0, dur: 1, midi: 60 },
        { at: 1, dur: 1, midi: 64 },
      ],
    })
    const model = {
      ...base,
      pedals: [
        { at: ZERO, occ: 0, kind: 'sustain', type: 'start' },
        { at: rat(1, 2), occ: 0, kind: 'sustain', type: 'stop' },
      ],
    } as ScoreModel
    const [c, e] = scoreNotes(model, model.tempo, 1, { pedal: true })
    expect(c!.end).toBeCloseTo(2, 6)
    expect(e!.end).toBeCloseTo(2, 6)
    const [plain] = scoreNotes(model, model.tempo)
    expect(plain!.end).toBeCloseTo(1, 6)
  })
})

describe('perform', () => {
  // Quarter = 60: four quarter notes, one per second.
  const model = buildScore({ tempo: { bpm: 60 }, notes: [60, 62, 64, 65].map((midi, at) => ({ at, dur: 1, midi })) })
  const exact = { jitter: 0, lead: 1 }

  it('plays the score at the factor after the lead, one onset per group', () => {
    const perf = perform(model, model.tempo, { factor: 2, ...exact })
    expect(perf.onsets.map((o) => o.position)).toEqual([0, 0.25, 0.5, 0.75])
    perf.onsets.forEach((o, k) => expect(o.time).toBeCloseTo(1 + k / 2, 2))
    expect(perf.notes.length).toBe(4)
    expect(perf.mistakes).toEqual([])
  })

  it('stops before a group: released keys end there, held keys ring through', () => {
    const lifted = perform(model, model.tempo, { factor: 1, ...exact, hesitations: [{ at: 0.5, seconds: 3 }] })
    expect(lifted.onsets[2]!.time).toBeCloseTo(6, 2)
    expect(lifted.onsets[3]!.time).toBeCloseTo(7, 2)
    // The second note would have ended as the third began: it ends where the stop begins.
    expect(lifted.notes[1]!.end).toBeCloseTo(3, 2)
    const held = perform(model, model.tempo, {
      factor: 1,
      ...exact,
      hesitations: [{ at: 0.5, seconds: 3, held: true }],
    })
    expect(held.onsets[2]!.time).toBeCloseTo(6, 2)
    expect(held.notes[1]!.end).toBeCloseTo(6, 2)
    expect(held.notes[0]!.end).toBeCloseTo(2, 2)
  })

  it('replaces or drops a note at the given fractions and reports when', () => {
    const perf = perform(model, model.tempo, { factor: 1, ...exact, wrongAt: [0.25], missingAt: [0.75] })
    expect(perf.notes.map((n) => n.midi).length).toBe(3)
    expect(perf.notes[1]!.midi).not.toBe(62)
    expect(perf.onsets.map((o) => o.position)).toEqual([0, 0.25, 0.5])
    expect(perf.mistakes.length).toBe(2)
  })
})
