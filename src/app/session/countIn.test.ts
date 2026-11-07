import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { ZERO, rat } from '../../core/music/rational'
import { countInPlan } from './countIn'

const note = [{ at: 0, midi: 60 }]

describe('countInPlan', () => {
  it('counts one bar of the meter at the start position, at the tempo divided by the speed', () => {
    const m = buildScore({ notes: note, meter: [3, 4], tempo: { bpm: 120 } })
    expect(countInPlan(m, m.tempo, ZERO, 1)).toEqual({ beats: 3, beatMs: 500 })
    expect(countInPlan(m, m.tempo, ZERO, 0.5)).toEqual({ beats: 3, beatMs: 1000 })
  })

  it('counts compound meters in dotted beats (numerator above 4 and divisible by 3)', () => {
    const six = buildScore({ notes: note, meter: [6, 8], tempo: { bpm: 60 } })
    // A dotted quarter at quarter = 60 lasts 1.5 s.
    expect(countInPlan(six, six.tempo, ZERO, 1)).toEqual({ beats: 2, beatMs: 1500 })
    const twelve = buildScore({ notes: note, meter: [12, 8], tempo: { bpm: 60 } })
    expect(countInPlan(twelve, twelve.tempo, ZERO, 1).beats).toBe(4)
    // 3/8 is not compound here: three eighth beats.
    const three = buildScore({ notes: note, meter: [3, 8], tempo: { bpm: 60 } })
    expect(countInPlan(three, three.tempo, ZERO, 1)).toEqual({ beats: 3, beatMs: 500 })
  })

  it('counts four quarter beats without a meter', () => {
    const m = buildScore({ notes: note, tempo: { bpm: 60 } })
    const bare = { ...m, meters: [] }
    expect(countInPlan(bare, m.tempo, ZERO, 1)).toEqual({ beats: 4, beatMs: 1000 })
  })

  it('uses the tempo in effect at the start position', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 4, midi: 62 },
      ],
      bars: 2,
      tempo: [
        { start: ZERO, quarterBpm: 60, beatUnit: rat(1, 4), beatBpm: 60, source: 'sound' },
        { start: rat(1, 1), quarterBpm: 120, beatUnit: rat(1, 4), beatBpm: 120, source: 'sound' },
      ],
    })
    expect(countInPlan(m, m.tempo, rat(1, 1), 1)).toEqual({ beats: 4, beatMs: 500 })
  })
})
