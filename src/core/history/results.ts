import { USER_ABANDON_REASONS } from '../model/practice'
import type { AttemptRecord, ComparisonContext } from '../model/practice'

/**
 * Any assistance recorded for the attempt: note names (persistent labels, automatic or
 * requested hints) or the keyboard guide. Checks the detail fields as well as `level` so a
 * record can never read as unassisted while carrying exposure data.
 */
export function isAssistedAttempt(a: AttemptRecord): boolean {
  const s = a.assistance
  return (
    s.level !== 'none' ||
    s.persistentLabelNotes.length > 0 ||
    s.persistentLabelGroups.length > 0 ||
    s.hintRequests > 0 ||
    s.autoHints > 0 ||
    s.hintGroups.length > 0 ||
    s.keyboardShown
  )
}

/** Completed scored attempt with zero wrong attacks and no assistance. */
export function isCleanUnassistedCompletion(a: AttemptRecord): boolean {
  return (
    a.kind === 'scored' &&
    a.completion === 'completed' &&
    a.wrongAttacks === 0 &&
    (a.missedGroups ?? 0) === 0 &&
    !isAssistedAttempt(a)
  )
}

/** How a strict (rhythm mode) attempt kept time; see `timingAccuracy`. */
export interface TimingAccuracy {
  /** Groups judged: completed ones plus missed ones. */
  readonly groups: number
  /** Completed within ±tolerance of their scheduled time. */
  readonly onTime: number
  /** Completed more than the tolerance before their scheduled time. */
  readonly early: number
  /** Completed more than the tolerance after their scheduled time. */
  readonly late: number
  /** Groups the music passed before they were complete. */
  readonly missed: number
  /** Mean signed offset over completed groups in ms (negative = rushing); 0 with none. */
  readonly meanOffsetMs: number
  /** Mean absolute offset over completed groups in ms; 0 with none. */
  readonly meanAbsOffsetMs: number
}

/**
 * Timing accuracy of a strict-transport attempt from its per-group outcomes; null for gated and
 * free attempts and for records without per-group outcomes. Early and late mean beyond
 * `rhythm.toleranceMs`.
 */
export function timingAccuracy(a: AttemptRecord): TimingAccuracy | null {
  if (a.context.transport !== 'strict' || a.rhythm === undefined || a.groups === undefined) return null
  const tolerance = a.rhythm.toleranceMs
  let onTime = 0
  let early = 0
  let late = 0
  let missed = 0
  let sum = 0
  let sumAbs = 0
  for (const g of a.groups) {
    if (g.offsetMs !== undefined) {
      sum += g.offsetMs
      sumAbs += Math.abs(g.offsetMs)
      if (g.offsetMs < -tolerance) early++
      else if (g.offsetMs > tolerance) late++
      else onTime++
    } else if (g.missed === true) {
      missed++
    }
  }
  const completed = onTime + early + late
  return {
    groups: completed + missed,
    onTime,
    early,
    late,
    missed,
    meanOffsetMs: completed > 0 ? sum / completed : 0,
    meanAbsOffsetMs: completed > 0 ? sumAbs / completed : 0,
  }
}

/**
 * Actual minus expected completion time in seconds, or null when the attempt has no
 * scored timing (single onset group, unresolved tempo issues, never completed).
 */
export function timeDifferenceSec(a: AttemptRecord): number | null {
  if (a.timingUnscoredReason !== undefined) return null
  if (a.completionTimeSec === undefined || a.expectedTimeSec === null) return null
  return a.completionTimeSec - a.expectedTimeSec
}

/**
 * Ordering for "best clean unassisted performance": the smallest absolute time difference
 * wins (a faster result is not automatically better; rushing can cancel hesitation), ties
 * go to the more recent attempt. Attempts without scored timing rank after timed ones,
 * most recent first. Two strict (rhythm mode) attempts rank by mean absolute offset from the
 * scheduled times instead, fewest first.
 */
export function compareCleanRuns(a: AttemptRecord, b: AttemptRecord): number {
  const ta = timingAccuracy(a)
  const tb = timingAccuracy(b)
  if (ta !== null && tb !== null) {
    const byOffset = ta.meanAbsOffsetMs - tb.meanAbsOffsetMs
    if (byOffset !== 0) return byOffset
    return b.createdAt - a.createdAt
  }
  const da = timeDifferenceSec(a)
  const db = timeDifferenceSec(b)
  if (da !== null && db !== null) {
    const byDistance = Math.abs(da) - Math.abs(db)
    if (byDistance !== 0) return byDistance
  } else if (da !== null) {
    return -1
  } else if (db !== null) {
    return 1
  }
  return b.createdAt - a.createdAt
}

