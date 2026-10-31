import type { MeasureTraversal } from '../model/practice'
import { RECENT_TRAVERSALS } from './types'
import type { BarRecord, TraversalSample } from './types'

/**
 * Error-bearing = at least one wrong attack, not counting synthetic loop-boundary reattacks
 * (spec: boundary reattacks must not inflate the original passage's mistake history).
 */
export function isErrorBearing(t: MeasureTraversal): boolean {
  return t.wrongAttacksExcludingBoundary > 0
}

/** Assisted = temporary hint, persistent label (incl. read-ahead exposure) or keyboard guide. */
export function isAssisted(t: MeasureTraversal): boolean {
  return t.tempHint || t.persistentLabel || t.keyboard
}

export interface TraversalSource {
  readonly pieceId: string
  readonly measureContextKey: string
  readonly attemptId: string
  readonly at: number
}

/**
 * Fold one traversal into a bar's record. Returns undefined when nothing changes
 * (a partial traversal with no observed mistakes or assistance).
 *
 * - Complete: enters the rolling window of five. It advances the clean streak only when it
 *   has no wrong attack and no assistance; otherwise the streak resets.
 * - Partial: never enters the window (so never counts as clean and stays out of the
 *   percentages), never advances the streak, and breaks it when mistakes or assistance
 *   were observed.
 */
export function applyTraversal(
  bar: BarRecord | undefined,
  t: MeasureTraversal,
  source: TraversalSource,
): BarRecord | undefined {
  const errorBearing = isErrorBearing(t)
  const assisted = isAssisted(t)
  const base: BarRecord = bar ?? {
    pieceId: source.pieceId,
    measureContextKey: source.measureContextKey,
    occ: t.occ,
    recent: [],
    cleanStreak: 0,
    lastAttemptId: '',
    updatedAt: source.at,
  }

  if (!t.complete) {
    if ((!errorBearing && !assisted) || base.cleanStreak === 0) return undefined
    return { ...base, cleanStreak: 0, lastAttemptId: source.attemptId, updatedAt: source.at }
  }

  const sample: TraversalSample = {
    at: source.at,
    attemptId: source.attemptId,
    errorBearing,
    assisted,
  }
  return {
    ...base,
    recent: [...base.recent, sample].slice(-RECENT_TRAVERSALS),
    cleanStreak: errorBearing || assisted ? 0 : base.cleanStreak + 1,
    lastAttemptId: source.attemptId,
    updatedAt: source.at,
  }
}
