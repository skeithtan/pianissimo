import type { AbandonEvent, PassageRange } from '../model/practice'
import type { HandSelection, MeasureOccurrence } from '../model/score'
import { createBarLabeler } from './barLabels'
import type { BarLabeler } from './barLabels'
import { withContextBars } from './clusters'
import { barEvidence, compareEvidence } from './detection'
import { MAX_SUGGESTIONS, RECOVERY_STREAK, barKey } from './types'
import type { BarEvidence } from './detection'
import type { MeasureContext, PieceHistory, SuggestionKind, SuggestionRecord, SuggestionStatus } from './types'

export interface SuggestionBar {
  readonly occ: number
  /** Printed measure number. */
  readonly number: string
  /** 1-based repeat pass. */
  readonly pass: number
  /** "12" or "12 (pass 2)". */
  readonly label: string
  /** Context bars are practiced for lead-in and lead-out but need not be mastered. */
  readonly role: 'difficult' | 'context'
}

export interface SuggestionProgress {
  /** Fewest consecutive clean passes among the flagged bars, capped at `target`. */
  readonly clean: number
  readonly target: number
  /** "2 of 3 clean passes". */
  readonly text: string
}

/** A suggestion ready to show. "Practice this passage" opens `passage` at `hands` and `multiplier`. */
export interface Suggestion {
  readonly id: string
  readonly kind: SuggestionKind
  readonly status: SuggestionStatus
  readonly measureContextKey: string
  readonly context: MeasureContext
  readonly hands: HandSelection
  readonly multiplier: number
  /** "Both hands at 0.75×". */
  readonly contextLabel: string
  /** Bars to practice: the difficult bars plus one context bar each side where available. */
  readonly passage: PassageRange
  /** Only the difficult bars. */
  readonly core: PassageRange
  readonly bars: readonly SuggestionBar[]
  /** Specific, non-absolute evidence, e.g. "Mistakes in bar 13 on 3 of your last 5 comparable passes." */
  readonly evidence: string
  /** "Practice bars 12–14?" (empty for improved suggestions). */
  readonly prompt: string
  /** `evidence` and `prompt` as one sentence pair. */
  readonly summary: string
  readonly progress: SuggestionProgress
}

export interface SuggestionSelection {
  /** Up to three active suggestions: traversal-backed first, then repeated-restart ones. */
  readonly active: readonly Suggestion[]
  /** Resolved suggestions, newest first. */
  readonly improved: readonly Suggestion[]
  /** Suggestions disabled by the player (globally or for this piece). */
  readonly disabled: boolean
}

export interface SelectOptions {
  /** Only suggestions for this score version are shown; other versions' histories stay inert. */
  readonly scoreVersionId: string
  /** Global switch from settings (`suggestions.enabled`). */
  readonly enabled: boolean
  /** Session dismissals (in memory only). */
  readonly dismissed?: { has(id: string): boolean }
  readonly max?: number
}

const HAND_LABEL: Readonly<Record<HandSelection, string>> = {
  both: 'Both hands',
  right: 'Right hand',
  left: 'Left hand',
  none: 'Preview',
}

/** "Both hands at 0.75×" for a context. */
export function describeContext(context: MeasureContext): string {
  const speed = Number(context.multiplier.toFixed(2))
  return `${HAND_LABEL[context.hands]} at ${speed}×`
}

/**
 * Build the suggestions to show (spec "Choosing and starting the passage"): disabled and
 * session-dismissed suggestions removed, traversal-backed ones ranked by the recent
 * proportion of passes with mistakes, then evidence count, then recency (never lifetime
 * totals); repeated-restart suggestions follow them; at most three are returned.
 */
