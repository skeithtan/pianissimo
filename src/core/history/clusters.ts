import type { PassageRange } from '../model/practice'
import { CONTEXT_BARS, MAX_PASSAGE_BARS } from './types'

/** Largest run of difficult bars in one passage once both context bars are added. */
export const MAX_CORE_BARS = MAX_PASSAGE_BARS - 2 * CONTEXT_BARS

/** Maximal runs of consecutive occurrence indices ("merge adjacent flagged bars"). */
export function adjacentRuns(occs: Iterable<number>): number[][] {
  const sorted = [...new Set(occs)].sort((a, b) => a - b)
  const runs: number[][] = []
  let current: number[] = []
  for (const occ of sorted) {
    const last = current[current.length - 1]
    if (last !== undefined && occ === last + 1) {
      current.push(occ)
    } else {
      if (current.length > 0) runs.push(current)
      current = [occ]
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/**
 * Split a run of difficult bars into passages of at most `MAX_CORE_BARS`, as evenly as
 * possible (7 bars become 4 + 3, not 6 + 1), so that each passage with its two context
 * bars stays within eight bars.
 */
export function chunkRun(run: readonly number[]): PassageRange[] {
  if (run.length === 0) return []
  const parts = Math.ceil(run.length / MAX_CORE_BARS)
  const base = Math.floor(run.length / parts)
  const extra = run.length % parts
  const chunks: PassageRange[] = []
  let index = 0
  for (let p = 0; p < parts; p += 1) {
    const size = base + (p < extra ? 1 : 0)
    const first = run[index]
    const last = run[index + size - 1]
    if (first === undefined || last === undefined) break
    chunks.push({ fromOcc: first, toOcc: last })
    index += size
  }
  return chunks
}

/**
 * The practiced range: the difficult bars plus one context bar before and after where the
 * score has them.
 */
export function withContextBars(core: PassageRange, occurrenceCount: number): PassageRange {
  return {
    fromOcc: Math.max(0, core.fromOcc - CONTEXT_BARS),
    toOcc: Math.min(occurrenceCount - 1, core.toOcc + CONTEXT_BARS),
  }
}
