/**
 * Scored lifecycle (Preparing → Ready → Running → Completed → repeat reset) and ordinary
 * reading: acceptance rows First-key timing, Immediate repeat readiness, Interruption and
 * Loop boundaries.
 */
import { describe, expect, it } from 'vitest'
import { CC_SOSTENUTO, CC_SUSTAIN } from '../midi/types'
import type { PassageRange } from '../model/practice'
import type { EngineConfig } from './types'
import { EngineDriver, buildScore, pedalDetector } from './testkit'
import { buildTimeline } from './timeline'

const C3 = 48
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67

const model = buildScore({
  notes: [
    { at: 0, midi: C4 },
    { at: 1, midi: D4 },
    { at: 2, midi: E4 },
    { at: 3, midi: F4 },
    { at: 4, dur: 4, midi: G4 },
  ],
})

function scored(over: Partial<EngineConfig> = {}, range: PassageRange | null = { fromOcc: 0, toOcc: 1 }): EngineDriver {
  const t = buildTimeline(model, { hands: 'both', range, multiplier: 1 })
  return new EngineDriver(t, { mode: 'scored', pieceId: 'p', ...over })
}

describe('Acceptance: First-key timing', () => {
  it('Start enters Ready without starting the clock once prepared', () => {
    const d = scored()
    expect(d.state.phase).toBe('preparing')
    expect(d.state.readyBlockers).toEqual(['not-prepared'])
    d.engine.markPrepared(d.now)
    expect(d.state.phase).toBe('ready')
    expect(d.state.clockStartedAt).toBeNull()
    expect(d.of('exposure-reset')).toHaveLength(1)
  })

  it('idle waiting, hints, pedals, releases and zero-velocity Note On do not start it', () => {
    const d = scored({ prepared: true, hintPedal: pedalDetector(66) })
    d.wait(60_000)
    d.engine.requestHint(d.now)
    d.cc(66, 127).cc(66, 0)
    d.cc(CC_SUSTAIN, 127).cc(CC_SUSTAIN, 0)
    d.up(C4)
    d.engine.input({ kind: 'noteon', seq: 999, channel: 0, note: C4, velocity: 0, time: d.now, portId: 'x' })
    expect(d.state.phase).toBe('ready')
    expect(d.state.clockStartedAt).toBeNull()
    expect(d.of('clock-started')).toHaveLength(0)
  })

  it('the first fresh positive-velocity Note On starts timing and is processed once, correct', () => {
    const d = scored({ prepared: true })
    d.wait(5000).down(C4)
    expect(d.of('clock-started')).toEqual([{ type: 'clock-started', time: d.now }])
    expect(d.state.phase).toBe('running')
    expect(d.state.groupIndex).toBe(1)
  })

  it('…or wrong', () => {
    const d = scored({ prepared: true })
    d.down(E4)
    expect(d.state.clockStartedAt).toBe(d.now)
    expect(d.state.wrongAttacks).toBe(1)
    expect(d.state.groupIndex).toBe(0)
  })

  it('input during preparation only updates physical state and cannot satisfy the attempt', () => {
    const d = scored()
    d.down(C4)
    expect(d.state.heldKeys).toEqual([C4])
    expect(d.state.acceptedPitches).toEqual([])
    d.engine.markPrepared(d.now)
    expect(d.state.readyBlockers).toEqual(['keys-held'])
    d.up(C4)
    expect(d.state.phase).toBe('ready')
    expect(d.state.groupIndex).toBe(0)
    expect(d.state.clockStartedAt).toBeNull()
  })
})

