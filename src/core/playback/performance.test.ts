import { describe, expect, it } from 'vitest'
import { rat, toString } from '../music/rational'
import { PEDAL_CHANGE_GAP_SEC, buildPerformance, passageRange } from './performance'
import { makeModel, q } from './testkit'
import type { NoteOnEvent, PerformanceEvent } from './types'

const ons = (evs: readonly PerformanceEvent[]): NoteOnEvent[] => evs.filter((e): e is NoteOnEvent => e.kind === 'on')
const offFor = (evs: readonly PerformanceEvent[], voice: number) =>
  evs.find((e) => e.kind === 'off' && e.voice === voice)!
const pos = (e: PerformanceEvent): string => toString(e.position)

/** Replays events like a receiving instrument with per-key ownership counts. */
function soundingSpans(evs: readonly PerformanceEvent[], note: number): Array<[string, string]> {
  let count = 0
  let start = ''
  const spans: Array<[string, string]> = []
  for (const e of evs) {
    if (e.kind === 'cc' || e.note !== note) continue
    if (e.kind === 'on') {
      if (count === 0) start = pos(e)
      count++
    } else if (--count === 0) spans.push([start, pos(e)])
  }
  return spans
}

describe('buildPerformance: automatic part selection (spec "Hand practice")', () => {
  const model = makeModel({
    notes: [
      { at: '0', dur: '1/4', midi: 72, hand: 'R' },
      { at: '0', dur: '1/4', midi: 48, hand: 'L' },
    ],
  })

  it('right-hand practice sends the left part, left-hand practice the right part', () => {
    expect(ons(buildPerformance(model, { hands: 'right', sendPedals: false })).map((e) => e.note)).toEqual([48])
    expect(ons(buildPerformance(model, { hands: 'left', sendPedals: false })).map((e) => e.note)).toEqual([72])
  })

  it('both-hands practice sends no automatic part', () => {
    expect(buildPerformance(model, { hands: 'both', sendPedals: true })).toEqual([])
  })

  it('Preview sends both parts, with optional left/right listening filters', () => {
    expect(ons(buildPerformance(model, { hands: 'none', sendPedals: true })).map((e) => e.note)).toEqual([48, 72])
    const left = buildPerformance(model, { hands: 'none', sendPedals: true, listenFilter: 'left' })
    expect(ons(left).map((e) => e.note)).toEqual([48])
    const right = buildPerformance(model, { hands: 'none', sendPedals: true, listenFilter: 'right' })
    expect(ons(right).map((e) => e.note)).toEqual([72])
  })
})