export function selectSuggestions(
  history: PieceHistory,
  occurrences: readonly MeasureOccurrence[],
  options: SelectOptions,
): SuggestionSelection {
  if (!options.enabled || history.disabled) return { active: [], improved: [], disabled: true }
  const labeler = createBarLabeler(occurrences)
  const forVersion = history.suggestions.filter((s) => s.context.scoreVersionId === options.scoreVersionId)

  const activeTraversal = forVersion.filter((s) => s.status === 'active' && s.kind === 'traversal')
  const activeRestart = forVersion.filter(
    (s) => s.status === 'active' && s.kind === 'restart' && !isCoveredBy(s, activeTraversal),
  )

  const traversalRanked = activeTraversal
    .map((s) => ({ s, worst: worstEvidence(history, s) }))
    .sort((a, b) => compareEvidence(a.worst, b.worst) || b.s.updatedAt - a.s.updatedAt)
    .map((x) => x.s)
  const restartRanked = activeRestart
    .map((s) => ({ s, ...restartEvidence(history, s) }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || b.s.updatedAt - a.s.updatedAt)
    .map((x) => x.s)

  const max = options.max ?? MAX_SUGGESTIONS
  const dismissed = options.dismissed
  const active = [...traversalRanked, ...restartRanked]
    .filter((s) => !dismissed?.has(s.id))
    .slice(0, max)
    .map((s) => toSuggestion(history, s, occurrences.length, labeler))

  const improved = forVersion
    .filter((s) => s.status === 'improved')
    .sort((a, b) => (b.improvedAt ?? 0) - (a.improvedAt ?? 0))
    .map((s) => toSuggestion(history, s, occurrences.length, labeler))

  return { active, improved, disabled: false }
}

function isCoveredBy(s: SuggestionRecord, others: readonly SuggestionRecord[]): boolean {
  for (let occ = s.coreFrom; occ <= s.coreTo; occ += 1) {
    const covered = others.some(
      (o) => o.measureContextKey === s.measureContextKey && occ >= o.coreFrom && occ <= o.coreTo,
    )
    if (!covered) return false
  }
  return true
}

function coreOccs(s: SuggestionRecord): number[] {
  const occs: number[] = []
  for (let occ = s.coreFrom; occ <= s.coreTo; occ += 1) occs.push(occ)
  return occs
}

function worstEvidence(history: PieceHistory, s: SuggestionRecord): BarEvidence {
  let worst: BarEvidence = { complete: 0, errors: 0, lastErrorAt: 0 }
  for (const occ of coreOccs(s)) {
    const e = barEvidence(history.bars[barKey(s.measureContextKey, occ)])
    if (compareEvidence(e, worst) < 0) worst = e
  }
  return worst
}

function barAbandons(history: PieceHistory, s: SuggestionRecord, occ: number): readonly AbandonEvent[] {
  return history.abandons[barKey(s.measureContextKey, occ)] ?? []
}

function restartEvidence(history: PieceHistory, s: SuggestionRecord): { count: number; lastAt: number } {
  let count = 0
  let lastAt = 0
  for (const occ of coreOccs(s)) {
    const events = barAbandons(history, s, occ)
    count = Math.max(count, events.length)
    for (const e of events) lastAt = Math.max(lastAt, e.at)
  }
  return { count, lastAt }
}

function toSuggestion(
  history: PieceHistory,
  s: SuggestionRecord,
  occurrenceCount: number,
  labeler: BarLabeler,
): Suggestion {
  const core: PassageRange = { fromOcc: s.coreFrom, toOcc: s.coreTo }
  const passage = withContextBars(core, occurrenceCount)
  const bars: SuggestionBar[] = []
  for (let occ = passage.fromOcc; occ <= passage.toOcc; occ += 1) {
    bars.push({
      occ,
      number: labeler.number(occ),
      pass: labeler.pass(occ),
      label: labeler.label(occ),
      role: occ >= s.coreFrom && occ <= s.coreTo ? 'difficult' : 'context',
    })
  }

  const streaks = coreOccs(s).map((occ) => history.bars[barKey(s.measureContextKey, occ)]?.cleanStreak ?? 0)
  const clean = s.status === 'improved' ? RECOVERY_STREAK : Math.min(RECOVERY_STREAK, ...streaks)
  const progress: SuggestionProgress = {
    clean,
    target: RECOVERY_STREAK,
    text: `${clean} of ${RECOVERY_STREAK} clean passes`,
  }

  const evidence =
    s.status === 'improved'
      ? improvedText(core, labeler)
      : s.kind === 'traversal'
        ? traversalText(history, s, labeler)
        : restartText(history, s, labeler)
  const prompt = s.status === 'improved' ? '' : `Practice ${labeler.range(passage.fromOcc, passage.toOcc)}?`

  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    measureContextKey: s.measureContextKey,
    context: s.context,
    hands: s.context.hands,
    multiplier: s.context.multiplier,
    contextLabel: describeContext(s.context),
    passage,
    core,
    bars,
    evidence,
    prompt,
    summary: prompt === '' ? evidence : `${evidence} ${prompt}`,
    progress,
  }
}

