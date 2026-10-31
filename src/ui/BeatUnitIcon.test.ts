import { describe, expect, it } from 'vitest'
import { rat } from '../core/music/rational'
import { beatUnitShape } from './BeatUnitIcon'

describe('beatUnitShape', () => {
  it('maps plain units to heads and flags', () => {
    expect(beatUnitShape(rat(1, 1))).toEqual({ head: 'whole', flags: 0, dotted: false })
    expect(beatUnitShape(rat(1, 2))).toEqual({ head: 'open', flags: 0, dotted: false })
    expect(beatUnitShape(rat(1, 4))).toEqual({ head: 'filled', flags: 0, dotted: false })
    expect(beatUnitShape(rat(1, 8))).toEqual({ head: 'filled', flags: 1, dotted: false })
    expect(beatUnitShape(rat(1, 16))).toEqual({ head: 'filled', flags: 2, dotted: false })
  })

  it('recognizes single-dotted units (a dotted quarter is 3/8)', () => {
    expect(beatUnitShape(rat(3, 8))).toEqual({ head: 'filled', flags: 0, dotted: true })
    expect(beatUnitShape(rat(3, 4))).toEqual({ head: 'open', flags: 0, dotted: true })
    expect(beatUnitShape(rat(3, 16))).toEqual({ head: 'filled', flags: 1, dotted: true })
  })

  it('returns null for unusual units', () => {
    expect(beatUnitShape(rat(5, 8))).toBeNull()
  })
})
