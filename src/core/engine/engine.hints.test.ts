/**
 * Acceptance rows "Hints", "Hint fade", "Persistent and temporary labels" (engine side) and
 * "Pedal hints" as they reach the engine.
 */
import { describe, expect, it } from 'vitest'
import type { HintSettings } from '../model/settings'
import type { EngineConfig } from './types'
import { EngineDriver, buildScore, pedalDetector } from './testkit'
import { buildTimeline } from './timeline'

const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67

const model = buildScore({
  notes: [
    { at: 0, midi: C4 },
    { at: 0, midi: E4 },
    { at: 1, midi: D4 },
    { at: 2, midi: F4 },
  ],
})

function driver(over: Partial<EngineConfig> = {}, hints?: Partial<HintSettings>): EngineDriver {
  const t = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
  return new EngineDriver(t, {
    mode: 'reading',
    pieceId: 'p',
    hints: { autoThreshold: 2, lifetime: 30, fadeMs: 300, ...hints },
    ...over,
  })
}

const notesOf = (d: EngineDriver, group: number): readonly number[] => d.engine.timeline.groups[group]!.notes

describe('Automatic note-name hints', () => {
  it('appear after two wrong attacks at the current group by default', () => {
    const d = driver()
    d.tap(G4)
    expect(d.of('hint-shown')).toHaveLength(0)
    d.tap(G4)
    expect(d.of('hint-shown')).toEqual([{ type: 'hint-shown', group: 0, source: 'auto', notes: notesOf(d, 0) }])
    expect(d.state.hint?.source).toBe('auto')
    expect(d.state.assistance).toBe('names')
  })

  it('honor a threshold of one, and off', () => {
    const one = driver({}, { autoThreshold: 1 })
    one.tap(G4)
    expect(one.of('hint-shown')).toHaveLength(1)
    const off = driver({}, { autoThreshold: null })
    off.tap(G4, G4, G4, G4)
    expect(off.of('hint-shown')).toHaveLength(0)
    expect(off.state.assistance).toBe('none')
  })

  it('count per group and reset on advancement', () => {
    const d = driver()
    d.tap(G4).tap(C4, E4).tap(G4)
    expect(d.of('hint-shown')).toHaveLength(0)
  })

  it('re-arm after a timed expiry: another threshold of errors or a manual request is needed', () => {
    const d = driver()
    d.tap(G4, G4)
    d.wait(30_000)
    expect(d.of('hint-expired')).toEqual([{ type: 'hint-expired', group: 0 }])
    expect(d.state.hint).toBeNull()
    d.tap(G4)
    expect(d.of('hint-shown')).toHaveLength(1)
    d.tap(G4)
    expect(d.of('hint-shown')).toHaveLength(2)
  })

  it('errors while a hint is visible do not pre-arm the next one', () => {
    const d = driver()
    d.tap(G4, G4, G4, G4, G4)
    d.wait(30_000)
    d.tap(G4)
    expect(d.of('hint-shown')).toHaveLength(1)
  })
})

