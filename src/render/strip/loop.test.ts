import { describe, expect, it } from 'vitest'
import { clampRange, dragHandle, sameRange, tapSelect } from './loop'

describe('loop selection', () => {
  it('drags handles without inverting the band', () => {
    const r = { fromOcc: 3, toOcc: 6 }
    expect(dragHandle(r, 'start', 1)).toEqual({ fromOcc: 1, toOcc: 6 })
    expect(dragHandle(r, 'start', 9)).toEqual({ fromOcc: 6, toOcc: 6 })
    expect(dragHandle(r, 'end', 8)).toEqual({ fromOcc: 3, toOcc: 8 })
    expect(dragHandle(r, 'end', 0)).toEqual({ fromOcc: 3, toOcc: 3 })
  })

  it('selects with two taps in either order, including both boundary bars', () => {
    const first = tapSelect(null, 7)
    expect(first).toEqual({ range: { fromOcc: 7, toOcc: 7 }, anchor: 7, done: false })
    expect(tapSelect(first.anchor, 4)).toEqual({ range: { fromOcc: 4, toOcc: 7 }, anchor: null, done: true })
    expect(tapSelect(7, 9).range).toEqual({ fromOcc: 7, toOcc: 9 })
  })

  it('clamps and compares ranges', () => {
    expect(clampRange({ fromOcc: -2, toOcc: 99 }, 10)).toEqual({ fromOcc: 0, toOcc: 9 })
    expect(sameRange({ fromOcc: 1, toOcc: 2 }, { fromOcc: 1, toOcc: 2 })).toBe(true)
    expect(sameRange(null, { fromOcc: 1, toOcc: 2 })).toBe(false)
  })
})
