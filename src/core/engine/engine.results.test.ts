/**
 * Attempt records, measure traversals, abandonment and label assistance
 * (spec: "Results and timing", "Detecting recurring mistakes", "Persistent score labels";
 * acceptance rows Label assistance, Persistent and temporary labels, Tempo mathematics).
 */
import { describe, expect, it } from 'vitest'
import { handAssignmentId, measureContextKey } from '../model/practice'
import { rat } from '../music/rational'
import type { EngineConfig } from './types'
import type { ScoreSpec } from './testkit'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { TimelineOptions } from './timeline'

const C3 = 48
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const A4 = 69
const B4 = 71
const C5 = 72

/** Two 4/4 bars of quarters: C D E F | G A B C. */
const twoBars: ScoreSpec = { notes: [C4, D4, E4, F4, G4, A4, B4, C5].map((midi, at) => ({ at, midi })) }

function scored(
  spec: ScoreSpec = twoBars,
  over: Partial<EngineConfig> = {},
  options: Partial<TimelineOptions> = {},
): EngineDriver {
  const t = buildTimeline(buildScore(spec), {
    hands: 'both',
    range: { fromOcc: 0, toOcc: 1 },
    multiplier: 1,
    ...options,
  })
  return new EngineDriver(t, {
    mode: 'scored',
    pieceId: 'piece',
    prepared: true,
    timeOrigin: 1_700_000_000_000,
    ...over,
  })
}

function playAll(d: EngineDriver, pitches: readonly number[], stepMs = 1000): void {
  pitches.forEach((p, i) => {
    if (i > 0) d.now += stepMs
    d.tap(p)
  })
}