describe('Manual hints', () => {
  it('reveal the current group immediately without skipping it and count requests', () => {
    const d = driver()
    expect(d.engine.requestHint(d.now)).toBe(true)
    expect(d.state.groupIndex).toBe(0)
    expect(d.state.hint).toMatchObject({ group: 0, source: 'manual', untilCorrect: false, expiresAt: d.now + 30_000 })
    expect(d.engine.temporaryLabelOpacity(d.now)).toEqual(new Map(notesOf(d, 0).map((n) => [n, 1])))
  })

  it('restart the lifetime', () => {
    const d = driver()
    d.engine.requestHint(d.now)
    d.wait(20_000)
    d.engine.requestHint(d.now)
    d.wait(20_000)
    expect(d.state.hint).not.toBeNull()
    d.wait(10_000)
    expect(d.state.hint).toBeNull()
  })

  it('are measured in active seconds: the default 30 s timer ignores tempo and freezes in an ordinary pause', () => {
    const d = driver()
    d.engine.requestHint(d.now)
    d.wait(10_000)
    d.engine.pause(d.now)
    d.wait(120_000)
    expect(d.state.hint).not.toBeNull()
    expect(d.engine.nextDeadline()).toBeNull()
    d.engine.resume(d.now)
    expect(d.engine.nextDeadline()).toBe(d.now + 20_000)
    d.wait(19_999)
    expect(d.state.hint).not.toBeNull()
    d.wait(1)
    expect(d.state.hint).toBeNull()
  })

  it('"Until correct" stays until the group is completed', () => {
    const d = driver({}, { lifetime: 'until-correct' })
    d.engine.requestHint(d.now)
    d.wait(10 * 60_000)
    expect(d.state.hint?.untilCorrect).toBe(true)
    d.tap(C4, E4)
    expect(d.state.hint).toBeNull()
  })

  it('do nothing once the group is finished', () => {
    const d = driver()
    d.tap(C4, E4, D4, F4)
    expect(d.state.phase).toBe('completed')
    expect(d.engine.requestHint(d.now)).toBe(false)
  })
})

describe('Acceptance: Hint fade', () => {
  it('a timed label is fully invisible at expiry, after an eased fade over the final 300 ms', () => {
    const d = driver()
    const [note] = notesOf(d, 0)
    d.engine.requestHint(d.now)
    const t0 = d.now
    expect(d.engine.temporaryLabelOpacity(t0 + 29_700).get(note!)).toBe(1)
    expect(d.engine.temporaryLabelOpacity(t0 + 29_850).get(note!)).toBeCloseTo(0.5)
    expect(d.engine.temporaryLabelOpacity(t0 + 29_990).get(note!)).toBeLessThan(0.01)
    expect(d.engine.temporaryLabelOpacity(t0 + 30_000).has(note!)).toBe(false)
  })

  it('completion retires the hint and fades it without delaying advancement; labels stay on the old notes', () => {
    const d = driver()
    d.engine.requestHint(d.now)
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.of('hint-retired')).toEqual([{ type: 'hint-retired', group: 0, reason: 'completed' }])
    const mid = d.engine.temporaryLabelOpacity(d.now + 150)
    expect([...mid.keys()].sort()).toEqual([...notesOf(d, 0)].sort())
    expect(mid.get(notesOf(d, 0)[0]!)).toBeCloseTo(0.5)
    for (const n of notesOf(d, 1)) expect(mid.has(n)).toBe(false)
    expect(d.engine.temporaryLabelOpacity(d.now + 300).size).toBe(0)
  })

  it('a manual request during a dismissal fade restores the current group’s hint and resets its timer', () => {
    const d = driver()
    d.engine.requestHint(d.now)
    d.wait(5000)
    d.engine.dismissHint(d.now)
    d.wait(150)
    const [note] = notesOf(d, 0)
    expect(d.engine.temporaryLabelOpacity(d.now).get(note!)).toBeCloseTo(0.5)
    d.engine.requestHint(d.now)
    expect(d.engine.temporaryLabelOpacity(d.now).get(note!)).toBe(1)
    expect(d.state.hint?.expiresAt).toBe(d.now + 30_000)
  })

  it('a manual request during the expiry fade restores full opacity', () => {
    const d = driver()
    const [note] = notesOf(d, 0)
    d.engine.requestHint(d.now)
    d.wait(29_850)
    expect(d.engine.temporaryLabelOpacity(d.now).get(note!)).toBeCloseTo(0.5)
    d.engine.requestHint(d.now)
    expect(d.engine.temporaryLabelOpacity(d.now).get(note!)).toBe(1)
  })

  it('an ordinary pause freezes a fade in progress', () => {
    const d = driver()
    const [note] = notesOf(d, 0)
    d.engine.requestHint(d.now)
    d.engine.dismissHint(d.now)
    d.wait(100)
    const frozen = d.engine.temporaryLabelOpacity(d.now).get(note!)!
    expect(frozen).toBeGreaterThan(0)
    d.engine.pause(d.now)
    d.wait(10_000)
    expect(d.engine.temporaryLabelOpacity(d.now).get(note!)).toBeCloseTo(frozen)
    d.engine.resume(d.now)
    d.wait(200)
    expect(d.engine.temporaryLabelOpacity(d.now).has(note!)).toBe(false)
  })

  it('pausing a scored attempt interrupts it and dismisses its hints with a fade', () => {
    const d = driver({ mode: 'scored', prepared: true })
    d.engine.requestHint(d.now)
    d.tap(G4)
    d.engine.pause(d.now)
    expect(d.state.phase).toBe('interrupted')
    expect(d.of('hint-retired')).toEqual([{ type: 'hint-retired', group: 0, reason: 'dismissed' }])
    expect(d.engine.temporaryLabelOpacity(d.now + 150).size).toBe(2)
    expect(d.engine.temporaryLabelOpacity(d.now + 300).size).toBe(0)
  })
})