describe('Scored completion and Acceptance: Immediate repeat readiness', () => {
  function complete(d: EngineDriver): void {
    d.tap(C4)
    d.now += 1000
    d.tap(D4)
    d.now += 1000
    d.tap(E4)
    d.now += 1000
    d.tap(F4)
    d.now += 1000
    d.down(G4)
  }

  it('the final missing correct attack completes the attempt and emits one record', () => {
    const d = scored({ prepared: true })
    complete(d)
    expect(d.state.phase).toBe('completed')
    expect(d.state.groupIndex).toBeNull()
    const [r] = d.records()
    expect(r).toMatchObject({ kind: 'scored', completion: 'completed', completionTimeSec: 4, passed: true })
  })

  it('repeat reset waits for keys, fades and preparation, never for pedals, then enters Ready directly', () => {
    const d = scored({ prepared: true })
    d.engine.requestHint(d.now)
    d.cc(CC_SUSTAIN, 127)
    complete(d)
    d.engine.restart(d.now)
    expect(d.state.phase).toBe('preparing')
    expect(d.state.readyBlockers).toEqual(['not-prepared', 'keys-held'])
    d.engine.markPrepared(d.now)
    d.cc(CC_SOSTENUTO, 127)
    expect(d.state.readyBlockers).toEqual(['keys-held'])
    d.up(G4)
    // Sustain and sostenuto are still down: no pedal release is needed to begin.
    expect(d.state).toMatchObject({ sustainDown: true, sostenutoDown: true })
    expect(d.state.phase).toBe('ready')
    expect(d.state.clockStartedAt).toBeNull()
    expect(d.of('exposure-reset')).toHaveLength(2)
  })

  it('outgoing label fades from a restart finish before Ready', () => {
    const d = scored({ prepared: true })
    d.engine.requestHint(d.now)
    d.down(E4).up(E4)
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    expect(d.state.readyBlockers).toEqual(['label-fade'])
    d.wait(299)
    expect(d.state.phase).toBe('preparing')
    d.wait(1)
    expect(d.state.phase).toBe('ready')
  })

  it('stale held notes cannot satisfy the next attempt and reset time is excluded', () => {
    const d = scored({ prepared: true })
    complete(d)
    d.wait(10_000)
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    d.up(G4)
    d.wait(5000)
    expect(d.state.groupIndex).toBe(0)
    d.down(C4)
    expect(d.state.clockStartedAt).toBe(d.now)
  })

  it('a hint-pedal press in Ready neither starts timing nor cancels readiness, and never blocks it', () => {
    const d = scored({ prepared: true, hintPedal: pedalDetector(CC_SOSTENUTO) })
    d.cc(CC_SOSTENUTO, 127)
    expect(d.state.phase).toBe('ready')
    expect(d.state.hint).not.toBeNull()
    expect(d.state.clockStartedAt).toBeNull()
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    expect(d.state.readyBlockers).toEqual(['label-fade'])
    d.wait(300)
    expect(d.state.phase).toBe('ready')
  })

  it('restarting after completion is not an abandonment', () => {
    const d = scored({ prepared: true })
    complete(d)
    d.engine.restart(d.now)
    expect(d.of('abandon')).toHaveLength(0)
    expect(d.records()).toHaveLength(1)
  })

  it('the hint pedal is consumed by the engine and never tracked as sostenuto', () => {
    const d = scored({ hintPedal: pedalDetector(CC_SOSTENUTO) })
    d.cc(CC_SOSTENUTO, 127)
    d.engine.markPrepared(d.now)
    expect(d.state.phase).toBe('ready')
  })

  it('scored practice is refused when the timeline has blockers', () => {
    const noTempo = buildScore({ tempo: null, notes: [{ at: 0, midi: C4 }] })
    const t = buildTimeline(noTempo, { hands: 'both', range: null, multiplier: 1 })
    expect(() => new EngineDriver(t, { mode: 'scored', pieceId: 'p' })).toThrow(/practice tempo/)
  })
})

