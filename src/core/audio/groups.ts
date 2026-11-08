/**
 * Maps a float position estimate (the audio follower's) to a `Timeline` group, apart from the
 * follower so the session bundles only this (DECISIONS P15).
 */
import type { Timeline } from '../engine/timeline'
import { toNumber } from '../music/rational'

/**
 * Index of the last group of `timeline` at or before `position` (−1 before the first). A session
 * calls `PlayFollower.audioReached` when it increases with enough confidence; groups are compared
 * in float whole notes with a 1e-6 tolerance.
 */
export function groupReached(timeline: Timeline, position: number): number {
  const gs = timeline.groups
  let lo = 0
  let hi = gs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (toNumber(gs[mid]!.position) <= position + 1e-6) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}
