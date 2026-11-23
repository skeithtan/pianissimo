import { msg } from '../../i18n/messages'
/**
 * Pure derivation from the stored attempts of one piece/score version: the selected attempt's
 * scorecard and the history of its comparison context, for the practice result and Progress, and the
 * past passes by context (Progress). No DOM, no storage, no clocks, so it is unit-tested directly.
 *
 * Spec "Results and timing": results are compared only within one comparison context; incomplete
 * attempts keep their diagnostics but never enter rankings.
 */
import {
  buildScorecard,
  createBarLabeler,
  meetsPassCondition,
  practiceStreak,
  summarizeByContext,
} from '../../core/history'
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

/** The scored attempts of one comparison context. */
export interface PassGroup {
  readonly results: ContextResults
  readonly latest: AttemptRecord
  /** Passes in that context, unfinished ones included. */
  readonly count: number
}

export interface ResultsModel {
  readonly labeler: BarLabeler
  /** The attempt whose scorecard is shown; null when nothing was recorded yet. */
  readonly attempt: AttemptRecord | null
  readonly scorecard: Scorecard | null
  /** Streak in the attempt's context as of that attempt. */
  readonly streak: PracticeStreak | null
  /** History of the attempt's context only; null for ordinary reading or no attempt. */
  readonly history: ContextResults | null
  /** Scored attempts in the attempt's context. */
  readonly historyCount: number
}

const newest = (a: AttemptRecord, b: AttemptRecord): number => b.createdAt - a.createdAt || b.id.localeCompare(a.id)

export function deriveResults(input: ResultsInput): ResultsModel {
  const labeler = createBarLabeler(input.occurrences)
  const sorted = [...input.attempts].sort(newest)
  const requested = input.attemptId === undefined ? undefined : sorted.find((a) => a.id === input.attemptId)
  const attempt = requested ?? sorted[0] ?? null

  if (attempt === null) {
    return {
      labeler,
      attempt: null,
      scorecard: null,
      streak: null,
      history: null,
      historyCount: 0,
    }
  }

  const scored = sorted.filter((a) => a.kind === 'scored')
  const contexts = summarizeByContext(scored)
  const history = attempt.kind === 'scored' ? (contexts.find((c) => c.contextKey === attempt.contextKey) ?? null) : null
  const inContext = attempt.kind === 'scored' ? scored.filter((a) => a.contextKey === attempt.contextKey) : []
  const streak = history ? practiceStreak(inContext.filter((a) => a.createdAt <= attempt.createdAt)) : null

  return {
    labeler,
    attempt,
    scorecard: buildScorecard(attempt, streak ?? undefined),
    streak,
    history,
    historyCount: inContext.length,
  }
}

/** The scored attempts by comparison context, the most recently practiced first. */
export function passGroups(attempts: readonly AttemptRecord[]): PassGroup[] {
  const sorted = attempts.filter((a) => a.kind === 'scored').sort(newest)
  return summarizeByContext(sorted).flatMap((results) => {
    const mine = sorted.filter((a) => a.contextKey === results.contextKey)
    return mine[0] ? [{ results, latest: mine[0], count: mine.length }] : []
  })
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
  return msg('{0} (partial)', bars)
}

/** Wrong attacks that were right pitches pressed too early, when the record carries the count. */
export function earlyAttackCount(attempt: AttemptRecord): number | null {
  const value: unknown = attempt.earlyAttacks
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, attempt.wrongAttacks)
    : null
}

export type PassReason = 'passed' | 'wrong-notes' | 'timing' | 'missed' | 'incomplete'

/** Why an attempt did or did not meet the pass condition (completion, no wrong attacks, timing). */
export function passReason(attempt: AttemptRecord): PassReason {
  if (attempt.completion !== 'completed') return 'incomplete'
  if (meetsPassCondition(attempt)) return 'passed'
  if (attempt.wrongAttacks > 0) return 'wrong-notes'
  if ((attempt.missedGroups ?? 0) > 0) return 'missed'
  return 'timing'
}