describe('Acceptance: Interruption', () => {
  for (const reason of ['disconnect', 'suspend', 'setting-change', 'layout-change', 'tempo-change'] as const) {
    it(`${reason} never creates a completed or failed result`, () => {
      const d = scored({ prepared: true })
      d.tap(C4, E4)
      d.engine.interrupt(reason, d.now)
      const [r] = d.records()
      expect(r).toMatchObject({ completion: 'interrupted', interruptReason: reason, passed: false })
      expect(r!.completionTimeSec).toBeUndefined()
      expect(d.of('abandon')).toHaveLength(0)
      expect(d.state.phase).toBe('interrupted')
      expect(d.state.acceptedPitches).toEqual([])
    })
  }

  it('pausing a scored attempt interrupts it', () => {
    const d = scored({ prepared: true })
    d.tap(C4)
    d.engine.pause(d.now)
    expect(d.records()[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'pause' })
    d.engine.resume(d.now)
    expect(d.state.phase).toBe('interrupted')
  })

  it('an attempt interrupted before its first press is discarded, not recorded', () => {
    const d = scored({ prepared: true })
    d.engine.interrupt('user-stop', d.now)
    expect(d.records()).toHaveLength(0)
    expect(d.of('attempt-discarded')).toEqual([
      { type: 'attempt-discarded', attemptId: d.state.attemptId, reason: 'user-stop' },
    ])
  })

  it('a disconnect forgets physical state so reconnection needs fresh attacks and clean keys', () => {
    const d = scored({ prepared: true })
    d.down(C4).down(D4).cc(CC_SUSTAIN, 127)
    d.engine.interrupt('disconnect', d.now)
    expect(d.state.heldKeys).toEqual([])
    expect(d.state.sustainDown).toBe(false)
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    expect(d.state.phase).toBe('ready')
    d.up(D4)
    expect(d.state.phase).toBe('ready')
  })

  it('a label mode change interrupts an active scored attempt; the next attempt records the new settings', () => {
    const d = scored({ prepared: true })
    d.tap(C4)
    const labels = { mode: 'all' as const, rulesJson: '{}' }
    d.engine.updateSettings({ labelSettings: labels }, d.now)
    expect(d.records()[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'setting-change' })
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    d.tap(C4).tap(D4).tap(E4).tap(F4).down(G4)
    expect(d.records()[1]!.assistance.labelSettings).toEqual(labels)
  })

  it('ordinary reading pauses and resumes with its progress and hint timer kept', () => {
    const t = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'p' })
    d.tap(C4).down(D4)
    d.engine.requestHint(d.now)
    d.engine.pause(d.now)
    expect(d.state.phase).toBe('paused')
    d.tap(E4)
    expect(d.state.groupIndex).toBe(2)
    expect(d.state.wrongAttacks).toBe(0)
    d.wait(600_000)
    d.engine.resume(d.now)
    expect(d.state.phase).toBe('running')
    expect(d.state.hint).not.toBeNull()
    expect(d.records()).toHaveLength(0)
    d.tap(E4)
    expect(d.state.groupIndex).toBe(3)
  })

  it('reading interrupted (disconnect) resumes as a new traversal at the same position with fresh attacks', () => {
    const t = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'p' })
    d.tap(C4, D4)
    d.engine.interrupt('disconnect', d.now)
    expect(d.records()[0]).toMatchObject({ kind: 'reading', completion: 'interrupted', interruptReason: 'disconnect' })
    d.engine.resume(d.now)
    expect(d.state.phase).toBe('running')
    expect(d.state.groupIndex).toBe(2)
    expect(d.of('exposure-reset')).toHaveLength(2)
  })
})

