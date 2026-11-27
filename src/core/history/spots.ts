/**
 * Mistake memory keyed by place in the score (`OnsetGroup.position`).
 *
 * A place is an unfolded performance position (`Rational`), so the same notes share one memory
 * across speed changes, loop-edge shifts, restarts and reloads, while a repeated bar's second
 * pass has its own place.
 */
import type { AttemptRecord, GroupOutcome } from '../model/practice'
import type { HandSelection } from '../model/score'
import { type Rational, key } from '../music/rational'
import { RECOVERY_STREAK } from './types'

/** Pause duration (ms) at or above which a clean visit is not quiet. */
export const PAUSE_FLOOR_MS = 250
/** Maximum visits retained per place (oldest dropped). */
export const SPOT_VISITS = 8
/** Maximum places retained per SpotMemory (place visited longest ago evicted). */
export const SPOT_LIMIT = 256

/** What SpotMemory reads of a timeline (the engine's `Timeline` satisfies it). */
export interface SpotTimeline {
  readonly groups: readonly {
    readonly position: Rational
    readonly pitches: readonly number[]
    readonly synthetic: boolean
  }[]
}

/** Records fold only into the memory of their own scope. */
export interface SpotScope {
  readonly scoreVersionId: string
  readonly handsId: string
  readonly hands: HandSelection
}

/** One pass's visit to a place: what happened there. */
export interface SpotVisit {
  readonly attemptId: string
  /** `AttemptRecord.createdAt`. */
  readonly at: number
  /** Played in this session (false: folded from stored history). Only live visits arm the guard. */
  readonly live: boolean
  readonly multiplier: number
  readonly strict: boolean
  /** Distinct wrong keys at the place, ascending (`GroupOutcome.wrongPitches`). */
  readonly wrong: readonly number[]
  /** `GroupOutcome.lateMs` (0 in strict transport). */
  readonly pauseMs: number
  readonly missed: boolean
  /** No wrong attack of any kind (`wrongAttacks === 0`) and not missed. */
  readonly clean: boolean
}

const EMPTY_VISITS: readonly SpotVisit[] = Object.freeze([])
const EMPTY_PITCHES: readonly number[] = Object.freeze([])

function isQuiet(visit: SpotVisit): boolean {
  return visit.clean && visit.pauseMs < PAUSE_FLOOR_MS
}

function isRecovered(visits: readonly SpotVisit[]): boolean {
  if (visits.length < RECOVERY_STREAK) return false
  for (let i = visits.length - RECOVERY_STREAK; i < visits.length; i++) {
    if (!isQuiet(visits[i]!)) return false
  }
  return true
}

function distinctSorted(pitches: readonly number[] | undefined): readonly number[] {
  if (!pitches || pitches.length === 0) return EMPTY_PITCHES
  if (pitches.length === 1) return [pitches[0]!]
  return [...new Set(pitches)].sort((a, b) => a - b)
}

function matchesScope(scope: SpotScope, record: AttemptRecord): boolean {
  return (
    record.context.scoreVersionId === scope.scoreVersionId &&
    record.context.handsId === scope.handsId &&
    record.context.hands === scope.hands
  )
}

function wasAttemptedWith(completed: ReadonlySet<number>, outcome: GroupOutcome): boolean {
  return (
    outcome.wrongAttacks > 0 ||
    (outcome.tieEndPresses ?? 0) > 0 ||
    outcome.missed === true ||
    completed.has(outcome.group)
  )
}

/** A group outcome that was really attempted, not just the place where a pass stopped. */
export function wasAttempted(record: AttemptRecord, outcome: GroupOutcome): boolean {
  return (
    outcome.wrongAttacks > 0 ||
    (outcome.tieEndPresses ?? 0) > 0 ||
    outcome.missed === true ||
    record.onsets.some((o) => o.group === outcome.group)
  )
}

function toVisit(record: AttemptRecord, outcome: GroupOutcome, live: boolean): SpotVisit {
  const strict = record.context.transport === 'strict'
  const missed = outcome.missed === true
  return {
    attemptId: record.id,
    at: record.createdAt,
    live,
    multiplier: record.context.multiplier,
    strict,
    wrong: distinctSorted(outcome.wrongPitches),
    pauseMs: strict ? 0 : outcome.lateMs,
    missed,
    clean: outcome.wrongAttacks === 0 && !missed,
  }
}

function insertVisit(visits: SpotVisit[], visit: SpotVisit): boolean {
  if (visits.length >= SPOT_VISITS && visit.at < visits[0]!.at) return false
  let i = visits.length
  while (i > 0 && visits[i - 1]!.at > visit.at) i--
  visits.splice(i, 0, visit)
  if (visits.length > SPOT_VISITS) visits.splice(0, visits.length - SPOT_VISITS)
  return true
}

export class SpotMemory {
  readonly #scope: SpotScope
  readonly #places = new Map<string, SpotVisit[]>()
  readonly #foldedIds = new Set<string>()

  constructor(scope: SpotScope) {
    this.#scope = scope
  }

