import { describe, expect, it } from 'vitest'
import { createBarLabeler } from './barLabels'
import { occurrences } from './testkit'

describe('bar labels', () => {
  const second = occurrences(4).map((o, i) => (i >= 2 ? { ...o, pass: 2 } : o))

  it('shows the printed number, with the pass only after the first', () => {
    const labeler = createBarLabeler(second)
    expect(labeler.label(0)).toBe('1')
    expect(labeler.label(3)).toBe('4 (pass 2)')
    expect(labeler.number(3)).toBe('4')
    expect(labeler.pass(3)).toBe(2)
  })

  it('formats single bars and ranges with an en dash', () => {
    const labeler = createBarLabeler(second)
    expect(labeler.range(1, 1)).toBe('bar 2')
    expect(labeler.range(0, 2)).toBe('bars 1–3 (pass 2)')
  })

  it('falls back to the performance index for unknown occurrences', () => {
    const labeler = createBarLabeler(occurrences(2))
    expect(labeler.label(9)).toBe('10')
    expect(labeler.pass(9)).toBe(1)
  })

  it('uses printed numbers that are not simple counters', () => {
    const [first, next] = occurrences(2)
    const labeler = createBarLabeler([
      { ...first!, number: '0' },
      { ...next!, number: '12a' },
    ])
    expect(labeler.range(0, 1)).toBe('bars 0–12a')
  })
})
