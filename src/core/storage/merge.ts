/**
 * Pure merge rules used by restore (spec "Storage and recovery": export and restore transfer
 * the library and history between devices). Restore merges by id and never deletes local data:
 * immutable records are kept, mutable ones resolve by recency, and lists are unioned.
 */
import { ABANDON_RETAINED, MAX_IMPROVED_KEPT } from '../history/types'
import type { BarRecord, SuggestionRecord } from '../history/types'
import type { AbandonEvent } from '../model/practice'
import type { ScorePackage } from '../model/score'
import type { AbandonRecord, PieceRecord, SuggestionStateRecord } from './records'

/** Structural equality for JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const rb = b as Record<string, unknown>
  return ka.every((k) => k in rb && deepEqual((a as Record<string, unknown>)[k], rb[k]))
}

/** True when restore takes the backup's copy of a piece present on both sides (ties keep local). */
export function incomingPieceWins(local: PieceRecord, incoming: PieceRecord): boolean {
  return incoming.lastOpenedAt > local.lastOpenedAt
}

/**
 * The more recently opened record supplies the state (resume position, last speed, hands,
 * passage, score version); a tempo or composer missing there is filled from the other side
 * only when both records are on the same score version (another version's tempo would
 * override the score's own one).
 */
export function mergePiece(local: PieceRecord, incoming: PieceRecord): PieceRecord {
  const incomingNewer = incomingPieceWins(local, incoming)
  const base = incomingNewer ? incoming : local
  const other = incomingNewer ? local : incoming
  const sameVersion = base.scoreVersionId === other.scoreVersionId
  const tempo = base.userTempo ?? (sameVersion ? other.userTempo : undefined)
  const composer = base.composer ?? (sameVersion ? other.composer : undefined)
  return {
    ...base,
    createdAt: Math.min(local.createdAt, incoming.createdAt),
    ...(tempo !== undefined ? { userTempo: tempo } : {}),
    ...(composer !== undefined ? { composer } : {}),
  }
}

/** Rolling windows are not additive: the more recently updated record wins. */
export function mergeBar(local: BarRecord, incoming: BarRecord): BarRecord {
  return incoming.updatedAt > local.updatedAt ? incoming : local
}

/**
 * Union of suggestions by id (the more recently updated copy wins), improved ones trimmed to
 * the retained count. The local per-piece "disabled" switch is kept.
 */
export function mergeSuggestionState(
  local: SuggestionStateRecord,
  incoming: SuggestionStateRecord,
): SuggestionStateRecord {
  const byId = new Map<string, SuggestionRecord>()
  for (const s of local.suggestions) byId.set(s.id, s)
  for (const s of incoming.suggestions) {
    const existing = byId.get(s.id)
    if (!existing || s.updatedAt > existing.updatedAt) byId.set(s.id, s)
  }
  const all = [...byId.values()]
  const dropped = new Set(
    all
      .filter((s) => s.status === 'improved')
      .sort((a, b) => (b.improvedAt ?? 0) - (a.improvedAt ?? 0))
      .slice(MAX_IMPROVED_KEPT)
      .map((s) => s.id),
  )
  return { ...local, suggestions: all.filter((s) => !dropped.has(s.id)) }
}

/** Union of abandon events (same time and reason = same event), newest five kept. */
export function mergeAbandon(local: AbandonRecord, incoming: AbandonRecord): AbandonRecord {
  const seen = new Set<string>()
  const events: AbandonEvent[] = []
  for (const e of [...local.events, ...incoming.events]) {
    const key = `${e.at}|${e.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push(e)
  }
  events.sort((a, b) => a.at - b.at)
  return { ...local, events: events.slice(-ABANDON_RETAINED) }
}

/** How much user input a package carries: confirmed hands and a usable tempo. */
function packageRank(pkg: ScorePackage): number {
  return (pkg.model.hands.confirmed ? 1 : 0) + (pkg.model.tempo.segments.length > 0 ? 1 : 0)
}

/**
 * Which copy of a score version's package restore keeps. One that carries more user input
 * (confirmed hands, a tempo) always wins, so a reviewed package is never lost to an unreviewed
 * one (ST3). Otherwise the package follows the piece records: it comes from the side whose
 * piece records of this version win the merge (`incomingWins`), so a piece's practice tempo
 * and hands match the package practice uses.
 */
export function preferPackage(local: ScorePackage, incoming: ScorePackage, incomingWins = false): ScorePackage {
  const rankLocal = packageRank(local)
  const rankIncoming = packageRank(incoming)
  if (rankIncoming !== rankLocal) return rankIncoming > rankLocal ? incoming : local
  return incomingWins ? incoming : local
}
