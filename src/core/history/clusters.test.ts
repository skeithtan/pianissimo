import { describe, expect, it } from 'vitest'
import { MAX_CORE_BARS, adjacentRuns, chunkRun, withContextBars } from './clusters'

describe('adjacentRuns', () => {
  it('merges consecutive occurrences and sorts and de-duplicates the input', () => {
    expect(adjacentRuns([14, 12, 13, 30, 12, 31, 5])).toEqual([[5], [12, 13, 14], [30, 31]])
  })

  it('returns nothing for no bars and treats a gap of one as a break', () => {
    expect(adjacentRuns([])).toEqual([])
    expect(adjacentRuns([1, 3])).toEqual([[1], [3]])
  })
})

describe('chunkRun', () => {
  const run = (n: number, start = 0) => Array.from({ length: n }, (_, i) => start + i)
  const sizes = (n: number) => chunkRun(run(n)).map((c) => c.toOcc - c.fromOcc + 1)

  it('allows six difficult bars so that two context bars still fit in eight', () => {
    expect(MAX_CORE_BARS).toBe(6)
    expect(sizes(6)).toEqual([6])
  })

  it('splits evenly rather than leaving a stub', () => {
    expect(sizes(7)).toEqual([4, 3])
    expect(sizes(13)).toEqual([5, 4, 4])
    expect(sizes(12)).toEqual([6, 6])
  })

  it('covers every bar exactly once, in order', () => {
    for (let n = 1; n <= 40; n += 1) {
      const chunks = chunkRun(run(n, 10))
      expect(chunks[0]?.fromOcc).toBe(10)
      expect(chunks[chunks.length - 1]?.toOcc).toBe(10 + n - 1)
      for (let i = 1; i < chunks.length; i += 1) {
        expect(chunks[i]?.fromOcc).toBe((chunks[i - 1]?.toOcc ?? -1) + 1)
      }
      for (const c of chunks) expect(c.toOcc - c.fromOcc + 1).toBeLessThanOrEqual(MAX_CORE_BARS)
    }
  })

  it('returns nothing for an empty run', () => {
    expect(chunkRun([])).toEqual([])
  })
})

describe('withContextBars', () => {
  it('adds one bar on each side', () => {
    expect(withContextBars({ fromOcc: 12, toOcc: 14 }, 60)).toEqual({ fromOcc: 11, toOcc: 15 })
  })

  it('clamps to the score', () => {
    expect(withContextBars({ fromOcc: 0, toOcc: 2 }, 60)).toEqual({ fromOcc: 0, toOcc: 3 })
    expect(withContextBars({ fromOcc: 57, toOcc: 59 }, 60)).toEqual({ fromOcc: 56, toOcc: 59 })
  })

  it('never exceeds eight bars for a maximal core', () => {
    const p = withContextBars({ fromOcc: 20, toOcc: 25 }, 60)
    expect(p.toOcc - p.fromOcc + 1).toBe(8)
  })
})
