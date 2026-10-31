/**
 * Note-level loops (DECISIONS U19, U21; H7): a passage whose edges are note onsets inside its
 * boundary bars. The timeline, its timing and its comparison context cover only `[start, end)`.
 */
import { describe, expect, it } from 'vitest'
import { contextKey, measureContextKey } from '../model/practice'
import { passageRange, buildPerformance } from '../playback/performance'
import { EngineDriver, buildScore, quarters } from './testkit'
import { buildTimeline, transportGates, type TimelineOptions } from './timeline'

const C3 = 48
const E3 = 52
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67

// Bar 1: C4 D4 E4 G4 quarters over a C3 whole note; bar 2: G4 half, E4, then G4 tied into bar 3;
// bar 3: the tie continuation, then E3 on beat 3 (left hand).
const m = buildScore({
  notes: [
    { at: 0, midi: C4 },
    { at: 1, midi: D4 },
    { at: 2, midi: E4 },
    { at: 3, midi: G4 },
    { at: 0, dur: 4, midi: C3, hand: 'L' },
    { at: 4, dur: 2, midi: G4 },
    { at: 6, midi: E4 },
    { at: 7, dur: 1, midi: G4 },
    { at: 8, dur: 1, midi: G4, cont: true },
    { at: 10, midi: E3, hand: 'L' },
  ],
  bars: 3,
})

const opts = (hands: TimelineOptions['hands'], range: TimelineOptions['range']): TimelineOptions => ({
  hands,
  range,
  multiplier: 1,
})

describe('note-level loop timelines', () => {
  it('a loop inside one bar keeps only its onsets, timed from its own start', () => {
    const t = buildTimeline(m, opts('right', { fromOcc: 0, toOcc: 0, start: quarters(1), end: quarters(3) }))
    expect(t.start).toEqual(quarters(1))
    expect(t.end).toEqual(quarters(3))
    expect(t.groups.map((g) => g.pitches)).toEqual([[D4], [E4]])
    expect(t.groups[0]!.onsetSec).toBe(0)
    // Quarter = 1 s at the default tempo: two quarters of notated time, one between the attacks.
    expect(t.notatedDurationSec).toBeCloseTo(2)
    expect(t.expectedSpanSec).toBeCloseTo(1)
    expect(t.context.passage).toEqual({ fromOcc: 0, toOcc: 0, start: quarters(1), end: quarters(3) })
    expect(t.measures).toEqual([{ occ: 0, groups: [0, 1], partial: true }])
    expect(transportGates(t)).toEqual([quarters(1), quarters(2)])
  })

  it('a held note sounding at a mid-bar loop start is a boundary reattack', () => {
    const t = buildTimeline(m, opts('both', { fromOcc: 0, toOcc: 0, start: quarters(2) }))
    expect(t.groups[0]!.pitches).toEqual([C3, E4])
    expect(t.groups[0]!.boundaryNotes.map((i) => m.notes[i]!.midi)).toEqual([C3])
    expect(t.groups.map((g) => g.position)).toEqual([quarters(2), quarters(3)])
  })

  it('a tie crossing the loop end is attacked inside; bars stay whole when the hands play nothing more', () => {
    const t = buildTimeline(m, opts('right', { fromOcc: 1, toOcc: 2, end: quarters(9) }))
    expect(t.groups.map((g) => g.pitches)).toEqual([[G4], [E4], [G4]])
    const head = m.notes.findIndex((n) => n.midi === G4 && n.occ === 1 && n.onset.n === 7)
    expect(t.noteToGroup.get(head)).toBe(2)
    // The continuation in bar 3 is inside the loop: its label still reveals the tie head's group.
    const cont = m.notes.findIndex((n) => n.tieContinuation)
    expect(t.labelToGroup.get(cont)).toBe(2)
    // The right hand attacks nothing else in bar 3, so the bar is not cut for it.
    expect(t.measures.map((x) => [x.occ, x.partial])).toEqual([
      [1, false],
      [2, false],
    ])
    // The left hand's E3 lies after the end: bar 3 is partial for the left hand.
    const left = buildTimeline(m, opts('left', { fromOcc: 1, toOcc: 2, end: quarters(9) }))
    expect(left.measures.find((x) => x.occ === 2)!.partial).toBe(true)
  })

  it('accompaniment positions, performance events and timing issues are limited to the loop', () => {
    const range = { fromOcc: 0, toOcc: 0, start: quarters(1), end: quarters(3) }
    const t = buildTimeline(m, opts('right', range))
    // The left hand's whole note began before the loop: no automatic attack position inside it.
    expect(t.automatic).toEqual([])
    // The transport plays it from the loop start (boundary attack) and releases it at the loop end.
    const bounds = passageRange(m, range)
    expect(bounds).toEqual({ start: quarters(1), end: quarters(3) })
    const events = buildPerformance(m, { hands: 'right', range: bounds, sendPedals: false, accompanimentLevel: 1 })
    const notes = events.filter((e) => e.kind === 'on' || e.kind === 'off')
    expect(notes.map((e) => [e.kind, e.position])).toEqual([
      ['on', quarters(1)],
      ['off', quarters(3)],
    ])
    const withIssue = buildScore({
      notes: [0, 1, 2, 3].map((at) => ({ at, midi: C4 + at })),
      timingIssues: [{ kind: 'fermata', occ: 0, at: 0.5, text: 'fermata' }],
    })
    const inside = buildTimeline(withIssue, opts('both', { fromOcc: 0, toOcc: 0, start: quarters(1) }))
    expect(inside.timingIssues).toEqual([])
    expect(inside.expectedSpanSec).toBeCloseTo(2)
  })

  it('a final roll keeps its spread inside a note-level loop', () => {
    const rolled = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: D4 },
        { at: 2, midi: C3, hand: 'L', roll: 1, offset: 0 },
        { at: 2, midi: E4, roll: 1, offset: 0.1 },
        { at: 3, midi: F4 },
      ],
    })
    const t = buildTimeline(rolled, opts('both', { fromOcc: 0, toOcc: 0, start: quarters(1), end: quarters(3) }))
    expect(t.groups.map((g) => g.pitches)).toEqual([[D4], [C3, E4]])
    expect(t.expectedSpanSec).toBeCloseTo(1.1)
  })

  it('edges on barlines are whole bars; edges outside their bars are rejected', () => {
    const whole = buildTimeline(m, opts('both', { fromOcc: 1, toOcc: 1, start: quarters(4), end: quarters(8) }))
    expect(whole.range).toEqual({ fromOcc: 1, toOcc: 1 })
    expect(whole.context.passage).toEqual({ fromOcc: 1, toOcc: 1 })
    expect(whole.measures[0]!.partial).toBe(false)
    expect(() => buildTimeline(m, opts('both', { fromOcc: 1, toOcc: 1, start: quarters(1) }))).toThrow(RangeError)
    expect(() =>
      buildTimeline(m, opts('both', { fromOcc: 0, toOcc: 0, start: quarters(3), end: quarters(2) })),
    ).toThrow(RangeError)
  })

  it('names the loop in blocker messages', () => {
    const t = buildTimeline(m, opts('left', { fromOcc: 1, toOcc: 1, start: quarters(5), end: quarters(7) }))
    expect(t.blockers[0]!.message).toMatch(/left-hand part has no notes to play in bar 2, beat 2\./)
  })
})

