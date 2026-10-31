import { describe, expect, it } from 'vitest'
import { rat, ZERO } from './rational'
import {
  type TempoMapData,
  effectiveTempoAt,
  multiplierForBpm,
  positionAtSeconds,
  quarterBpmFromBeat,
  secondsBetween,
  userTempoMap,
} from './tempo'

const q = rat(1, 4)

describe('tempo mathematics (spec acceptance: Tempo mathematics)', () => {
  it('four quarter attacks at quarter = 60 span 3 seconds; full duration 4 seconds', () => {
    const map = userTempoMap(60, q)
    // Attacks at 0, 1/4, 2/4, 3/4 → span from first to last attack.
    expect(secondsBetween(map, ZERO, rat(3, 4))).toBeCloseTo(3)
    expect(secondsBetween(map, ZERO, rat(1, 1))).toBeCloseTo(4)
  })

  it('a complete 6/8 bar at dotted quarter = 60 lasts 2 seconds', () => {
    const map = userTempoMap(60, rat(3, 8))
    expect(quarterBpmFromBeat(60, rat(3, 8))).toBeCloseTo(90)
    expect(secondsBetween(map, ZERO, rat(3, 4))).toBeCloseTo(2)
  })

  it('multiplier scales the entire map and preserves relative changes', () => {
    const map: TempoMapData = {
      segments: [
        { start: ZERO, quarterBpm: 120, beatUnit: q, beatBpm: 120, source: 'sound' },
        { start: rat(1, 1), quarterBpm: 90, beatUnit: q, beatBpm: 90, source: 'sound' },
      ],
    }
    expect(effectiveTempoAt(map, ZERO, 0.5).beatBpm).toBe(60)
    expect(effectiveTempoAt(map, ZERO, 2).beatBpm).toBe(240)
    expect(effectiveTempoAt(map, rat(2, 1), 0.5).beatBpm).toBe(45)
    expect(effectiveTempoAt(map, rat(2, 1), 2).beatBpm).toBe(180)
    const oneX = secondsBetween(map, ZERO, rat(2, 1))
    expect(oneX).toBeCloseTo(2 + 240 / 90)
    expect(secondsBetween(map, ZERO, rat(2, 1), 0.5)).toBeCloseTo(oneX * 2)
    expect(secondsBetween(map, ZERO, rat(2, 1), 2)).toBeCloseTo(oneX / 2)
    expect(secondsBetween(map, ZERO, rat(2, 1), 0.6)).toBeCloseTo(oneX / 0.6)
  })

  it('BPM entry derives a multiplier from the source tempo at the passage start', () => {
    const map = userTempoMap(120, q)
    expect(multiplierForBpm(map, ZERO, 60)).toBe(0.5)
  })

  it('positionAtSeconds inverts secondsBetween across segments', () => {
    const map: TempoMapData = {
      segments: [
        { start: ZERO, quarterBpm: 60, beatUnit: q, beatBpm: 60, source: 'sound' },
        { start: rat(1, 1), quarterBpm: 120, beatUnit: q, beatBpm: 120, source: 'sound' },
      ],
    }
    expect(positionAtSeconds(map, 4)).toBeCloseTo(1)
    expect(positionAtSeconds(map, 5)).toBeCloseTo(1.5)
    expect(positionAtSeconds(map, 2.5, 2)).toBeCloseTo(1.5)
  })

  it('rejects invalid multipliers', () => {
    const map = userTempoMap(60, q)
    expect(() => secondsBetween(map, ZERO, q, 0)).toThrow()
    expect(() => secondsBetween(map, ZERO, q, -1)).toThrow()
    expect(() => secondsBetween(map, ZERO, q, Number.NaN)).toThrow()
  })
})