function improvedText(core: PassageRange, labeler: BarLabeler): string {
  const where = labeler.range(core.fromOcc, core.toOcc)
  return `Improved: ${RECOVERY_STREAK} clean passes in a row on ${where}.`
}

/** "Mistakes in bar 13 on 3 of your last 5 comparable passes." */
function traversalText(history: PieceHistory, s: SuggestionRecord, labeler: BarLabeler): string {
  const rows = coreOccs(s).map((occ) => ({
    occ,
    ...barEvidence(history.bars[barKey(s.measureContextKey, occ)]),
  }))
  const withErrors = rows.filter((r) => r.errors > 0)
  const first = withErrors[0]
  if (first === undefined) {
    return `${capitalize(labeler.range(s.coreFrom, s.coreTo))} was flagged earlier; recent passes have been clean so far.`
  }
  const uniform = withErrors.every((r) => r.errors === first.errors && r.complete === first.complete)
  if (uniform && withErrors.length === rows.length) {
    const where = labeler.range(s.coreFrom, s.coreTo)
    return `Mistakes in ${where} on ${first.errors} of your last ${first.complete} comparable passes.`
  }
  const rest = withErrors.slice(1).map((r) => `bar ${labeler.label(r.occ)} on ${r.errors} of ${r.complete}`)
  const lead = `Mistakes in bar ${labeler.label(first.occ)} on ${first.errors} of your last ${first.complete} comparable passes`
  return rest.length === 0 ? `${lead}.` : `${lead}; ${rest.join('; ')}.`
}

/** "You restarted at bar 13 after mistakes three times." */
function restartText(history: PieceHistory, s: SuggestionRecord, labeler: BarLabeler): string {
  const rows = coreOccs(s)
    .map((occ) => ({ occ, events: barAbandons(history, s, occ) }))
    .filter((r) => r.events.length > 0)
  if (rows.length === 0) return `You restarted at ${labeler.range(s.coreFrom, s.coreTo)} after mistakes.`
  const verb = rows.every((r) => r.events.every((e) => e.reason === 'user-stop'))
    ? 'stopped'
    : rows.every((r) => r.events.every((e) => e.reason === 'user-restart'))
      ? 'restarted'
      : 'restarted or stopped'
  if (rows.length === 1 && rows[0] !== undefined) {
    return `You ${verb} at bar ${labeler.label(rows[0].occ)} after mistakes ${times(rows[0].events.length)}.`
  }
  const parts = rows.map((r) => `bar ${labeler.label(r.occ)} ${times(r.events.length)}`)
  return `You ${verb} after mistakes at ${parts.join(', ')}.`
}

const COUNT_WORDS: Readonly<Record<number, string>> = { 3: 'three', 4: 'four', 5: 'five' }

function times(n: number): string {
  return `${COUNT_WORDS[n] ?? n} times`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
