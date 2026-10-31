/**
 * Source-position helpers. Score context (key, meter, clef, tempo, dynamics, ottava scope) is
 * positional in the *written* score: when a repeat jumps back, the context at the jump target
 * is what the score states there, not whatever was last performed.
 */
import { type Rational, cmp } from '../music/rational'
import type { SrcPos } from './read/types'

export function cmpPos(a: SrcPos, b: SrcPos): number {
  return a.m !== b.m ? a.m - b.m : cmp(a.at, b.at)
}

/** Items sorted by source position (stable for equal positions) with "latest at or before" lookup. */
export class PosIndex<T extends SrcPos> {
  readonly items: readonly T[]

  constructor(items: readonly T[]) {
    this.items = items
      .map((item, i) => [item, i] as const)
      .sort((a, b) => cmpPos(a[0], b[0]) || a[1] - b[1])
      .map(([item]) => item)
  }

  /** Index of the last item at or before `(m, at)`; with `at` null, the last item before measure `m` (-1 if none). */
  private lastIndexAtOrBefore(m: number, at: Rational | null): number {
    let lo = 0
    let hi = this.items.length - 1
    let ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const it = this.items[mid]!
      const c = it.m !== m ? it.m - m : at === null ? 1 : cmp(it.at, at)
      if (c <= 0) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }

  /** Latest item at or before `pos` (an item exactly at `pos` applies). */
  at(m: number, at: Rational): T | undefined {
    const i = this.lastIndexAtOrBefore(m, at)
    return i >= 0 ? this.items[i] : undefined
  }

  /** Latest item in an earlier measure (context in effect when measure `m` begins, before its own changes). */
  beforeMeasure(m: number): T | undefined {
    const i = this.lastIndexAtOrBefore(m, null)
    return i >= 0 ? this.items[i] : undefined
  }

  /** Items inside measure `m`, in position order. */
  inMeasure(m: number): T[] {
    const out: T[] = []
    for (let i = this.lastIndexAtOrBefore(m, null) + 1; i < this.items.length; i++) {
      const it = this.items[i]!
      if (it.m !== m) break
      out.push(it)
    }
    return out
  }

  get first(): T | undefined {
    return this.items[0]
  }
}
