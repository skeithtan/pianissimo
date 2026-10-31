import { describe, expect, it } from 'vitest'
import type { ClefLabelRule } from '../model/settings'
import { DISABLED_RULE, TREBLE_PRESET } from '../model/settings'
import type { Spelling, Step } from '../music/pitch'
import { describeRule, sampleRule, thresholdProblem, validateRule } from './rules'

const sp = (step: Step, alter: number, octave: number): Spelling => ({ step, alter, octave })
const rule = (below: Spelling | null, above: Spelling | null): ClefLabelRule => ({
  below: { enabled: below !== null, threshold: below },
  above: { enabled: above !== null, threshold: above },
})

describe('validateRule', () => {
  it('accepts the treble preset, a single condition, both off, and equal boundaries', () => {
    expect(validateRule(TREBLE_PRESET)).toEqual({ ok: true, issues: [] })
    expect(validateRule(rule(sp('C', 0, 4), null)).ok).toBe(true)
    expect(validateRule(rule(null, sp('C', 0, 5))).ok).toBe(true)
    expect(validateRule(DISABLED_RULE).ok).toBe(true)
    expect(validateRule(rule(sp('C', 0, 4), sp('C', 0, 4))).ok).toBe(true)
    // B♯3 and C4 are the same key.
    expect(validateRule(rule(sp('B', 1, 3), sp('C', 0, 4))).ok).toBe(true)
  })

  it('rejects an enabled condition without a pitch', () => {
    const result = validateRule({ below: { enabled: true, threshold: null }, above: DISABLED_RULE.above })
    expect(result.ok).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.field).toBe('below')
    expect(result.issues[0]?.message).toMatch(/Show below is on but has no pitch/u)
  })

  it('rejects invalid pitches on enabled conditions only', () => {
    const bad = (s: Spelling): ClefLabelRule => ({ below: DISABLED_RULE.below, above: { enabled: true, threshold: s } })
    expect(validateRule(bad(sp('C', 3, 4))).issues[0]?.message).toMatch(/accidental/u)
    expect(validateRule(bad(sp('C', 0.5, 4))).issues[0]?.message).toMatch(/accidental/u)
    expect(validateRule(bad(sp('C', 0, 4.5))).issues[0]?.message).toMatch(/octave/u)
    expect(validateRule(bad(sp('C', 0, 10))).issues[0]?.message).toMatch(/MIDI range/u)
    expect(validateRule(bad({ step: 'H' as Step, alter: 0, octave: 4 })).issues[0]?.message).toMatch(/note name/u)
    expect(validateRule(bad(sp('C', 0, 10))).issues[0]?.field).toBe('above')
    // A disabled condition with a nonsense stale threshold does not block the rule.
    expect(validateRule({ below: { enabled: false, threshold: sp('C', 5, 99) }, above: DISABLED_RULE.above }).ok).toBe(
      true,
    )
  })

  it('rejects a lower boundary above the upper boundary with a plain explanation', () => {
    const result = validateRule(rule(sp('C', 0, 5), sp('C', 0, 4)))
    expect(result.ok).toBe(false)
    const issue = result.issues.find((i) => i.field === 'range')
    expect(issue?.message).toContain('Show below C5 is higher than Show above C4')
    expect(issue?.message).toContain('every note would be labeled')
    expect(issue?.message).toContain('C4 or lower')
    expect(issue?.message).toContain('C5 or higher')
  })

  it('does not report a range error while a condition is disabled', () => {
    expect(
      validateRule({
        below: { enabled: true, threshold: sp('C', 0, 6) },
        above: { enabled: false, threshold: sp('C', 0, 2) },
      }).ok,
    ).toBe(true)
  })
})

describe('thresholdProblem', () => {
  it('is null for valid pitches', () => {
    expect(thresholdProblem(sp('A', 0, 0))).toBeNull()
    expect(thresholdProblem(sp('B', -2, 3))).toBeNull()
  })
})