describe('buildPerformance: notes', () => {
  it('plays a tie chain as one attack lasting the whole tied duration', () => {
    const model = makeModel({
      notes: [
        { at: '1/2', dur: '1/2', midi: 48, hand: 'L', tieToNext: true },
        { at: '1', dur: '1/4', midi: 48, hand: 'L' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'right', sendPedals: false })
    expect(evs.map((e) => [e.kind, pos(e)])).toEqual([
      ['on', '1/2'],
      ['off', '5/4'],
    ])
  })

  it('scales velocities by the accompaniment level, clamped to 1..127; level 0 mutes notes', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/4', midi: 48, hand: 'L', velocity: 80 },
        { at: '1/4', dur: '1/4', midi: 50, hand: 'L', velocity: 1 },
      ],
    })
    expect(
      ons(buildPerformance(model, { hands: 'right', sendPedals: false, accompanimentLevel: 0.5 })).map(
        (e) => e.velocity,
      ),
    ).toEqual([40, 1])
    expect(buildPerformance(model, { hands: 'right', sendPedals: false, accompanimentLevel: 0 })).toEqual([])
    expect(() => buildPerformance(model, { hands: 'right', sendPedals: false, accompanimentLevel: -1 })).toThrow()
  })

  it('suppresses an automatic attack in unison with a learner attack at the same onset', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/4', midi: 60, hand: 'R' },
        { at: '0', dur: '1/2', midi: 60, hand: 'L' },
        { at: '0', dur: '1/2', midi: 48, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 60, hand: 'L' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'right', sendPedals: false })
    expect(ons(evs).map((e) => [pos(e), e.note])).toEqual([
      ['0', 48],
      ['1/4', 60],
    ])
  })

  it('suppresses an automatic unison with a learner note reattacked at the range start', () => {
    const model = makeModel({
      notes: [
        { at: '3/4', dur: '1/2', midi: 60, hand: 'R' },
        { at: '1', dur: '1/4', midi: 60, hand: 'L' },
      ],
      measures: 2,
    })
    const evs = buildPerformance(model, {
      hands: 'right',
      sendPedals: false,
      range: passageRange(model, { fromOcc: 1, toOcc: 1 }),
    })
    expect(ons(evs)).toEqual([])
  })

  it('Preview merges simultaneous unisons into one attack (loudest velocity, latest release)', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/4', midi: 60, hand: 'R', velocity: 70 },
        { at: '0', dur: '1/2', midi: 60, hand: 'L', velocity: 90 },
      ],
    })
    const evs = buildPerformance(model, { hands: 'none', sendPedals: false })
    const on = ons(evs)
    expect(on).toHaveLength(1)
    expect(on[0]!.velocity).toBe(90)
    expect(on[0]!.notes).toEqual([0, 1])
    expect(pos(offFor(evs, on[0]!.voice))).toBe('1/2')
  })

  it('keeps overlapping same-pitch notes as separate pairs so the older release never cuts the newer note', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1', midi: 48, hand: 'L', voice: '5' },
        { at: '1/4', dur: '1/4', midi: 48, hand: 'L', voice: '6' },
        { at: '1/2', dur: '1', midi: 50, hand: 'L', voice: '5' },
        { at: '3/4', dur: '1/2', midi: 50, hand: 'L', voice: '6' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'right', sendPedals: false })
    expect(ons(evs)).toHaveLength(4)
    expect(soundingSpans(evs, 48)).toEqual([['0', '1']])
    expect(soundingSpans(evs, 50)).toEqual([['1/2', '3/2']])
  })

  it('orders a release before a repeated attack of the same pitch at the same position', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/4', midi: 48, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 48, hand: 'L' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'right', sendPedals: false })
    expect(evs.map((e) => `${e.kind}@${pos(e)}`)).toEqual(['on@0', 'off@1/4', 'on@1/4', 'off@1/2'])
  })

  it('keeps roll reference offsets on attacks and notated ending times on releases', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/2', midi: 45, hand: 'L', refOffsetSec: 0 },
        { at: '0', dur: '1/2', midi: 52, hand: 'L', refOffsetSec: 0.06 },
        { at: '0', dur: '1/2', midi: 60, hand: 'L', refOffsetSec: 0.12 },
      ],
    })
    const evs = buildPerformance(model, { hands: 'right', sendPedals: false })
    expect(ons(evs).map((e) => e.offsetSec)).toEqual([0, 0.06, 0.12])
    expect(evs.filter((e) => e.kind === 'off').map((e) => [pos(e), e.offsetSec])).toEqual([
      ['1/2', 0],
      ['1/2', 0],
      ['1/2', 0],
    ])
  })

  it('clips to the range: attacks a note sounding at the start, releases at the end, drops the rest', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/4', midi: 40, hand: 'L' },
        { at: '1/2', dur: '1/2', midi: 48, hand: 'L', tieToNext: true, refOffsetSec: 0.05 },
        { at: '1', dur: '1/4', midi: 48, hand: 'L' },
        { at: '7/4', dur: '1/2', midi: 50, hand: 'L' },
        { at: '2', dur: '1/4', midi: 52, hand: 'L' },
      ],
      measures: 3,
    })
    const range = passageRange(model, { fromOcc: 1, toOcc: 1 })
    expect(range).toEqual({ start: rat(1), end: rat(2) })
    const evs = buildPerformance(model, { hands: 'right', sendPedals: false, range })
    expect(evs.map((e) => `${e.kind}${e.kind === 'cc' ? '' : e.note}@${pos(e)}+${e.offsetSec}`)).toEqual([
      'on48@1+0',
      'off48@5/4+0',
      'on50@7/4+0',
      'off50@2+0',
    ])
  })

  it('skips grace notes (zero-length, unsupported region)', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '0', midi: 50, hand: 'L', grace: true },
        { at: '0', dur: '1/4', midi: 48, hand: 'L' },
      ],
    })
    expect(ons(buildPerformance(model, { hands: 'right', sendPedals: false })).map((e) => e.note)).toEqual([48])
  })

  it('skips cue notes (engraved, never sounded; I13)', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/4', midi: 50, hand: 'L', cue: true },
        { at: '0', dur: '1/4', midi: 48, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 72, hand: 'R', cue: true },
      ],
    })
    expect(ons(buildPerformance(model, { hands: 'right', sendPedals: false })).map((e) => e.note)).toEqual([48])
    expect(ons(buildPerformance(model, { hands: 'none', sendPedals: false })).map((e) => e.note)).toEqual([48])
  })

  it('gives every attack a unique voice paired with exactly one release', () => {
    const model = makeModel({
      notes: Array.from(
        { length: 16 },
        (_, i) => ({ at: q(i % 8), dur: q(1), midi: 40 + (i % 3), hand: i % 2 ? 'L' : 'R' }) as const,
      ),
    })
    const evs = buildPerformance(model, { hands: 'none', sendPedals: false })
    const voices = ons(evs).map((e) => e.voice)
    expect(new Set(voices).size).toBe(voices.length)
    for (const v of voices) expect(evs.filter((e) => e.kind === 'off' && e.voice === v)).toHaveLength(1)
  })
})

