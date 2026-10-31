/**
 * Record shapes owned by storage. Everything is plain JSON except the retained source
 * bytes, so records survive structured clone, IndexedDB and export/restore unchanged.
 */
import type { PassageRange } from '../model/practice'
import type { HandSelection, ScorePackage } from '../model/score'
import type { Rational } from '../music/rational'
import type { AbandonEvent } from '../model/practice'
/** Per-group outcomes stored on scored `AttemptRecord`s (optional, additive). */
export type { AttemptRecord, GroupOutcome } from '../model/practice'
import type { SuggestionRecord } from '../history/types'

/** A tempo the user supplied when the score had none (spec: missing tempos require user input). */
export interface UserTempo {
  readonly beatBpm: number
  /** Beat unit in whole notes: quarter = 1/4, dotted quarter = 3/8. */
  readonly beatUnit: Rational
}

/**
 * Where "Resume from this position" continues (spec "Storage and recovery"). The performance
 * position is the authority; `group` is the onset-group index at save time and is only a hint.
 */
export interface ResumePosition {
  /** Measure occurrence, performance order. */
  readonly occ: number
  /** Performance position in whole notes. */
  readonly position: Rational
  readonly group?: number
  readonly hands: HandSelection
  readonly multiplier: number
  readonly savedAt: number
}

/** One library entry. Its heavy data (package, source) is stored separately by `scoreVersionId`. */
export interface PieceRecord {
  readonly id: string
  readonly title: string
  readonly composer?: string
  /** Selects the score package and source; histories are keyed by it so versions never mix. */
  readonly scoreVersionId: string
  readonly createdAt: number
  readonly lastOpenedAt: number
  /** Last selected speed for this piece (spec: remember the last selected speed per piece). */
  readonly lastMultiplier: number
  readonly userTempo?: UserTempo
  readonly lastHands: HandSelection
  readonly resume: ResumePosition | null
  readonly lastPassage: PassageRange | null
  /** Consecutive-pass target for Repeat; null = unlimited. */
  readonly repeatTarget: number | null
}

export interface NewPieceOptions {
  readonly id?: string
  readonly now?: number
}

/** A library entry for a freshly imported package, with the spec defaults. */
export function newPieceRecord(pkg: ScorePackage, options: NewPieceOptions = {}): PieceRecord {
  const now = options.now ?? Date.now()
  const { meta, scoreVersionId } = pkg.model
  return {
    id: options.id ?? newId(),
    title: meta.title,
    ...(meta.composer !== undefined ? { composer: meta.composer } : {}),
    scoreVersionId,
    createdAt: now,
    lastOpenedAt: now,
    lastMultiplier: 1,
    lastHands: 'both',
    resume: null,
    lastPassage: null,
    repeatTarget: null,
  }
}

export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Fields `updatePiece` may change; identity, creation time and the score version are fixed.
 * Passing `undefined` for `userTempo` or `composer` removes it.
 */
export type PiecePatch = Partial<
  Omit<PieceRecord, 'id' | 'scoreVersionId' | 'createdAt' | 'userTempo' | 'composer'>
> & {
  readonly userTempo?: UserTempo | undefined
  readonly composer?: string | undefined
}

/** Per-piece suggestion state: the persisted suggestions and the per-piece disable switch. */
export interface SuggestionStateRecord {
  readonly pieceId: string
  readonly disabled: boolean
  readonly suggestions: readonly SuggestionRecord[]
}

/** User-initiated abandon events for one bar (at most five, oldest first). */
export interface AbandonRecord {
  readonly pieceId: string
  readonly measureContextKey: string
  readonly occ: number
  readonly events: readonly AbandonEvent[]
}

/** Bookkeeping for one cached layout. The payload is stored separately so a read touches only this. */
export interface LayoutMeta {
  readonly key: string
  readonly scoreVersionId: string
  readonly approxBytes: number
  readonly createdAt: number
  readonly lastUsedAt: number
}

export interface LayoutPayload {
  readonly key: string
  readonly value: unknown
}

export interface LayoutCacheLimits {
  /** Total approximate bytes kept (default 50 MB). */
  readonly maxBytes: number
  /** Most entries kept (default 256). */
  readonly maxEntries: number
}

export const DEFAULT_LAYOUT_LIMITS: LayoutCacheLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxEntries: 256,
}
