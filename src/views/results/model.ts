/**
 * Pure derivation for the Results view: from the stored attempts of one piece/score version to
 * the selected attempt, its scorecard and the history of its comparison context. No DOM, no
 * storage, no clocks, so it is unit-tested directly.
 *
 * Spec "Results and timing": results are compared only within one comparison context; the best
 * clean unassisted run is kept apart from assisted practice; incomplete attempts keep their
 * diagnostics but never enter rankings.
 */
import { buildScorecard, createBarLabeler, practiceStreak, summarizeByContext } from '../../core/history'
import type { BarLabeler, ContextResults, PracticeStreak, Scorecard } from '../../core/history'
import { describePassage, isWholeBars, type PassageWords } from '../../core/model/passage'
import type { AttemptRecord, ComparisonContext } from '../../core/model/practice'
import type { MeasureOccurrence } from '../../core/model/score'

export interface ResultsInput {
  /** Every stored attempt of the piece for one score version (scored and, if kept, reading). */
  readonly attempts: readonly AttemptRecord[]
  readonly occurrences: readonly MeasureOccurrence[]
  /** The attempt to show; omitted or unknown = the most recent one. */
  readonly attemptId?: string | undefined
}

export interface OtherContext {
  readonly results: ContextResults
  /** Newest scored attempt in that context ("View latest"). */
  readonly latest: AttemptRecord
  /** Scored attempts in that context. */
  readonly count: number
}

export interface ResultsModel {
  readonly labeler: BarLabeler
  /** The attempt whose scorecard is shown; null when nothing was recorded yet. */
  readonly attempt: AttemptRecord | null
  /** The most recent attempt (what "Back to latest" selects). */
  readonly latest: AttemptRecord | null
  /** The requested attempt id was not found, so the latest is shown instead. */
  readonly requestedMissing: boolean
  readonly isLatest: boolean
  readonly scorecard: Scorecard | null
  /** Streak in the attempt's context as of that attempt. */
  readonly streak: PracticeStreak | null
  /** History of the attempt's context only; null for ordinary reading or no attempt. */
  readonly history: ContextResults | null
  /** Scored attempts in the attempt's context. */
  readonly historyCount: number
  /** Other comparison contexts of this score version, most recently practiced first. */
  readonly others: readonly OtherContext[]
}

const newest = (a: AttemptRecord, b: AttemptRecord): number => b.createdAt - a.createdAt || b.id.localeCompare(a.id)

export function deriveResults(input: ResultsInput): ResultsModel {
  const labeler = createBarLabeler(input.occurrences)
  const sorted = [...input.attempts].sort(newest)
  const latest = sorted[0] ?? null
  const requested = input.attemptId === undefined ? undefined : sorted.find((a) => a.id === input.attemptId)
  const attempt = requested ?? latest
  const requestedMissing = input.attemptId !== undefined && requested === undefined && attempt !== null

  if (attempt === null) {
    return {
      labeler,
      attempt: null,
      latest: null,
      requestedMissing: false,
      isLatest: true,
      scorecard: null,
      streak: null,
      history: null,
      historyCount: 0,
      others: [],
    }
  }

  const scored = sorted.filter((a) => a.kind === 'scored')
  const contexts = summarizeByContext(scored)
  const history = attempt.kind === 'scored' ? (contexts.find((c) => c.contextKey === attempt.contextKey) ?? null) : null
  const inContext = attempt.kind === 'scored' ? scored.filter((a) => a.contextKey === attempt.contextKey) : []
  const streak = history ? practiceStreak(inContext.filter((a) => a.createdAt <= attempt.createdAt)) : null

  const others: OtherContext[] = []
  for (const results of contexts) {
    if (history !== null && results.contextKey === history.contextKey) continue
    const mine = scored.filter((a) => a.contextKey === results.contextKey)
    const first = mine[0]
    if (first === undefined) continue // sorted newest first
    others.push({ results, latest: first, count: mine.length })
  }

  return {
    labeler,
    attempt,
    latest,
    requestedMissing,
    isLatest: attempt.id === latest?.id,
    scorecard: buildScorecard(attempt, streak ?? undefined),
    streak,
    history,
    historyCount: inContext.length,
    others,
  }
}

/**
 * "Bars 12–16" for a comparison context's passage, with repeat passes labeled; a note-level loop
 * reads "Bar 12, beat 3 – bar 14" (U22) given the score's `words`, else "Bars 12–14 (partial)".
 */
export function passageText(labeler: BarLabeler, context: ComparisonContext, words?: PassageWords | null): string {
  const p = context.passage
  const text = labeler.range(p.fromOcc, p.toOcc)
  const bars = text.charAt(0).toUpperCase() + text.slice(1)
  if (isWholeBars(p)) return bars
  if (words && p.toOcc < words.occurrences.length) {
    try {
      return describePassage(words, p, context.hands)
    } catch {
      // A passage that no longer fits the score: fall back to its bars.
    }
  }
  return `${bars} (partial)`
}

/** Wrong attacks that were right pitches pressed too early, when the record carries the count. */
export function earlyAttackCount(attempt: AttemptRecord): number | null {
  const value: unknown = attempt.earlyAttacks
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, attempt.wrongAttacks)
    : null
}

export type PassReason = 'passed' | 'wrong-notes' | 'assistance' | 'timing' | 'incomplete'

/** Why an attempt did or did not meet the pass condition (completion, no wrong attacks, no assistance). */
export function passReason(attempt: AttemptRecord, assisted: boolean): PassReason {
  if (attempt.completion !== 'completed') return 'incomplete'
  if (attempt.passed) return 'passed'
  if (attempt.wrongAttacks > 0) return 'wrong-notes'
  if (assisted) return 'assistance'
  return 'timing'
}