describe('note-level loop records and comparison keys', () => {
  it('whole-bar keys are unchanged; a note-level loop is its own comparison context', () => {
    const whole = buildTimeline(m, opts('both', { fromOcc: 0, toOcc: 1 }))
    const sub = buildTimeline(m, opts('both', { fromOcc: 0, toOcc: 1, start: quarters(1) }))
    const key = contextKey({ ...whole.context, transport: 'free' })
    expect(key).toBe(
      [
        'test-score-v1',
        '0-1',
        'both',
        whole.context.handsId,
        '0/1@60',
        '1.0000',
        m.meta.rollPolicyVersion,
        'free',
      ].join('|') + `|${whole.context.matchingRules}`,
    )
    const subKey = contextKey({ ...sub.context, transport: 'free' })
    expect(subKey).not.toBe(key)
    expect(subKey).toContain('|0-1@1/4..|')
    // Bars are bars in any passage: the measure context is shared.
    expect(measureContextKey({ ...sub.context, transport: 'free' })).toBe(
      measureContextKey({ ...whole.context, transport: 'free' }),
    )
  })

  it('a scored note-level loop records partial boundary bars and its exact passage', () => {
    const t = buildTimeline(m, opts('right', { fromOcc: 0, toOcc: 1, start: quarters(2), end: quarters(6) }))
    expect(t.groups.map((g) => g.pitches)).toEqual([[E4], [G4], [G4]])
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, timeOrigin: 0, transport: 'free' })
    d.tap(E4)
    d.now += 1000
    d.tap(G4)
    d.now += 1000
    d.tap(G4)
    const [r] = d.records()
    expect(r).toMatchObject({ completion: 'completed', passed: true, groupsTotal: 3, completionTimeSec: 2 })
    expect(r!.expectedTimeSec).toBeCloseTo(2)
    expect(r!.notatedDurationSec).toBeCloseTo(4)
    expect(r!.context.passage).toEqual({ fromOcc: 0, toOcc: 1, start: quarters(2), end: quarters(6) })
    expect(r!.contextKey).toContain('|0-1@1/2..3/2|')
    // Bar 1 lost C4 and D4, bar 2 its E4: both traversals are partial, never complete (H7).
    expect(r!.measures.map((x) => [x.occ, x.complete])).toEqual([
      [0, false],
      [1, false],
    ])
  })
})
