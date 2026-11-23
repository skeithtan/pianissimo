/**
 * A Wait run outside Repeat (DECISIONS U142): the reading from its first note to the piece's last
 * one, in however many traversals the engine made of it (a seek, a speed change, browsing, a
 * disconnect). Each traversal is folded in when it ends, so nothing runs per key press and what is
 * kept is bounded by the piece's onset groups. Pure, in memory only: a run is never stored.
 */
import type { AttemptRecord, ComparisonContext, GroupOutcome } from '../../core/model/practice'

/** What a run keeps of one onset group: the latest time it was played. */
interface KeptGroup {
  readonly outcome: GroupOutcome
  readonly completed: boolean
  /** The visit it was played in (`addTraversal`). */
  readonly visit: number
}

export interface ReadingRun {
  /** Engine group the run began at (Again, P30). */
  readonly startGroup: number
  /** The latest traversal's. */
  readonly id: string
  readonly context: ComparisonContext
  readonly contextKey: string
  readonly groups: ReadonlyMap<number, KeptGroup>
}

/** A finished run as the result, its card, the score's marks and the repeated-mistake check see it. */
export interface RunRecord {
  readonly kind: 'run'
  readonly id: string
  readonly context: ComparisonContext
  readonly contextKey: string
  readonly startGroup: number
  /** One entry per group played in the run, ascending. */
  readonly groups: readonly GroupOutcome[]
  readonly wrongAttacks: number
  readonly groupsTotal: number
  readonly groupsFirstPass: number
  /** No wrong note, whatever help was used, as for a loop (U144); reading has no time to keep. */
  readonly passed: boolean
  /** The visit each group's outcome is of: the captured presses of its other visits are not the run's. */
  readonly visits: ReadonlyMap<number, number>
}

/** A pass the result card can show: a scored attempt, or a finished Wait run. */
export type PassRecord = AttemptRecord | RunRecord

/**
 * The run with `record`'s traversal added. Per group the latest time it was played wins: completed, or
 * tried with a wrong key and left. A group only reached (the cursor waited there, or part of a chord
 * was played before a jump away) keeps what it had. `visit` numbers the stretches of playing without a
 * jump; a speed change splits a traversal inside one, so the group it was at continues and its two
 * parts are added up.
 */
export function addTraversal(run: ReadingRun | null, record: AttemptRecord, visit: number): ReadingRun {
  const groups = new Map(run?.groups ?? [])
  const completed = new Set(record.onsets.map((o) => o.group))
  for (const outcome of record.groups ?? []) {
    const played: KeptGroup = {
      outcome,
      completed: completed.has(outcome.group),
      visit,
    }
    const before = groups.get(outcome.group)
    if (before?.visit === visit) groups.set(outcome.group, continued(before, played))
    else if (played.completed || outcome.wrongAttacks > 0) groups.set(outcome.group, played)
  }
  return {
    startGroup: run?.startGroup ?? record.groups?.[0]?.group ?? 0,
    id: record.id,
    context: record.context,
    contextKey: record.contextKey,
    groups,
  }
}

/** The same group on both sides of a speed change: one stretch of playing. */
function continued(a: KeptGroup, b: KeptGroup): KeptGroup {
  const at = b.completed ? b.outcome : a.outcome
  return {
    outcome: {
      ...at,
      wrongAttacks: a.outcome.wrongAttacks + b.outcome.wrongAttacks,
      earlyAttacks: a.outcome.earlyAttacks + b.outcome.earlyAttacks,
      wrongPitches: [...(a.outcome.wrongPitches ?? []), ...(b.outcome.wrongPitches ?? [])],
      tieEndPresses: (a.outcome.tieEndPresses ?? 0) + (b.outcome.tieEndPresses ?? 0),
    },
    completed: a.completed || b.completed,
    visit: b.visit,
  }
}

/** The finished run. */
export function runRecord(run: ReadingRun): RunRecord {
  const kept = [...run.groups.values()].sort((a, b) => a.outcome.group - b.outcome.group)
  let wrongAttacks = 0
  let groupsFirstPass = 0
  const visits = new Map<number, number>()
  for (const k of kept) {
    wrongAttacks += k.outcome.wrongAttacks
    if (k.completed && k.outcome.wrongAttacks === 0) groupsFirstPass++
    visits.set(k.outcome.group, k.visit)
  }
  return {
    kind: 'run',
    id: `${run.id}-run`,
    context: run.context,
    contextKey: run.contextKey,
    startGroup: run.startGroup,
    groups: kept.map((k) => k.outcome),
    wrongAttacks,
    groupsTotal: kept.length,
    groupsFirstPass,
    passed: kept.length > 0 && wrongAttacks === 0,
    visits,
  }
}
