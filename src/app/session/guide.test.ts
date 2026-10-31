import { describe, expect, it } from 'vitest'
import { buildGuideKeys, sameGuideKeys, type GuideInput } from './guide'

const notes = [
  { midi: 60, hand: 'R' },
  { midi: 64, hand: 'R' },
  { midi: 48, hand: 'L' },
  { midi: 60, hand: 'L' },
] as unknown as GuideInput['notes']

const base: GuideInput = {
  notes,
  targetNotes: [],
  acceptedPitches: [],
  sounding: [],
  heldKeys: [],
  heldWrongKeys: [],
  noteLabel: (n) => ['C4', 'E4', 'C3', 'C4'][n],
  keyLabel: (midi) => `k${midi}`,
}

describe('buildGuideKeys', () => {
  it('lists targets, sounding notes and held keys once each, low to high', () => {
    const keys = buildGuideKeys({
      ...base,
      targetNotes: [1, 0],
      acceptedPitches: [60],
      sounding: [[2]],
      heldKeys: [60, 62],
    })
    expect(keys).toEqual([
      { midi: 48, state: 'sounding', hand: 'L', label: 'C3', held: false },
      { midi: 60, state: 'accepted', hand: 'R', label: 'C4', held: true },
      { midi: 62, state: 'held', hand: null, label: 'k62', held: true },
      { midi: 64, state: 'target', hand: 'R', label: 'E4', held: false },
    ])
  })

  it('draws a unison between hands neutral and a held wrong key as wrong', () => {
    const keys = buildGuideKeys({ ...base, targetNotes: [0, 3], heldKeys: [61], heldWrongKeys: [61] })
    expect(keys).toEqual([
      { midi: 60, state: 'target', hand: null, label: 'C4', held: false },
      { midi: 61, state: 'wrong', hand: null, label: 'k61', held: true },
    ])
  })

  it('compares by content', () => {
    const a = buildGuideKeys({ ...base, targetNotes: [0] })
    expect(sameGuideKeys(a, buildGuideKeys({ ...base, targetNotes: [0] }))).toBe(true)
    expect(sameGuideKeys(a, buildGuideKeys({ ...base, targetNotes: [0], heldKeys: [60] }))).toBe(false)
  })
})