  /** Fold one record. Returns false when nothing was added. */
  fold(record: AttemptRecord, timeline: SpotTimeline, live: boolean): boolean {
    if (record.kind !== 'scored' || !record.groups) return false
    if (!matchesScope(this.#scope, record)) return false
    if (record.groupsTotal !== timeline.groups.length) return false
    if (this.#foldedIds.has(record.id)) return false
    this.#foldedIds.add(record.id)

    const completed = new Set<number>()
    for (const o of record.onsets) completed.add(o.group)

    let added = false
    for (const outcome of record.groups) {
      const group = timeline.groups[outcome.group]
      if (!group || group.synthetic) continue
      if (!wasAttemptedWith(completed, outcome)) continue

      const visit = toVisit(record, outcome, live)
      const posKey = key(group.position)
      let visits = this.#places.get(posKey)
      if (!visits) {
        if (isQuiet(visit)) continue
        visits = [visit]
        this.#places.set(posKey, visits)
        this.#evictIfNeeded()
        if (this.#places.has(posKey)) added = true
      } else {
        if (!insertVisit(visits, visit)) continue
        added = true
        if (isRecovered(visits)) this.#places.delete(posKey)
      }
    }
    return added
  }

  /** Visits at a place, oldest first; empty when the place holds no memory. */
  history(position: Rational): readonly SpotVisit[] {
    return this.#places.get(key(position)) ?? EMPTY_VISITS
  }

  /** Latest visits running, the latest included, whose wrong keys include `pitch`. */
  streak(position: Rational, pitch: number): number {
    const visits = this.#places.get(key(position))
    if (!visits) return 0
    let count = 0
    for (let i = visits.length - 1; i >= 0; i--) {
      if (!visits[i]!.wrong.includes(pitch)) break
      count++
    }
    return count
  }

  /** Wrong keys to guard per group index of `timeline`. */
  guardFor(timeline: SpotTimeline): Map<number, Set<number>> {
    const out = new Map<number, Set<number>>()
    for (let i = 0; i < timeline.groups.length; i++) {
      const group = timeline.groups[i]!
      if (group.synthetic) continue
      const visits = this.#places.get(key(group.position))
      if (!visits) continue
      for (let j = visits.length - 1; j >= 0; j--) {
        const v = visits[j]!
        if (!v.live) continue
        if (v.wrong.length > 0) out.set(i, new Set(v.wrong))
        break
      }
    }
    return out
  }

  /** Places of `timeline` whose latest visit was not clean. */
  hotSpots(timeline: SpotTimeline): { readonly group: number; readonly level: 'faint' | 'firm' }[] {
    const out: { readonly group: number; readonly level: 'faint' | 'firm' }[] = []
    for (let i = 0; i < timeline.groups.length; i++) {
      const group = timeline.groups[i]!
      if (group.synthetic) continue
      const visits = this.#places.get(key(group.position))
      if (!visits || visits.length === 0) continue
      if (visits[visits.length - 1]!.clean) continue
      let notClean = 0
      const start = Math.max(0, visits.length - 3)
      for (let j = start; j < visits.length; j++) {
        if (!visits[j]!.clean) notClean++
      }
      out.push({ group: i, level: notClean >= 2 ? 'firm' : 'faint' })
    }
    return out
  }

  /** Group indices of `timeline` that `record` played clean and whose visit before it was not. */
  fixedBy(record: AttemptRecord, timeline: SpotTimeline): number[] {
    if (record.kind !== 'scored' || !record.groups) return []
    if (!matchesScope(this.#scope, record)) return []
    if (record.groupsTotal !== timeline.groups.length) return []

    const completed = new Set<number>()
    for (const o of record.onsets) completed.add(o.group)

    const out: number[] = []
    for (const outcome of record.groups) {
      const group = timeline.groups[outcome.group]
      if (!group || group.synthetic) continue
      if (!wasAttemptedWith(completed, outcome)) continue
      if (outcome.wrongAttacks !== 0 || outcome.missed === true) continue

      const visits = this.#places.get(key(group.position))
      if (!visits || visits.length === 0) continue

      let prior: SpotVisit | undefined
      const idx = visits.findIndex((v) => v.attemptId === record.id)
      if (idx >= 0) {
        prior = idx > 0 ? visits[idx - 1] : undefined
      } else {
        for (let j = visits.length - 1; j >= 0; j--) {
          if (visits[j]!.at <= record.createdAt) {
            prior = visits[j]
            break
          }
        }
      }
      if (prior && !prior.clean) out.push(outcome.group)
    }
    return out.sort((a, b) => a - b)
  }

  #evictIfNeeded(): void {
    while (this.#places.size > SPOT_LIMIT) {
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [k, visits] of this.#places) {
        const lastAt = visits[visits.length - 1]!.at
        if (lastAt < oldestAt) {
          oldestAt = lastAt
          oldestKey = k
        }
      }
      if (oldestKey === undefined) break
      this.#places.delete(oldestKey)
    }
  }
}