describe('buildPerformance: pedals', () => {
  const notes = [{ at: '0', dur: '1/4', midi: 48, hand: 'L' }] as const
  const ccs = (evs: readonly PerformanceEvent[]) =>
    evs
      .filter((e) => e.kind === 'cc')
      .map((e) => (e.kind === 'cc' ? `${e.controller}:${e.value}@${pos(e)}+${e.offsetSec}` : ''))

  it('sends sustain start/stop and a change as up then down shortly after', () => {
    const model = makeModel({
      notes: [...notes],
      measures: 3,
      pedals: [
        { at: '0', type: 'start' },
        { at: '1', type: 'change' },
        { at: '2', type: 'stop' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'none', sendPedals: true })
    expect(ccs(evs)).toEqual(['64:127@0+0', '64:0@1+0', `64:127@1+${PEDAL_CHANGE_GAP_SEC}`, '64:0@2+0'])
  })

  it('maps sostenuto and soft pedals to CC 66 and 67 and keeps continuous values', () => {
    const model = makeModel({
      notes: [...notes],
      pedals: [
        { at: '0', kind: 'sostenuto', type: 'start' },
        { at: '0', kind: 'soft', type: 'start', value: 90 },
        { at: '1/2', kind: 'sostenuto', type: 'stop' },
        { at: '1/2', kind: 'soft', type: 'stop' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'none', sendPedals: true })
    expect(ccs(evs)).toEqual(['66:127@0+0', '67:90@0+0', '66:0@1/2+0', '67:0@1/2+0'])
  })

  it('treats stop + start at one position as a change, and start while down as a re-pedal', () => {
    const model = makeModel({
      notes: [...notes],
      measures: 2,
      pedals: [
        { at: '0', type: 'start' },
        { at: '1/2', type: 'stop' },
        { at: '1/2', type: 'start' },
        { at: '1', type: 'start' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'none', sendPedals: true })
    expect(ccs(evs)).toEqual([
      '64:127@0+0',
      '64:0@1/2+0',
      `64:127@1/2+${PEDAL_CHANGE_GAP_SEC}`,
      '64:0@1+0',
      `64:127@1+${PEDAL_CHANGE_GAP_SEC}`,
      '64:0@2+0',
    ])
  })

  it('starts a passage with the pedal state in force and releases pedals still down at its end', () => {
    const model = makeModel({
      notes: [...notes],
      measures: 3,
      pedals: [
        { at: '1/2', type: 'start' },
        { at: '1', type: 'stop' },
        { at: '1', type: 'start' },
        { at: '5/2', type: 'stop' },
      ],
    })
    const evs = buildPerformance(model, {
      hands: 'none',
      sendPedals: true,
      range: passageRange(model, { fromOcc: 1, toOcc: 1 }),
    })
    expect(ccs(evs)).toEqual(['64:127@1+0', '64:0@2+0'])
  })

  it('sends no pedals in hand practice unless the route allows it', () => {
    const model = makeModel({
      notes: [...notes],
      pedals: [
        { at: '0', type: 'start' },
        { at: '1/2', type: 'stop' },
      ],
    })
    expect(ccs(buildPerformance(model, { hands: 'right', sendPedals: false }))).toEqual([])
    expect(ccs(buildPerformance(model, { hands: 'right', sendPedals: true }))).toEqual(['64:127@0+0', '64:0@1/2+0'])
  })

  it('orders releases, pedal up, pedal down, attacks at one instant', () => {
    const model = makeModel({
      notes: [
        { at: '0', dur: '1/2', midi: 48, hand: 'L' },
        { at: '1/2', dur: '1/2', midi: 50, hand: 'L' },
      ],
      pedals: [
        { at: '0', type: 'start' },
        { at: '1/2', type: 'stop' },
        { at: '1/2', kind: 'soft', type: 'start' },
      ],
    })
    const evs = buildPerformance(model, { hands: 'none', sendPedals: true }).filter(
      (e) => pos(e) === '1/2' && e.offsetSec === 0,
    )
    expect(evs.map((e) => e.kind + (e.kind === 'cc' ? `${e.controller}:${e.value}` : e.note))).toEqual([
      'off48',
      'cc64:0',
      'cc67:127',
      'on50',
    ])
  })
})

describe('passageRange', () => {
  it('maps inclusive occurrences to [start, end) and null to the whole piece', () => {
    const model = makeModel({ notes: [{ at: '0', dur: '1/4', midi: 60 }], measures: 3, pickup: '1/4' })
    expect(passageRange(model, null)).toEqual({ start: rat(0), end: rat(9, 4) })
    expect(passageRange(model, { fromOcc: 1, toOcc: 2 })).toEqual({ start: rat(1, 4), end: rat(9, 4) })
    expect(() => passageRange(model, { fromOcc: 2, toOcc: 1 })).toThrow()
  })
})
