/**
 * Note-level passages outside Practice (U21, U22): Results names them by bar and beat, presets
 * keep their exact edges, and the overview draws them inside their bars.
 */
import { describe, expect, it } from 'vitest'
import { readHistoryState } from '../../app/routes'
import { buildScore, quarters } from '../../core/engine/testkit'
import { comparisonContext } from '../../core/history/testkit'
import { loopExtent, overviewMeasures, progressAt } from '../../ui/overviewMath'
import { deriveResults, passageText } from './model'

const score = buildScore({ notes: [0, 1, 2, 3, 4, 5, 6, 7].map((at) => ({ at, midi: 60 + at })), bars: 3 })
const labeler = deriveResults({ attempts: [], occurrences: score.occurrences }).labeler

describe('Results passage text', () => {
  it('names note-level loops by bar and beat, whole bars as before', () => {
    const whole = comparisonContext({ passage: { fromOcc: 0, toOcc: 1 } })
    expect(passageText(labeler, whole, score)).toBe('Bars 1–2')
    const sub = comparisonContext({ passage: { fromOcc: 0, toOcc: 1, start: quarters(2) } })
    expect(passageText(labeler, sub, score)).toBe('Bar 1, beat 3 – bar 2')
    const end = comparisonContext({ passage: { fromOcc: 0, toOcc: 1, end: quarters(6) } })
    expect(passageText(labeler, end, score)).toBe('Bar 1 – bar 2, beat 2')
  })

  it('without the score (an old version), says the passage was part of its bars', () => {
    const sub = comparisonContext({ passage: { fromOcc: 0, toOcc: 1, start: quarters(2) } })
    expect(passageText(labeler, sub, null)).toBe('Bars 1–2 (partial)')
  })
})

describe('Practice presets', () => {
  it('keep exact loop edges ("Practice again" of a note-level loop)', () => {
    const passage = { fromOcc: 0, toOcc: 1, start: quarters(2), end: { n: 3, d: 2 } }
    expect(readHistoryState({ preset: { passage } }).preset?.passage).toEqual(passage)
    expect(readHistoryState({ preset: { passage: { fromOcc: 0, toOcc: 1, start: { n: 1, d: 0 } } } }).preset).toEqual({
      passage: { fromOcc: 0, toOcc: 1 },
    })
  })
})

describe('overview loop region', () => {
  it('covers exact positions inside the boundary bars', () => {
    const measures = overviewMeasures(score)
    const whole = loopExtent(measures, 0, 1)!
    expect(whole.left).toBe(0)
    expect(whole.width).toBeCloseTo(2 / 3)
    const sub = loopExtent(measures, 0, 1, 0.5, 1.25)!
    expect(sub.left).toBeCloseTo(progressAt(measures, 0.5))
    expect(sub.left + sub.width).toBeCloseTo(progressAt(measures, 1.25))
  })
})
