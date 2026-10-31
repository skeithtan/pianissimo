/**
 * Data shapes and spec constants for measure histories and suggested practice
 * (spec "Suggested practice"). Everything here is plain JSON so the storage layer can
 * persist and export it unchanged.
 */
import type { AbandonEvent, ComparisonContext } from '../model/practice'

/** Rolling history length: each bar keeps its five most recent complete traversals. */
export const RECENT_TRAVERSALS = 5
/** Flag rule: at least this many complete traversals are needed before a bar can be flagged. */
export const FLAG_MIN_COMPLETE = 3
/** Flag rule: at least this many of them must contain a wrong-note attack. */
export const FLAG_MIN_ERROR_PASSES = 3
/** Flag rule: at least this percentage of the available traversals must contain mistakes. */
export const FLAG_MIN_ERROR_PERCENT = 60
/** Recovery: consecutive complete, clean, unassisted traversals needed per flagged bar. */
export const RECOVERY_STREAK = 3
/** Repeated-abandonment trigger: user-initiated restarts/stops after wrong notes in one bar. */
export const ABANDON_TRIGGER = 3
/** Abandon events retained per bar (older ones are dropped). */
export const ABANDON_RETAINED = 5
/** At most this many suggestions are shown at once. */
export const MAX_SUGGESTIONS = 3
/** A proposed passage, including its context bars, never exceeds this many bars. */
export const MAX_PASSAGE_BARS = 8
/** One context bar is added before and after the problem area. */
export const CONTEXT_BARS = 1
/** Resolved suggestions kept for the Improved section, per piece. */
export const MAX_IMPROVED_KEPT = 10

/** Comparison context without the passage: a bar is a bar in any passage. */
export type MeasureContext = Omit<ComparisonContext, 'passage'>

/** One complete traversal of a bar, reduced to what detection and recovery need. */
export interface TraversalSample {
  /** Timestamp of the attempt that produced it (ms since epoch). */
  readonly at: number
  readonly attemptId: string
  /** Contained at least one wrong-note attack, excluding loop-boundary reattacks. */
  readonly errorBearing: boolean
  /** A temporary hint, persistent label or keyboard guide was revealed for this bar. */
  readonly assisted: boolean
}

/** Rolling history for one (piece, measure context, occurrence). */
export interface BarRecord {
  readonly pieceId: string
  readonly measureContextKey: string
  /** Measure occurrence (performance order), so "bar 12 pass 2" has its own history. */
  readonly occ: number
  /** Up to five most recent complete traversals, oldest first. Partial traversals never appear. */
  readonly recent: readonly TraversalSample[]
  /** Consecutive complete, clean, unassisted traversals since the last break. */
  readonly cleanStreak: number
  /** Last attempt applied here (makes re-ingesting an attempt a no-op). */
  readonly lastAttemptId: string
  readonly updatedAt: number
}

export type SuggestionKind = 'traversal' | 'restart'
export type SuggestionStatus = 'active' | 'improved'

/**
 * A persisted suggestion: a run of adjacent flagged bars (at most `MAX_PASSAGE_BARS - 2 * CONTEXT_BARS`)
 * in one measure context. Context bars and display text are derived when shown.
 */
export interface SuggestionRecord {
  readonly id: string
  readonly kind: SuggestionKind
  readonly status: SuggestionStatus
  readonly measureContextKey: string
  readonly context: MeasureContext
  /** Flagged ("difficult") bars, inclusive, as occurrence indices. */
  readonly coreFrom: number
  readonly coreTo: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly improvedAt?: number
}

/** Everything the suggested-practice logic knows about one piece. */
export interface PieceHistory {
  readonly pieceId: string
  /** Per-piece "disable suggestions". Evidence is still recorded while disabled. */
  readonly disabled: boolean
  /** Keyed by `barKey(measureContextKey, occ)`. */
  readonly bars: Readonly<Record<string, BarRecord>>
  readonly suggestions: readonly SuggestionRecord[]
  /** Most recent user-initiated abandon events per bar, oldest first (at most `ABANDON_RETAINED`). */
  readonly abandons: Readonly<Record<string, readonly AbandonEvent[]>>
}

/** What an ingest changed, so storage can write only the affected records. */
export interface HistoryChanges {
  readonly bars: readonly BarRecord[]
  readonly suggestionsChanged: boolean
  /** Bar keys whose abandon list changed (the list in `history.abandons` is authoritative). */
  readonly abandonKeys: readonly string[]
}

export interface IngestResult {
  readonly history: PieceHistory
  readonly changes: HistoryChanges
}

export function emptyPieceHistory(pieceId: string): PieceHistory {
  return { pieceId, disabled: false, bars: {}, suggestions: [], abandons: {} }
}

export function barKey(measureContextKey: string, occ: number): string {
  return `${measureContextKey}#${occ}`
}