describe('describeRule', () => {
  it('summarizes the treble preset', () => {
    expect(describeRule(TREBLE_PRESET, 'G2')).toContain('Treble clef: label notes below C4 or above C5')
    expect(describeRule(TREBLE_PRESET, 'G2')).toContain('Notes from C4 through C5 stay unlabeled')
  })

  it('summarizes single conditions and other clefs', () => {
    expect(describeRule(rule(sp('E', 0, 2), null), 'F4')).toBe(
      'Bass clef: label notes below E2. Notes from E2 upward stay unlabeled.',
    )
    expect(describeRule(rule(null, sp('G', 1, 3)), 'C3')).toBe(
      'Alto clef: label notes above G♯3. Notes up to G♯3 stay unlabeled.',
    )
  })

  it('says so when nothing is labeled', () => {
    expect(describeRule(DISABLED_RULE, 'F4')).toBe('Bass clef: no notes are labeled (both conditions are off).')
  })

  it('flags a condition that still needs a pitch', () => {
    const half: ClefLabelRule = {
      below: { enabled: true, threshold: null },
      above: { enabled: true, threshold: sp('C', 0, 5) },
    }
    expect(describeRule(half, 'G2')).toContain('label notes above C5')
    expect(describeRule(half, 'G2')).toContain('Show below still needs a valid pitch')
    const none: ClefLabelRule = { below: { enabled: true, threshold: null }, above: DISABLED_RULE.above }
    expect(describeRule(none, 'F4')).toContain('no notes are labeled yet')
  })

  it('warns about reversed bounds', () => {
    expect(describeRule(rule(sp('C', 0, 5), sp('C', 0, 4)), 'G2')).toContain('overlap')
  })
})

describe('sampleRule', () => {
  const byText = (r: ClefLabelRule, clef: string) => new Map(sampleRule(r, clef).map((p) => [p.text, p]))

  it('marks B3 and C♯5 labeled and C4, E4, C5 unlabeled for the treble preset', () => {
    const sample = byText(TREBLE_PRESET, 'G2')
    expect(sample.get('B3')?.labeled).toBe(true)
    expect(sample.get('C♯5')?.labeled).toBe(true)
    for (const text of ['C4', 'E4', 'C5']) expect(sample.get(text)?.labeled, text).toBe(false)
  })

  it('is sorted low to high with one entry per piano key and flags the thresholds', () => {
    const sample = sampleRule(TREBLE_PRESET, 'G2')
    const midis = sample.map((p) => p.midi)
    expect(midis).toEqual([...midis].sort((a, b) => a - b))
    expect(new Set(midis).size).toBe(midis.length)
    expect(sample.filter((p) => p.isThreshold).map((p) => p.text)).toEqual(['C4', 'C5'])
    expect(sample.find((p) => p.text === 'C4')?.labeled).toBe(false)
  })

  it('keeps the entered spelling of a threshold', () => {
    const sample = sampleRule(rule(sp('B', 1, 3), null), 'G2')
    expect(sample.find((p) => p.isThreshold)?.text).toBe('B♯3')
    expect(sample.find((p) => p.text === 'C4')).toBeUndefined()
  })

  it('labels nothing for a disabled rule and ignores unusable thresholds', () => {
    expect(sampleRule(DISABLED_RULE, 'F4').every((p) => !p.labeled && !p.isThreshold)).toBe(true)
    const unset: ClefLabelRule = { below: { enabled: true, threshold: null }, above: DISABLED_RULE.above }
    expect(sampleRule(unset, 'F4').every((p) => !p.labeled)).toBe(true)
  })

  it('centers the sample on the clef staff', () => {
    const bass = sampleRule(DISABLED_RULE, 'F4').map((p) => p.text)
    expect(bass).toContain('D3')
    expect(bass).toContain('B1')
    const treble = sampleRule(DISABLED_RULE, 'G2').map((p) => p.text)
    expect(treble).toContain('B4')
    expect(treble).not.toContain('G1')
  })

  it('includes threshold neighbors far from the staff', () => {
    const sample = byText(rule(null, sp('C', 0, 7)), 'G2')
    expect(sample.get('C♯7')?.labeled).toBe(true)
    expect(sample.get('B6')?.labeled).toBe(false)
  })
})