describe('Acceptance: Loop boundaries', () => {
  // C3 is held (untied) across the barline; C4 is tied across it.
  const crossing = buildScore({
    notes: [
      { at: 2, dur: 4, midi: C3 },
      { at: 0, dur: 4, midi: C4 },
      { at: 4, dur: 2, midi: C4, cont: true },
      { at: 4, midi: E4 },
      { at: 6, midi: G4 },
    ],
  })

  it('a held note crossing the loop start is reattacked deliberately; old notes and pedals do not satisfy', () => {
    const t = buildTimeline(crossing, { hands: 'both', range: { fromOcc: 1, toOcc: 1 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true })
    d.down(E4)
    expect(d.state.missingPitches).toEqual([C3])
    d.tap(C3).up(E4).tap(G4)
    expect(d.state.phase).toBe('completed')
    // Repeat: a key held through the reset blocks Ready (the held sustain pedal does not); once
    // released, a fresh attack of the boundary note is still required.
    d.down(C3).cc(CC_SUSTAIN, 127)
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    expect(d.state.readyBlockers).toEqual(['keys-held'])
    d.up(C3)
    expect(d.state.phase).toBe('ready')
    d.down(E4)
    expect(d.state.missingPitches).toEqual([C3])
  })

  it('a tie attacked before the loop is not expected; pressing it is a tie-end press, not a wrong note', () => {
    const t = buildTimeline(crossing, { hands: 'both', range: { fromOcc: 1, toOcc: 1 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true })
    d.tap(C4) // starts the clock; sounds through in the score
    expect(d.state).toMatchObject({ phase: 'running', wrongAttacks: 0, groupHasError: false, wrongFeedbackUntil: 0 })
    expect(d.state.heldWrongKeys).toEqual([])
    expect(d.of('wrong').map((e) => [e.group, e.pitch, e.reason])).toEqual([[0, C4, 'tie-end']])
    expect(d.of('key').every((e) => !e.wrong)).toBe(true)
    d.tap(C3, E4).tap(G4)
    const r = d.records()[0]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 0, passed: true })
    expect(r.groups![0]).toMatchObject({ group: 0, wrongAttacks: 0, wrongPitches: [], tieEndPresses: 1 })
    expect(r.groups![1]).toMatchObject({ group: 1, tieEndPresses: 0 })
  })

  it('boundary reattack mistakes are excluded from the original passage history', () => {
    const synthetic = buildScore({
      notes: [
        { at: 2, dur: 4, midi: C3 },
        { at: 6, midi: G4 },
      ],
    })
    const t = buildTimeline(synthetic, { hands: 'both', range: { fromOcc: 1, toOcc: 1 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true })
    d.tap(D4).tap(C3).tap(E4).tap(G4)
    const m = d.records()[0]!.measures[0]!
    expect(m).toMatchObject({ occ: 1, complete: true, wrongAttacks: 2, wrongAttacksExcludingBoundary: 1 })
  })
})

describe('Ordinary reading navigation', () => {
  it('seeking ends the traversal and starts a new one at the target, keeping running/paused', () => {
    const t = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'p', startPaused: true })
    expect(d.state.phase).toBe('paused')
    d.engine.resume(d.now)
    d.tap(C4).tap(E4)
    d.engine.seek(3, d.now)
    expect(d.records()[0]).toMatchObject({ kind: 'reading', completion: 'interrupted', interruptReason: 'seek' })
    expect(d.state).toMatchObject({ phase: 'running', groupIndex: 3, wrongAttacks: 0, acceptedPitches: [] })
    expect(d.of('abandon')).toHaveLength(0)
  })

  it('a tempo change keeps the current target and its progress in a new traversal', () => {
    const chord = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: D4 },
      ],
    })
    const t = buildTimeline(chord, { hands: 'both', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'p' })
    d.tap(C4)
    d.engine.reconfigure(
      { reason: 'tempo-change', timeline: buildTimeline(chord, { hands: 'both', range: null, multiplier: 0.5 }) },
      d.now,
    )
    expect(d.state.acceptedPitches).toEqual([C4])
    expect(d.records()[0]).toMatchObject({ interruptReason: 'tempo-change' })
    d.tap(E4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.engine.timeline.multiplier).toBe(0.5)
  })

  it('a hand change clears accepted attacks and continues at the same position', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4, hand: 'R' },
        { at: 0, midi: 48, hand: 'L' },
        { at: 1, midi: D4, hand: 'R' },
        { at: 2, midi: 52, hand: 'L' },
      ],
    })
    const d = new EngineDriver(buildTimeline(m, { hands: 'both', range: null, multiplier: 1 }), {
      mode: 'reading',
      pieceId: 'p',
    })
    d.tap(C4, 48, D4)
    d.engine.reconfigure(
      { reason: 'hand-change', timeline: buildTimeline(m, { hands: 'left', range: null, multiplier: 1 }) },
      d.now,
    )
    expect(d.engine.transport).toBe('accompaniment')
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.position).toEqual(d.engine.timeline.groups[1]!.position)
  })

  it('switching to a scored attempt starts in Preparing at the passage start', () => {
    const t = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'p' })
    d.tap(C4)
    d.engine.pause(d.now)
    d.engine.reconfigure(
      {
        reason: 'mode-change',
        mode: 'scored',
        timeline: buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 }),
      },
      d.now,
    )
    expect(d.state).toMatchObject({ mode: 'scored', phase: 'preparing', groupIndex: 0 })
    d.engine.requestHint(d.now)
    expect(d.engine.nextDeadline()).toBe(d.now + 30_000)
  })

  it('reaching the end completes the traversal; restart begins a new one', () => {
    const t = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'p', startGroup: 3 })
    d.tap(F4, G4)
    expect(d.state.phase).toBe('completed')
    expect(d.records()[0]).toMatchObject({ kind: 'reading', completion: 'completed', passed: false })
    d.engine.restart(d.now)
    expect(d.state).toMatchObject({ phase: 'running', groupIndex: 0 })
  })
})
