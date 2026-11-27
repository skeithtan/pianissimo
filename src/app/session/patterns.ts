/**
 * Pass-level mistake patterns: what a scored pass's wrong keys have in common (a recurring cause,
 * one hand in both-hands practice, or hunting across places). Pure and structured: returns kinds
 * and counts only, never player-facing strings.
 */
import type { Timeline } from '../../core/engine/timeline'
import type { Hand, ScoreModel } from '../../core/model/score'
import { STEPS, type Step } from '../../core/music/pitch'
import { isHunting, pressCause, type PressCause } from './causes'
import { standInFor } from './mistakes'
import type { PassRecord } from './run'

type NonNullCause = Exclude<PressCause, null>

export type MistakePattern =
  | {
      readonly kind: 'cause'
      readonly cause: NonNullCause
      readonly count: number
      readonly of: number
      /**
       * For the accidental causes (`printed-accidental`, `carried-accidental`, `key-signature`,
       * `stale-accidental`): the step and written alteration of the written note most often missed
       * (e.g. `F` and `+1` for F♯, or `F` and `0` for plain F♮ including `stale-accidental`).
       */
      readonly step?: Step
      readonly alter?: number
    }
  | { readonly kind: 'hand'; readonly hand: Hand; readonly count: number; readonly of: number }
  | { readonly kind: 'hunting'; readonly count: number; readonly of: number }

const ACCIDENTAL_CAUSES: ReadonlySet<NonNullCause> = new Set([
  'printed-accidental',
  'carried-accidental',
  'key-signature',
  'stale-accidental',
])

const MIN_PATTERN_COUNT = 3
const MAX_PATTERNS = 2

const KIND_PRIORITY: Readonly<Record<MistakePattern['kind'], number>> = {
  cause: 0,
  hunting: 1,
  hand: 2,
}

/**
 * What a pass's mistakes (a scored attempt or a Wait run) have in common, strongest first, at most two. `of` is the number of
 * wrong keys pressed alone or with the stroke in the pass (for `hunting`: places with a wrong
 * key). A pattern needs at least three instances and at least half of `of`.
 */
export function mistakePatterns(
  record: PassRecord,
  timeline: Timeline,
  model: Pick<ScoreModel, 'notes' | 'clefs'>,
): MistakePattern[] {
  if (record.kind === 'reading' || !record.groups) return []

  let totalWrong = 0
  let wrongPlaces = 0
  let huntingCount = 0
  const causeCounts = new Map<NonNullCause, number>()
  const accidentalDetails = new Map<NonNullCause, Map<string, { step: Step; alter: number; count: number }>>()
  const handCounts: Record<Hand, number> = { L: 0, R: 0 }
  const trackHands = timeline.hands === 'both'

  for (const outcome of record.groups) {
    const group = timeline.groups[outcome.group]
    if (!group) continue
    const wrong = outcome.wrongPitches
    if (!wrong || wrong.length === 0) continue

    wrongPlaces++
    if (isHunting(outcome)) huntingCount++

    for (const pitch of wrong) {
      totalWrong++
      const cause = pressCause({ pitch, group: outcome.group, timeline, model })
      let stoodFor: (typeof model.notes)[number] | undefined
      const resolveNote = () => {
        if (stoodFor !== undefined) return stoodFor
        const k = standInFor(pitch, group, model)
        stoodFor = model.notes[group.notesByPitch[k]?.[0] ?? group.notes[0] ?? -1]
        return stoodFor
      }

      if (cause !== null) {
        causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1)
        if (ACCIDENTAL_CAUSES.has(cause)) {
          const note = resolveNote()
          if (note) {
            let byPitch = accidentalDetails.get(cause)
            if (!byPitch) accidentalDetails.set(cause, (byPitch = new Map()))
            const key = `${note.written.step}:${note.written.alter}`
            const entry = byPitch.get(key)
            if (entry) entry.count++
            else byPitch.set(key, { step: note.written.step, alter: note.written.alter, count: 1 })
          }
        }
      }

      if (trackHands) {
        const note = resolveNote()
        if (note) handCounts[note.hand]++
      }
    }
  }

  const candidates: MistakePattern[] = []

  for (const [cause, count] of causeCounts) {
    if (!qualifies(count, totalWrong)) continue
    const detail = topAccidentalDetail(accidentalDetails.get(cause))
    candidates.push({
      kind: 'cause',
      cause,
      count,
      of: totalWrong,
      ...(detail ? { step: detail.step, alter: detail.alter } : {}),
    })
  }

  if (trackHands) {
    for (const hand of ['L', 'R'] as const) {
      const count = handCounts[hand]
      if (qualifies(count, totalWrong)) {
        candidates.push({ kind: 'hand', hand, count, of: totalWrong })
      }
    }
  }

  if (qualifies(huntingCount, wrongPlaces)) {
    candidates.push({ kind: 'hunting', count: huntingCount, of: wrongPlaces })
  }

  candidates.sort(
    (a, b) => b.count * a.of - a.count * b.of || b.count - a.count || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind],
  )

  return candidates.slice(0, MAX_PATTERNS)
}

function qualifies(count: number, of: number): boolean {
  return count >= MIN_PATTERN_COUNT && of > 0 && count * 2 >= of
}

function topAccidentalDetail(
  byPitch: Map<string, { step: Step; alter: number; count: number }> | undefined,
): { readonly step: Step; readonly alter: number } | null {
  if (!byPitch || byPitch.size === 0) return null
  let best: { step: Step; alter: number; count: number } | null = null
  for (const entry of byPitch.values()) {
    if (
      !best ||
      entry.count > best.count ||
      (entry.count === best.count &&
        (STEPS.indexOf(entry.step) < STEPS.indexOf(best.step) ||
          (entry.step === best.step && entry.alter < best.alter)))
    ) {
      best = entry
    }
  }
  return best ? { step: best.step, alter: best.alter } : null
}
