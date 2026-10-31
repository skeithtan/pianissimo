import { measureContextKey, USER_ABANDON_REASONS } from '../model/practice'
import type { AbandonEvent, AttemptRecord } from '../model/practice'
import { adjacentRuns, chunkRun } from './clusters'
import { parseMeasureContextKey, toMeasureContext } from './contextKey'
import { barEvidence, meetsFlagRule } from './detection'
import { applyTraversal } from './traversal'
import { ABANDON_RETAINED, ABANDON_TRIGGER, MAX_IMPROVED_KEPT, RECOVERY_STREAK, barKey } from './types'
import type {
  BarRecord,
  HistoryChanges,
  IngestResult,
  MeasureContext,
  PieceHistory,
  SuggestionKind,
  SuggestionRecord,
} from './types'

const NO_CHANGES: HistoryChanges = { bars: [], suggestionsChanged: false, abandonKeys: [] }

/**
 * Fold one attempt (scored or ordinary reading) into a piece's history: update each
 * traversed bar's rolling record, resolve suggestions whose flagged bars have recovered,
 * and flag bars that now meet the rule. Pure: the caller persists `changes`.
 *
 * Re-ingesting an attempt that was already applied is a no-op for the bars it touched. An
 * attempt in Preview (hands `none`) is ignored: Preview records no practice result.
 */
export function ingestAttempt(history: PieceHistory, attempt: AttemptRecord, now: number): IngestResult {
  if (attempt.pieceId !== history.pieceId) {
    throw new RangeError(`Attempt ${attempt.id} belongs to ${attempt.pieceId}, not ${history.pieceId}`)
  }
  const context = toMeasureContext(attempt.context)
  // Preview (neither hand) has no learner input, errors or saved result (spec "Listening and hand practice").
  if (context.hands === 'none') return { history, changes: NO_CHANGES }
  const mkey = measureContextKey(context)

  const changedBars = new Map<string, BarRecord>()
  const touched: number[] = []
  for (const traversal of attempt.measures) {
    const key = barKey(mkey, traversal.occ)
    const current = changedBars.get(key) ?? history.bars[key]
    if (alreadyApplied(current, attempt.id)) continue
    const next = applyTraversal(current, traversal, {
      pieceId: history.pieceId,
      measureContextKey: mkey,
      attemptId: attempt.id,
      at: attempt.createdAt,
    })
    if (!next) continue
    changedBars.set(key, next)
    touched.push(traversal.occ)
  }
  if (changedBars.size === 0) return { history, changes: NO_CHANGES }

  const withBars: PieceHistory = {
    ...history,
    bars: { ...history.bars, ...Object.fromEntries(changedBars) },
  }
  const reconciled = reconcileTraversals(withBars, mkey, context, touched, now)
  return {
    history: reconciled.history,
    changes: {
      bars: [...changedBars.values()],
      suggestionsChanged: reconciled.suggestionsChanged,
      abandonKeys: reconciled.abandonKeys,
    },
  }
}

/** An attempt folds into a bar once: it is the last applied one or still sits in the rolling window. */
function alreadyApplied(bar: BarRecord | undefined, attemptId: string): boolean {
  return bar !== undefined && (bar.lastAttemptId === attemptId || bar.recent.some((s) => s.attemptId === attemptId))
}

/**
 * Record a user-initiated restart or stop after wrong notes in a bar. Reasons other than
 * `user-stop`/`user-restart` (disconnect, suspend, seeks, setting changes, pauses) are
 * ignored: they are not abandonment. Three such events in one bar create a separately
 * labeled "restart" suggestion that never feeds the complete-pass percentages.
 */
export function ingestAbandon(history: PieceHistory, event: AbandonEvent, now: number): IngestResult {
  if (event.pieceId !== history.pieceId) {
    throw new RangeError(`Abandon event belongs to ${event.pieceId}, not ${history.pieceId}`)
  }
  if (!USER_ABANDON_REASONS.includes(event.reason)) return { history, changes: NO_CHANGES }

  const key = barKey(event.measureContextKey, event.occ)
  const existing = history.abandons[key] ?? []
  if (existing.some((e) => e.at === event.at && e.reason === event.reason)) {
    return { history, changes: NO_CHANGES }
  }
  const events = [...existing, event].slice(-ABANDON_RETAINED)
  const withEvent: PieceHistory = { ...history, abandons: { ...history.abandons, [key]: events } }

  const context = parseMeasureContextKey(event.measureContextKey)
  const covered = history.suggestions.some(
    (s) =>
      s.status === 'active' &&
      s.measureContextKey === event.measureContextKey &&
      event.occ >= s.coreFrom &&
      event.occ <= s.coreTo,
  )
  if (!context || events.length < ABANDON_TRIGGER || covered) {
    return { history: withEvent, changes: { bars: [], suggestionsChanged: false, abandonKeys: [key] } }
  }
  const suggestions = regroup(history.suggestions, 'restart', event.measureContextKey, context, [event.occ], now)
  return {
    history: { ...withEvent, suggestions },
    changes: { bars: [], suggestionsChanged: true, abandonKeys: [key] },
  }
}