export interface PracticeStreak {
  /** Consecutive most recent completed attempts that met the pass condition. */
  readonly current: number
  /** Longest such run in this context. */
  readonly best: number
}

/**
 * A scored attempt the player gave up (stop or restart) after wrong attacks. It is not a
 * pass, so it ends a streak; device-caused interruptions never do.
 */
function isAbandonedAfterMistakes(a: AttemptRecord): boolean {
  const byUser =
    a.completion === 'abandoned' ||
    (a.interruptReason !== undefined && USER_ABANDON_REASONS.includes(a.interruptReason))
  return byUser && a.completion !== 'completed' && a.wrongAttacks > 0
}

/**
 * Practice streak: consecutive scored attempts meeting the selected pass condition
 * (`AttemptRecord.passed`) in one context. Pauses, disconnects, suspension, seeks and setting
 * changes are neutral: the spec says they never record a failed or successful completed
 * performance. A user stop or restart after wrong attacks is a failed pass and resets the run.
 */
export function practiceStreak(attempts: readonly AttemptRecord[]): PracticeStreak {
  const counted = attempts
    .filter((a) => a.kind === 'scored' && (a.completion === 'completed' || isAbandonedAfterMistakes(a)))
    .sort((a, b) => a.createdAt - b.createdAt)
  let run = 0
  let best = 0
  for (const a of counted) {
    run = a.completion === 'completed' && a.passed ? run + 1 : 0
    if (run > best) best = run
  }
  return { current: run, best }
}

/** Results for one comparison context. Attempts from other contexts are never mixed in. */
export interface ContextResults {
  readonly contextKey: string
  readonly context: ComparisonContext
  /** Best clean unassisted completion, shown separately from assisted practice. */
  readonly bestClean: AttemptRecord | null
  /** Every clean unassisted completion, best first. */
  readonly cleanRanking: readonly AttemptRecord[]
  /** Completed without assistance but with wrong attacks, newest first. */
  readonly unassistedWithErrors: readonly AttemptRecord[]
  /** Completed with assistance (names or keyboard), newest first; kept apart from rankings. */
  readonly assisted: readonly AttemptRecord[]
  /** Interrupted or abandoned: diagnostics only, never ranked, newest first. */
  readonly incomplete: readonly AttemptRecord[]
  readonly streak: PracticeStreak
  readonly lastAttemptAt: number
}

const newestFirst = (a: AttemptRecord, b: AttemptRecord): number => b.createdAt - a.createdAt

function summarize(contextKey: string, attempts: readonly AttemptRecord[]): ContextResults | null {
  const scored = attempts.filter((a) => a.kind === 'scored' && a.contextKey === contextKey)
  const first = scored[0]
  if (!first) return null
  const completed = scored.filter((a) => a.completion === 'completed')
  const cleanRanking = completed.filter(isCleanUnassistedCompletion).sort(compareCleanRuns)
  return {
    contextKey,
    context: first.context,
    bestClean: cleanRanking[0] ?? null,
    cleanRanking,
    unassistedWithErrors: completed.filter((a) => !isAssistedAttempt(a) && a.wrongAttacks > 0).sort(newestFirst),
    assisted: completed.filter(isAssistedAttempt).sort(newestFirst),
    incomplete: scored.filter((a) => a.completion !== 'completed').sort(newestFirst),
    streak: practiceStreak(scored),
    lastAttemptAt: scored.reduce((latest, a) => Math.max(latest, a.createdAt), 0),
  }
}

/** Results for one context, or null when it has no scored attempts. */
export function summarizeContext(attempts: readonly AttemptRecord[], contextKey: string): ContextResults | null {
  return summarize(contextKey, attempts)
}

/** Results grouped by comparison context, most recently practiced first. Ordinary reading is excluded. */
export function summarizeByContext(attempts: readonly AttemptRecord[]): ContextResults[] {
  const keys = new Set(attempts.filter((a) => a.kind === 'scored').map((a) => a.contextKey))
  const out: ContextResults[] = []
  for (const key of keys) {
    const r = summarize(key, attempts)
    if (r) out.push(r)
  }
  return out.sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
}
