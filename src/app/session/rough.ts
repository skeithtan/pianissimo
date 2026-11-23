/**
 * The bars a run outside Repeat went worst in, for its result's Loop action (DECISIONS U142). Pure;
 * apart from `ranking.ts`, which loads with the expanded card: the pill needs this at once.
 */
import type { Timeline } from '../../core/engine'
import { MAX_CORE_BARS, adjacentRuns, withContextBars } from '../../core/history'
import type { GroupOutcome, PassageRange } from '../../core/model/practice'

/**
 * The roughest passage of a run: each bar weighs its wrong attacks and missed groups (`strict`: Keep
 * time, where a right key pressed too early is a timing slip and weighs nothing); of the runs of
 * adjacent bars with a weight the heaviest (the earlier of equals), cut to its heaviest
 * `MAX_CORE_BARS`, with a context bar on each side where the piece has one. Null when no bar has a
 * weight, or when it would cover every bar of the run anyway.
 */
export function roughPassage(
  outcomes: readonly GroupOutcome[],
  timeline: Pick<Timeline, 'groups'>,
  occurrenceCount: number,
  strict: boolean,
): PassageRange | null {
  const weights = new Map<number, number>()
  let first = Infinity
  let last = -Infinity
  for (const g of outcomes) {
    const occ = timeline.groups[g.group]?.occ
    if (occ === undefined) continue
    first = Math.min(first, occ)
    last = Math.max(last, occ)
    const wrong = strict ? Math.max(0, g.wrongAttacks - g.earlyAttacks) : g.wrongAttacks
    const weight = wrong + (g.missed ? 1 : 0)
    if (weight > 0) weights.set(occ, (weights.get(occ) ?? 0) + weight)
  }
  let core: PassageRange | null = null
  let heaviest = 0
  for (const bars of adjacentRuns(weights.keys())) {
    const weight = bars.reduce((sum, occ) => sum + weights.get(occ)!, 0)
    if (weight <= heaviest) continue
    heaviest = weight
    core = heaviestWindow(bars, weights)
  }
  if (!core) return null
  const passage = withContextBars(core, occurrenceCount)
  return passage.fromOcc <= first && passage.toOcc >= last ? null : passage
}

/** The heaviest `MAX_CORE_BARS` of adjacent bars (the earliest of equals); all of them when fewer. */
function heaviestWindow(bars: readonly number[], weights: ReadonlyMap<number, number>): PassageRange {
  const size = Math.min(bars.length, MAX_CORE_BARS)
  let best = 0
  let bestWeight = -1
  for (let i = 0; i + size <= bars.length; i++) {
    let weight = 0
    for (let k = i; k < i + size; k++) weight += weights.get(bars[k]!)!
    if (weight > bestWeight) {
      best = i
      bestWeight = weight
    }
  }
  return { fromOcc: bars[best]!, toOcc: bars[best + size - 1]! }
}