interface Reconciled {
  readonly history: PieceHistory
  readonly suggestionsChanged: boolean
  readonly abandonKeys: readonly string[]
}

function reconcileTraversals(
  history: PieceHistory,
  mkey: string,
  context: MeasureContext,
  touched: readonly number[],
  now: number,
): Reconciled {
  let suggestions = history.suggestions
  let abandons = history.abandons
  const abandonKeys: string[] = []
  let changed = false

  // 1. Recovery: every flagged bar needs RECOVERY_STREAK consecutive clean passes. Falling
  //    below the detection threshold alone never resolves a suggestion.
  const resolved: SuggestionRecord[] = []
  suggestions = suggestions.map((s) => {
    if (s.status !== 'active' || s.measureContextKey !== mkey || !hasRecovered(history, s)) return s
    const improved: SuggestionRecord = { ...s, status: 'improved', improvedAt: now, updatedAt: now }
    resolved.push(improved)
    return improved
  })
  if (resolved.length > 0) {
    changed = true
    const cleared: Record<string, readonly AbandonEvent[]> = {}
    for (const s of resolved) {
      for (let occ = s.coreFrom; occ <= s.coreTo; occ += 1) {
        const key = barKey(mkey, occ)
        if ((history.abandons[key]?.length ?? 0) > 0) {
          cleared[key] = []
          abandonKeys.push(key)
        }
      }
    }
    abandons = { ...abandons, ...cleared }
    suggestions = trimImproved(suggestions)
  }

  // 2. Flagging: bars touched by this attempt that now meet the rule and are not already
  //    part of an active suggestion. A bar whose suggestion improved can flag again.
  const covered = new Set<number>()
  for (const s of suggestions) {
    if (s.status !== 'active' || s.kind !== 'traversal' || s.measureContextKey !== mkey) continue
    for (let occ = s.coreFrom; occ <= s.coreTo; occ += 1) covered.add(occ)
  }
  const newlyFlagged = touched.filter(
    (occ) => !covered.has(occ) && meetsFlagRule(barEvidence(history.bars[barKey(mkey, occ)])),
  )
  if (newlyFlagged.length > 0) {
    suggestions = regroup(suggestions, 'traversal', mkey, context, newlyFlagged, now)
    changed = true
  }

  return {
    history: { ...history, suggestions, abandons },
    suggestionsChanged: changed,
    abandonKeys,
  }
}

function hasRecovered(history: PieceHistory, s: SuggestionRecord): boolean {
  for (let occ = s.coreFrom; occ <= s.coreTo; occ += 1) {
    const bar = history.bars[barKey(s.measureContextKey, occ)]
    if ((bar?.cleanStreak ?? 0) < RECOVERY_STREAK) return false
  }
  return true
}

function trimImproved(list: readonly SuggestionRecord[]): SuggestionRecord[] {
  const improved = list.filter((s) => s.status === 'improved').sort((a, b) => (b.improvedAt ?? 0) - (a.improvedAt ?? 0))
  const drop = new Set(improved.slice(MAX_IMPROVED_KEPT).map((s) => s.id))
  return list.filter((s) => !drop.has(s.id))
}

/**
 * Merge newly flagged bars into the active suggestions of one kind and context: adjacent
 * bars become one run, long runs are split into passages, and suggestions whose range did
 * not change keep their identity (and with it any session dismissal).
 */
function regroup(
  list: readonly SuggestionRecord[],
  kind: SuggestionKind,
  mkey: string,
  context: MeasureContext,
  newOccs: readonly number[],
  now: number,
): SuggestionRecord[] {
  const active = list.filter((s) => s.status === 'active' && s.kind === kind && s.measureContextKey === mkey)
  const occs = new Set<number>(newOccs)
  for (const s of active) {
    for (let occ = s.coreFrom; occ <= s.coreTo; occ += 1) occs.add(occ)
  }
  const fresh = new Set(newOccs)
  const runs = adjacentRuns(occs).filter((run) => run.some((o) => fresh.has(o)))

  const removed = active.filter((s) => runs.some((run) => run.includes(s.coreFrom)))
  const kept = list.filter((s) => !removed.includes(s))
  const created: SuggestionRecord[] = []
  for (const run of runs) {
    for (const chunk of chunkRun(run)) {
      const same = removed.find((s) => s.coreFrom === chunk.fromOcc && s.coreTo === chunk.toOcc)
      if (same) {
        created.push({ ...same, updatedAt: now })
        continue
      }
      const overlapping = removed.filter((s) => s.coreFrom <= chunk.toOcc && s.coreTo >= chunk.fromOcc)
      const createdAt = overlapping.length > 0 ? Math.min(...overlapping.map((s) => s.createdAt)) : now
      created.push({
        id: `${kind}|${mkey}|${chunk.fromOcc}-${chunk.toOcc}|${createdAt}`,
        kind,
        status: 'active',
        measureContextKey: mkey,
        context,
        coreFrom: chunk.fromOcc,
        coreTo: chunk.toOcc,
        createdAt,
        updatedAt: now,
      })
    }
  }
  return [...kept, ...created]
}
