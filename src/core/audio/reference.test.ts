import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { ZERO, rat, toNumber } from '../music/rational'
import type { ScoreModel } from '../model/score'
import { buildScore } from '../engine/testkit'
import { HOP_SEC, SEMITONES } from './features'
import {
  LEAD_FRAMES,
  buildReference,
  decaySec,
  frameAt,
  framePosition,
  pitchTemplate,
  referenceNotes,
  sustainSpans,
} from './reference'

function argmax(v: ArrayLike<number>, n = SEMITONES): number {
  let best = 0
  for (let p = 1; p < n; p++) if (v[p]! > v[best]!) best = p
  return best
}

describe('pitch templates', () => {
  it('put the fundamental in its semitone, sum to one and fade with pitch', () => {
    const a4 = pitchTemplate(69, 44100)
    expect(argmax(a4)).toBe(48)
    let sum = 0
    for (let p = 0; p < SEMITONES; p++) sum += a4[p]!
    expect(sum).toBeCloseTo(1, 9)
    // The octave partial lands 12 semitones up, the fifth 19 up.
    expect(a4[48 + 12]).toBeGreaterThan(0)
    expect(a4[48 + 19]).toBeGreaterThan(0)
    expect(decaySec(21)).toBeGreaterThan(decaySec(108))
  })

  it('bins at 48 kHz the same way the live extractor does', () => {
    expect(argmax(pitchTemplate(81, 48000))).toBe(60)
    expect(argmax(pitchTemplate(100, 48000))).toBe(79)
    // Below about A4 the 23 Hz FFT bins are wider than a semitone: the fundamental may land in a
    // neighbor and the template leans on its partials; live frames are binned the same way.
    expect(argmax(pitchTemplate(57, 48000))).toBe(35)
    expect(Math.abs(argmax(pitchTemplate(40, 48000)) - 19)).toBeLessThanOrEqual(3)
  })
})

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

describe('referenceNotes', () => {
  it('lists sounding notes in seconds at the multiplier, ties merged, cue notes skipped', async () => {
    const { model } = (await importFixture('ties.musicxml')).package
    const notes = referenceNotes(model, model.tempo, 1)
    expect(notes.length).toBe(model.notes.filter((n) => !n.tieContinuation && !n.cue).length)
    for (let i = 1; i < notes.length; i++) expect(notes[i]!.start).toBeGreaterThanOrEqual(notes[i - 1]!.start)
    const twice = referenceNotes(model, model.tempo, 2)
    expect(twice[twice.length - 1]!.start).toBeCloseTo(notes[notes.length - 1]!.start / 2, 6)
    const tied = model.notes.find((n) => n.tieContinuation !== undefined && !n.tieContinuation)
    if (tied) {
      const ref = notes.find((n) => n.position === toNumber(tied.onset) && n.midi === tied.midi)!
      expect(ref.end - ref.start).toBeGreaterThan(0)
    }
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
    const [c, e] = referenceNotes(model, model.tempo, 1)
    expect(c!.end).toBeCloseTo(2, 6)
    expect(e!.end).toBeCloseTo(2, 6)
    const [plain] = referenceNotes(model, model.tempo, 1, { pedal: false })
    expect(plain!.end).toBeCloseTo(1, 6)
  })
})

describe('buildReference', () => {
  const model = buildScore({
    tempo: { bpm: 120 },
    // Quarters: C4, G4, then a half-note C5 at quarter = 120 (0.5 s per quarter, 2 s in all).
    notes: [
      { at: 0, dur: 1, midi: 60 },
      { at: 1, dur: 1, midi: 67 },
      { at: 2, dur: 2, midi: 72 },
    ],
  })

  it('maps frames to positions and back, with a silent lead-in', () => {
    const ref = buildReference(model, model.tempo, 1, 44100)
    expect(ref.lead).toBe(LEAD_FRAMES)
    expect(frameAt(ref, ZERO)).toBe(ref.lead)
    expect(framePosition(ref, ref.lead)).toBe(0)
    expect(framePosition(ref, 0)).toBeLessThan(0)
    // Quarter = 120: a quarter note lasts 0.5 s = 50 frames.
    expect(frameAt(ref, rat(1, 4))).toBe(ref.lead + 50)
    expect(framePosition(ref, ref.lead + 50)).toBeCloseTo(0.25, 9)
    expect(framePosition(ref, ref.count - 1)).toBe(toNumber(model.totalDuration))
    expect(ref.count).toBe(ref.lead + Math.ceil((2 + 0.24) / HOP_SEC) + 50)
    // The 46 ms window straddles the first attack from two frames before it.
    for (let j = 0; j < ref.lead - 2; j++) expect(ref.onset[j]).toBe(0)
    expect(ref.onset[ref.lead - 2]).toBeGreaterThan(0)
  })

  it('sounds each note in its semitone from its attack and follows the multiplier', () => {
    const ref = buildReference(model, model.tempo, 1, 44100)
    const lse = (j: number) =>
      ref.frames.subarray((j * ref.frames.length) / ref.count, (j + 1) * (ref.frames.length / ref.count))
    expect(argmax(lse(ref.lead + 10))).toBe(60 - 21)
    expect(argmax(lse(ref.lead + 60))).toBe(67 - 21)
    expect(argmax(lse(ref.lead + 110))).toBe(72 - 21)
    expect(ref.onset[ref.lead + 50]).toBeGreaterThan(ref.onset[ref.lead + 30]!)
    const fast = buildReference(model, model.tempo, 2, 44100)
    expect(argmax(fast.frames.subarray((fast.lead + 30) * (fast.frames.length / fast.count)))).toBe(67 - 21)
    expect(fast.count).toBeLessThan(ref.count)
  })

  it('needs a tempo', () => {
    const untimed = { ...model, tempo: { ...model.tempo, segments: [] } } as ScoreModel
    expect(() => buildReference(untimed, untimed.tempo, 1, 44100)).toThrow(/tempo/)
  })
})