describe('AttemptRecord', () => {
  it('fills the comparison context, timing, onsets and per-measure traversals', () => {
    const d = scored()
    const created = d.now
    d.wait(4000)
    playAll(d, [C4, D4, E4, F4, G4, A4, B4, C5], 1000)
    const [r] = d.records()
    expect(r).toMatchObject({
      pieceId: 'piece',
      kind: 'scored',
      createdAt: 1_700_000_000_000 + created,
      completion: 'completed',
      wrongAttacks: 0,
      groupsTotal: 8,
      groupsFirstPass: 8,
      completionTimeSec: 7,
      expectedTimeSec: 7,
      notatedDurationSec: 8,
      passed: true,
    })
    expect(r!.context).toEqual({
      scoreVersionId: 'test-score-v1',
      passage: { fromOcc: 0, toOcc: 1 },
      hands: 'both',
      handsId: handAssignmentId(d.engine.timeline.model.hands),
      tempoMapId: '0/1@60',
      multiplier: 1,
      rollPolicy: d.engine.timeline.model.meta.rollPolicyVersion,
      transport: 'free',
      matchingRules: 'match-v2-early-grace-120ms',
    })
    expect(r!.contextKey).toContain('test-score-v1|0-1|both')
    expect(r!.onsets.map((o) => o.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(r!.measures.map((m) => [m.occ, m.complete])).toEqual([
      [0, true],
      [1, true],
    ])
    expect(r!.assistance).toMatchObject({ level: 'none', hintRequests: 0, autoHints: 0, keyboardShown: false })
    expect(d.of('measure')).toHaveLength(2)
  })

  it('completion time counts hesitation and recovery after the first press, not waiting before it', () => {
    const d = scored()
    d.wait(30_000)
    d.tap(C4)
    d.now += 5000
    d.tap(G4)
    d.now += 1000
    playAll(d, [D4, E4, F4, G4, A4, B4, C5], 500)
    const [r] = d.records()
    expect(r!.completionTimeSec).toBe(9)
    expect(r!.passed).toBe(false)
    expect(r!.groupsFirstPass).toBe(7)
    expect(r!.measures[0]).toMatchObject({ complete: true, wrongAttacks: 1, groupsWithErrors: 1 })
    expect(r!.measures[1]).toMatchObject({ complete: true, wrongAttacks: 0 })
  })

  it('assigns mistakes to the current expected onset and its measure', () => {
    const d = scored()
    playAll(d, [C4, D4, E4, F4], 100)
    d.tap(C3, C3)
    playAll(d, [G4, A4, B4, C5], 100)
    const [r] = d.records()
    expect(r!.measures.map((m) => m.wrongAttacks)).toEqual([0, 2])
  })

  it('a single onset group has no expected time', () => {
    const d = scored(
      {
        notes: [
          { at: 0, midi: C4 },
          { at: 0, midi: E4 },
        ],
      },
      {},
      { range: { fromOcc: 0, toOcc: 0 } },
    )
    d.tap(C4, E4)
    expect(d.records()[0]).toMatchObject({ completion: 'completed', expectedTimeSec: null, passed: true })
  })

  it('optional total completion-time tolerance joins the pass condition', () => {
    const fast = scored(twoBars, { passTimeTolerance: 0.1 })
    playAll(fast, [C4, D4, E4, F4, G4, A4, B4, C5], 1050)
    expect(fast.records()[0]).toMatchObject({ completionTimeSec: 7.35, passed: true })
    const slow = scored(twoBars, { passTimeTolerance: 0.1 })
    playAll(slow, [C4, D4, E4, F4, G4, A4, B4, C5], 1200)
    expect(slow.records()[0]).toMatchObject({ passed: false })
  })

  it('reading traversals carry mistakes and traversals but no timing', () => {
    const t = buildTimeline(buildScore(twoBars), { hands: 'both', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'piece' })
    playAll(d, [C4, D4, E4, F4, G4, A4, B4, C5])
    const [r] = d.records()
    expect(r).toMatchObject({ kind: 'reading', completion: 'completed', expectedTimeSec: null, passed: false })
    expect(r!.completionTimeSec).toBeUndefined()
    expect(r!.timingUnscoredReason).toMatch(/not timed/)
    expect(r!.measures).toHaveLength(2)
  })
})

describe('Acceptance: Tempo mathematics (records)', () => {
  const fourQuarters: ScoreSpec = { notes: [C4, D4, E4, F4].map((midi, at) => ({ at, midi })) }

  it('four quarter attacks at quarter = 60: 3 s expected, 4 s notated; 0.5× and 2× scale it', () => {
    for (const [multiplier, expected, notated] of [
      [1, 3, 4],
      [0.5, 6, 8],
      [2, 1.5, 2],
    ] as const) {
      const d = scored(fourQuarters, {}, { range: null, multiplier })
      playAll(d, [C4, D4, E4, F4])
      expect(d.records()[0]).toMatchObject({ expectedTimeSec: expected, notatedDurationSec: notated })
      expect(d.records()[0]!.context.multiplier).toBe(multiplier)
    }
  })

  it('a complete 6/8 bar at dotted quarter = 60 lasts 2 s', () => {
    const sixEight: ScoreSpec = {
      meter: [6, 8],
      tempo: { bpm: 60, unit: rat(3, 8) },
      notes: [
        { at: 0, dur: 1.5, midi: C4 },
        { at: 1.5, dur: 1.5, midi: D4 },
      ],
    }
    const d = scored(sixEight, {}, { range: null })
    playAll(d, [C4, D4])
    expect(d.records()[0]).toMatchObject({ notatedDurationSec: 2, expectedTimeSec: 1 })
  })
})

describe('Measure traversals', () => {
  it('an interruption leaves fully played bars complete and the current bar partial', () => {
    const d = scored()
    playAll(d, [C4, D4, E4, F4, G4], 100)
    d.engine.interrupt('suspend', d.now)
    const [r] = d.records()
    expect(r!.measures.map((m) => [m.occ, m.complete])).toEqual([
      [0, true],
      [1, false],
    ])
  })

  it('a bar entered but not played yields no evidence', () => {
    const d = scored()
    playAll(d, [C4, D4, E4, F4], 100)
    d.engine.interrupt('disconnect', d.now)
    expect(d.records()[0]!.measures.map((m) => m.occ)).toEqual([0])
  })

  it('flags temporary hints and keyboard per bar', () => {
    const d = scored()
    playAll(d, [C4, D4], 100)
    d.engine.requestHint(d.now)
    playAll(d, [E4, F4, G4], 100)
    d.engine.setKeyboardVisible(true, d.now)
    d.engine.setKeyboardVisible(false, d.now)
    playAll(d, [A4, B4, C5], 100)
    const [r] = d.records()
    expect(r!.measures.map((m) => [m.tempHint, m.keyboard])).toEqual([
      [true, false],
      [false, true],
    ])
    expect(r!.assistance).toMatchObject({ level: 'keyboard', hintRequests: 1, hintGroups: [2] })
  })
})

describe('Abandonment (repeated-restart evidence)', () => {
  it('a user restart or stop after wrong notes in the current bar reports an AbandonEvent', () => {
    for (const action of ['restart', 'stop'] as const) {
      const d = scored()
      playAll(d, [C4, D4, E4, F4], 100)
      d.tap(D4)
      if (action === 'restart') d.engine.restart(d.now)
      else d.engine.interrupt('user-stop', d.now)
      const reason = action === 'restart' ? 'user-restart' : 'user-stop'
      const [r] = d.records()
      expect(r).toMatchObject({ completion: 'abandoned', interruptReason: reason, passed: false })
      expect(d.of('abandon').map((e) => e.event)).toEqual([
        {
          pieceId: 'piece',
          measureContextKey: measureContextKey(r!.context),
          occ: 1,
          at: 1_700_000_000_000 + d.now,
          reason,
        },
      ])
    }
  })

  it('no AbandonEvent without wrong notes in the current bar', () => {
    const d = scored()
    d.tap(D4).tap(C4)
    playAll(d, [D4, E4, F4], 100)
    d.engine.restart(d.now)
    expect(d.of('abandon')).toHaveLength(0)
  })

  it('device disconnection, suspension and seeks are never abandonment', () => {
    for (const reason of ['disconnect', 'suspend', 'seek'] as const) {
      const d = scored()
      d.tap(D4)
      if (reason === 'seek') d.engine.seek(3, d.now)
      else d.engine.interrupt(reason, d.now)
      expect(d.records()[0]).toMatchObject({ completion: 'interrupted', interruptReason: reason })
      expect(d.of('abandon')).toHaveLength(0)
    }
  })
})

describe('Acceptance: Label assistance', () => {
  const notesAt = (d: EngineDriver, group: number): readonly number[] => d.engine.timeline.groups[group]!.notes

  it('labels visible while waiting for the first press mark the attempt assisted', () => {
    const d = scored()
    expect(d.state.phase).toBe('ready')
    expect(d.engine.recordPersistentLabelExposure(notesAt(d, 0), d.now)).toBe(1)
    expect(d.state.assistance).toBe('names')
    playAll(d, [C4, D4, E4, F4, G4, A4, B4, C5], 100)
    const [r] = d.records()
    expect(r).toMatchObject({ passed: false })
    expect(r!.assistance).toMatchObject({ level: 'names', persistentLabelGroups: [0], hintRequests: 0, autoHints: 0 })
    expect(r!.measures.map((m) => m.persistentLabel)).toEqual([true, false])
  })

  it('read-ahead exposure is attributed to the revealed note’s group and bar, and survives hiding', () => {
    const d = scored()
    d.tap(C4)
    d.engine.recordPersistentLabelExposure([...notesAt(d, 6)], d.now)
    playAll(d, [D4, E4, F4, G4, A4, B4, C5], 100)
    const [r] = d.records()
    expect(r!.assistance.persistentLabelGroups).toEqual([6])
    expect(r!.assistance.persistentLabelNotes).toEqual([...notesAt(d, 6)])
    expect(r!.measures.map((m) => m.persistentLabel)).toEqual([false, true])
  })

  it('labels on already played notes, automatic notes or notes outside the passage are not assistance', () => {
    const spec: ScoreSpec = {
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: C3, hand: 'L' },
        { at: 1, midi: D4 },
        { at: 4, midi: E4 },
      ],
    }
    const d = scored(spec, { transport: 'free' }, { hands: 'right', range: { fromOcc: 0, toOcc: 0 } })
    d.tap(C4)
    const model = d.engine.timeline.model
    const played = model.notes.findIndex((n) => n.midi === C4)
    const auto = model.notes.findIndex((n) => n.midi === C3)
    const outside = model.notes.findIndex((n) => n.midi === E4)
    expect(d.engine.recordPersistentLabelExposure([played, auto, outside], d.now)).toBe(0)
    d.tap(D4)
    expect(d.records()[0]).toMatchObject({ passed: true })
  })

  it('a tie continuation label reveals its chain’s attack', () => {
    const spec: ScoreSpec = {
      notes: [
        { at: 0, midi: C4 },
        { at: 1, dur: 2, midi: E4 },
        { at: 3, dur: 1, midi: E4, cont: true },
      ],
      bars: 1,
    }
    const d = scored(spec, {}, { range: null })
    const cont = d.engine.timeline.model.notes.findIndex((n) => n.tieContinuation)
    expect(d.engine.recordPersistentLabelExposure([cont], d.now)).toBe(1)
    d.tap(C4, E4)
    expect(d.records()[0]!.assistance.persistentLabelGroups).toEqual([1])
  })

  it('exposure is fresh per attempt: still-visible labels must be reported again', () => {
    const d = scored()
    d.engine.recordPersistentLabelExposure(notesAt(d, 0), d.now)
    d.tap(C4)
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    expect(d.of('exposure-reset')).toHaveLength(2)
    expect(d.state.assistance).toBe('none')
    playAll(d, [C4, D4, E4, F4, G4, A4, B4, C5], 100)
    expect(d.records().at(-1)).toMatchObject({ completion: 'completed', passed: true })
  })

  it('conditional mode revealing nothing adds no assistance', () => {
    const d = scored(twoBars, { labelSettings: { mode: 'conditional', rulesJson: '{"G2":{}}' } })
    d.engine.recordPersistentLabelExposure([], d.now)
    playAll(d, [C4, D4, E4, F4, G4, A4, B4, C5], 100)
    const [r] = d.records()
    expect(r).toMatchObject({ passed: true })
    expect(r!.assistance.labelSettings.mode).toBe('conditional')
  })

  it('exposure after the attempt ended is ignored', () => {
    const d = scored()
    playAll(d, [C4, D4, E4, F4, G4, A4, B4, C5], 100)
    expect(d.engine.recordPersistentLabelExposure(notesAt(d, 0), d.now)).toBe(0)
  })
})