describe('Acceptance: Persistent and temporary labels (engine side)', () => {
  it('turning persistent labels off never hides an active temporary hint, and reading is not interrupted', () => {
    const d = driver({ labelSettings: { mode: 'all', rulesJson: '{}' } })
    d.engine.requestHint(d.now)
    d.engine.updateSettings({ labelSettings: { mode: 'off', rulesJson: '{}' } }, d.now)
    expect(d.state.phase).toBe('running')
    const [note] = notesOf(d, 0)
    expect(d.engine.temporaryLabelOpacity(d.now).get(note!)).toBe(1)
  })

  it('the temporary source covers only the hinted group’s notes (persistent labels are combined by the renderer)', () => {
    const d = driver()
    d.engine.requestHint(d.now)
    const keys = [...d.engine.temporaryLabelOpacity(d.now).keys()].sort()
    expect(keys).toEqual([...notesOf(d, 0)].sort())
  })
})

describe('Hint pedal and keyboard guide', () => {
  it('one pedal press reveals one hint; holding does not retrigger; the next press works after release', () => {
    const d = driver({ hintPedal: pedalDetector(66) })
    d.cc(66, 127)
    expect(d.state.hint?.source).toBe('manual')
    d.cc(66, 120).cc(66, 127)
    d.engine.dismissHint(d.now)
    d.cc(66, 127)
    expect(d.state.hint).toBeNull()
    d.cc(66, 0).cc(66, 127)
    expect(d.state.hint).not.toBeNull()
    expect(d.of('hint-shown')).toHaveLength(2)
    expect(d.state.sostenutoDown).toBe(false)
  })

  it('can be assigned to Show keys instead', () => {
    const d = driver({ hintPedal: pedalDetector(66), hintPedalAction: 'keys' })
    d.cc(66, 127)
    expect(d.state.keyboardVisible).toBe(true)
    expect(d.state.hint).toBeNull()
  })

  it('showing the keyboard guide marks keyboard assistance even after hiding it', () => {
    const d = driver()
    d.engine.setKeyboardVisible(true, d.now)
    d.engine.setKeyboardVisible(false, d.now)
    expect(d.of('keyboard').map((e) => e.visible)).toEqual([true, false])
    expect(d.state.assistance).toBe('keyboard')
    d.tap(C4, E4, D4, F4)
    const r = d.records()[0]!
    expect(r.assistance.keyboardShown).toBe(true)
    expect(r.measures[0]!.keyboard).toBe(true)
  })

  it('settings changes apply to the next hint', () => {
    const d = driver()
    d.engine.updateSettings({ hints: { autoThreshold: 1, lifetime: 5, fadeMs: 100 } }, d.now)
    d.tap(G4)
    expect(d.state.hint?.expiresAt).toBe(d.now + 5000)
  })
})
