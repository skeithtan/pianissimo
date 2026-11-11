import { describe, expect, it } from 'vitest'
import { TRANSPORT_KINDS, measureContextKey } from '../model/practice'
import { parseMeasureContextKey, toMeasureContext } from './contextKey'
import { comparisonContext } from './testkit'

describe('measure context keys', () => {
  it('drops the passage: a bar is a bar in any passage', () => {
    const a = toMeasureContext(comparisonContext({ passage: { fromOcc: 1, toOcc: 4 } }))
    const b = toMeasureContext(comparisonContext({ passage: { fromOcc: 8, toOcc: 30 } }))
    expect(measureContextKey(a)).toBe(measureContextKey(b))
    expect(a).not.toHaveProperty('passage')
  })

  it('separates every comparison dimension', () => {
    const base = measureContextKey(toMeasureContext(comparisonContext()))
    const variants = [
      comparisonContext({ scoreVersionId: 'v2' }),
      comparisonContext({ hands: 'left' }),
      comparisonContext({ tempoMapId: 'other' }),
      comparisonContext({ multiplier: 1.25 }),
      comparisonContext({ rollPolicy: 'roll-v2' }),
      comparisonContext({ transport: 'accompaniment' }),
      comparisonContext({ matchingRules: 'match-v2' }),
    ]
    for (const v of variants) expect(measureContextKey(toMeasureContext(v))).not.toBe(base)
  })

  it('round-trips keys, including custom speeds and score ids containing a pipe', () => {
    for (const over of [
      {},
      { multiplier: 0.6 },
      { hands: 'right' as const, transport: 'accompaniment' as const },
      { scoreVersionId: 'abc|def' },
    ]) {
      const context = toMeasureContext(comparisonContext(over))
      expect(parseMeasureContextKey(measureContextKey(context))).toEqual(context)
    }
  })

  it('round-trips every transport kind, including strict matching rules and a piped score id', () => {
    for (const transport of TRANSPORT_KINDS) {
      const matchingRules = transport === 'strict' ? 'strict-v1-tol-150ms' : 'match-v1'
      for (const scoreVersionId of ['v1', 'abc|def']) {
        const context = toMeasureContext(comparisonContext({ transport, matchingRules, scoreVersionId }))
        expect(parseMeasureContextKey(measureContextKey(context))).toEqual(context)
      }
    }
  })

  it('rejects keys it did not produce', () => {
    expect(parseMeasureContextKey('')).toBeNull()
    expect(parseMeasureContextKey('legacy-key')).toBeNull()
    expect(parseMeasureContextKey('v1|sideways|tm|1.0000|r|free|m')).toBeNull()
    expect(parseMeasureContextKey('v1|both|tm|1.0000|r|sometimes|m')).toBeNull()
    expect(parseMeasureContextKey('v1|both|h1|tm|1.0000|r|sometimes|m')).toBeNull()
    expect(parseMeasureContextKey('v1|both|tm|zero|r|free|m')).toBeNull()
    expect(parseMeasureContextKey('v1|both|tm|-1.0000|r|free|m')).toBeNull()
    expect(parseMeasureContextKey('v1|both|tm|1|r|free|m')).toBeNull()
  })
})
