import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS, DISABLED_RULE, TREBLE_PRESET } from '../../core/model/settings'
import { PersistentLabels, labelSnapshot, mergeOpacity, sameOpacity } from './labels'

const score = buildScore({
  notes: [
    { at: 0, midi: 59 },
    { at: 1, midi: 64 },
    { at: 2, midi: 73 },
  ],
  bars: 1,
})
const naming = DEFAULT_SETTINGS.naming
const off = DEFAULT_SETTINGS.labels
const conditional = { mode: 'conditional' as const, rules: { G2: TREBLE_PRESET, F4: DISABLED_RULE } }

describe('PersistentLabels', () => {
  it('formats every note and applies the conditional rule by sounding pitch', () => {
    const l = new PersistentLabels(score.notes, conditional, naming, 300)
    expect(l.texts.get(0)).toBe('B3')
    expect(l.texts.get(2)).toBe('C♯5')
    expect([0, 1, 2].map((n) => l.isEligible(n))).toEqual([true, false, true])
    expect([...l.opacity(0).keys()]).toEqual([0, 2])
  })

  it('fades leaving labels out and entering ones in, then returns a stable map', () => {
    const l = new PersistentLabels(score.notes, conditional, naming, 300)
    expect(l.setLabels({ ...conditional, mode: 'all' }, 1000)).toBe(true)
    const mid = l.opacity(1150)
    expect(mid.get(0)).toBe(1)
    expect(mid.get(1)).toBeGreaterThan(0)
    expect(mid.get(1)).toBeLessThan(1)
    expect(l.fading).toBe(true)
    const done = l.opacity(1300)
    expect(done.get(1)).toBe(1)
    expect(l.fading).toBe(false)
    expect(l.opacity(2000)).toBe(l.opacity(3000))
    l.setLabels(off, 4000)
    expect(l.fadingUntil()).toBe(4300)
    expect(l.opacity(4100).size).toBe(3)
    expect(l.opacity(4300).size).toBe(0)
  })

  it('a reversed fade continues from the current opacity', () => {
    const l = new PersistentLabels(score.notes, off, naming, 300)
    l.setLabels({ ...off, mode: 'all' }, 0)
    const v = l.opacity(150).get(1)!
    l.setLabels(off, 150)
    expect(l.opacity(150).get(1)).toBeCloseTo(v)
  })

  it('naming changes rewrite texts only', () => {
    const l = new PersistentLabels(score.notes, off, naming, 300)
    expect(l.setNaming({ ...naming, system: 'fixed-do' })).toBe(true)
    expect(l.texts.get(1)).toBe('mi4')
    expect(l.setNaming({ ...naming, system: 'fixed-do' })).toBe(false)
  })
})

describe('label opacity helpers', () => {
  it('merges by maximum, one label per note', () => {
    const p = new Map([
      [1, 1],
      [2, 0.5],
    ])
    const t = new Map([
      [2, 0.8],
      [3, 1],
    ])
    expect([...mergeOpacity(p, t)]).toEqual([
      [1, 1],
      [2, 0.8],
      [3, 1],
    ])
    expect(mergeOpacity(p, new Map())).toBe(p)
    expect(sameOpacity(new Map([[1, 1]]), new Map([[1, 1]]))).toBe(true)
    expect(sameOpacity(new Map([[1, 1]]), new Map([[1, 0.5]]))).toBe(false)
  })

  it('snapshots the plain clef → rule map (parsed by Results)', () => {
    const rules = { G2: TREBLE_PRESET, F4: DISABLED_RULE }
    const snap = labelSnapshot({ mode: 'all', rules })
    expect(snap.mode).toBe('all')
    expect(snap.rulesJson).toBe(JSON.stringify(rules))
    expect(JSON.parse(snap.rulesJson)).toEqual(rules)
  })
})
