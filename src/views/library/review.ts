/**
 * The import summary's user input (spec "MusicXML score import": ambiguous hand assignments
 * require confirmation; missing numerical tempo requires a practice tempo; DECISIONS M2, I6, E5)
 * and the gate in front of "Add to library". Pure: the view holds a `ReviewDraft` and calls
 * `reviewGate` on every change and `finalizeImport` on save.
 *
 * A piece enters the library only once it is ready for scored practice (DECISIONS L1): hands
 * confirmed, a numerical tempo (from the score or entered here), and no import errors.
 */
import { applyHandAssignment } from '../../core/import/hands'
import { withUserTempo } from '../../core/import/rolls'
import { summarizeImport, type ImportSummary, type SummaryVoice } from '../../core/import/summary'
import type { Hand, ScoreModel, VoiceKey } from '../../core/model/score'
import { rat, type Rational } from '../../core/music/rational'
import type { UserTempo } from '../../core/storage/records'

/** Beat units offered for a practice tempo, in whole notes. */
export const BEAT_UNIT_CHOICES = [
  { value: '1/4', label: 'Quarter', unit: rat(1, 4) },
  { value: '3/8', label: 'Dotted quarter', unit: rat(3, 8) },
  { value: '1/2', label: 'Half', unit: rat(1, 2) },
  { value: '1/8', label: 'Eighth', unit: rat(1, 8) },
  { value: '3/4', label: 'Dotted half', unit: rat(3, 4) },
] as const

export type BeatUnitChoice = (typeof BEAT_UNIT_CHOICES)[number]['value']

export const MIN_PRACTICE_BPM = 20
export const MAX_PRACTICE_BPM = 300

export interface ReviewDraft {
  /** Hand per voice, starting from the importer's proposal (home staff, DECISIONS M2). */
  readonly hands: Readonly<Record<VoiceKey, Hand>>
  /** True from the start unless a voice is genuinely split between the staves; then once the user confirmed (I6). */
  readonly handsConfirmed: boolean
  /** Typed BPM text; used only when the score has no numerical tempo. */
  readonly bpmText: string
  readonly beatUnit: BeatUnitChoice
}

export interface ReviewGate {
  readonly canSave: boolean
  /** What is still needed, in plain words (empty when `canSave`). */
  readonly blockers: readonly string[]
  /** Tempo entry problem to show beside the field (null when fine or not needed yet). */
  readonly tempoError: string | null
}

export function unitFor(choice: BeatUnitChoice): Rational {
  return BEAT_UNIT_CHOICES.find((c) => c.value === choice)!.unit
}

/** A sensible beat unit for a practice tempo from the opening meter (6/8 → dotted quarter). */
export function defaultBeatUnit(model: ScoreModel): BeatUnitChoice {
  const meter = model.meters[0]
  if (!meter) return '1/4'
  if (meter.beatType === 8 && meter.beats % 3 === 0 && meter.beats > 3) return '3/8'
  if (meter.beatType === 4 && meter.beats % 3 === 0 && meter.beats > 3) return '3/4'
  if (meter.beatType === 2) return '1/2'
  return '1/4'
}

export function initialDraft(summary: ImportSummary, model: ScoreModel): ReviewDraft {
  const hands: Record<VoiceKey, Hand> = {}
  for (const v of summary.voices) hands[v.key] = v.hand
  return { hands, handsConfirmed: summary.handsConfirmed, bpmText: '', beatUnit: defaultBeatUnit(model) }
}

/** Parse the typed practice tempo; a number or a readable problem. */
export function parsePracticeBpm(text: string): number | string {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return 'Enter a practice tempo.'
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return 'Enter the tempo as a number of beats per minute, such as 80.'
  if (value < MIN_PRACTICE_BPM || value > MAX_PRACTICE_BPM) {
    return `Enter a tempo between ${MIN_PRACTICE_BPM} and ${MAX_PRACTICE_BPM} beats per minute.`
  }
  return value
}

/**
 * What still blocks saving. `tempoEntry` says whether the practice tempo is typed here: at import
 * when the score has no numerical tempo, and when reviewing a stored piece whose tempo the user
 * entered (`PieceRecord.userTempo`).
 */
export function reviewGate(
  summary: ImportSummary,
  draft: ReviewDraft,
  touchedTempo = false,
  tempoEntry = !summary.tempo.present,
): ReviewGate {
  const blockers: string[] = []
  let tempoError: string | null = null
  if (summary.diagnostics.errors > 0) {
    blockers.push(
      `The import found ${summary.diagnostics.errors === 1 ? 'an error' : `${summary.diagnostics.errors} errors`} (listed below), so notes may be missing. Fix the file and import it again.`,
    )
  }
  if (tempoEntry) {
    const parsed = parsePracticeBpm(draft.bpmText)
    if (typeof parsed === 'string') {
      blockers.push('Enter a practice tempo: the score has no numerical tempo.')
      if (touchedTempo || draft.bpmText.trim() !== '') tempoError = parsed
    }
  }
  if (!draft.handsConfirmed) {
    const names = summary.voices.filter((v) => v.ambiguous).map((v) => `voice ${v.voice} of ${v.partName}`)
    blockers.push(
      `Choose which hand plays ${names.join(', ')}: its notes are split between the staves, so the file does not say.`,
    )
  }
  return { canSave: blockers.length === 0, blockers, tempoError }
}

export interface FinalizedImport {
  readonly model: ScoreModel
  readonly userTempo?: UserTempo
  readonly summary: ImportSummary
}

/**
 * Apply the confirmed hands and the practice tempo, then re-check readiness. Throws when the
 * draft does not pass `reviewGate` (the view never calls it then).
 */
export function finalizeImport(model: ScoreModel, summary: ImportSummary, draft: ReviewDraft): FinalizedImport {
  const gate = reviewGate(summary, draft, true)
  if (!gate.canSave) throw new Error(gate.blockers.join(' '))
  let next = model
  const changed = summary.voices.some((v) => draft.hands[v.key] !== undefined && draft.hands[v.key] !== v.hand)
  if (changed || summary.voices.some((v) => v.ambiguous)) {
    const byVoice: Record<VoiceKey, Hand> = {}
    for (const v of summary.voices) byVoice[v.key] = draft.hands[v.key] ?? v.hand
    next = applyHandAssignment(next, byVoice)
  }
  let userTempo: UserTempo | undefined
  if (!summary.tempo.present) {
    const beatBpm = parsePracticeBpm(draft.bpmText) as number
    const beatUnit = unitFor(draft.beatUnit)
    next = withUserTempo(next, beatBpm, beatUnit)
    userTempo = { beatBpm, beatUnit }
  }
  const after = summarizeImport(next)
  if (!after.readiness.scoredPractice) throw new Error(after.readiness.blockers.join(' '))
  return { model: next, summary: after, ...(userTempo ? { userTempo } : {}) }
}

// ---------------------------------------------------------------- review of a stored piece

/**
 * The draft for reviewing a stored piece: its current hands (already confirmed, L1) and, when
 * the user entered the tempo at import, that tempo prefilled for editing.
 */
export function storedDraft(summary: ImportSummary, model: ScoreModel, userTempo: UserTempo | undefined): ReviewDraft {
  const draft = { ...initialDraft(summary, model), handsConfirmed: true }
  if (!userTempo) return draft
  const unit = BEAT_UNIT_CHOICES.find((c) => c.unit.n * userTempo.beatUnit.d === userTempo.beatUnit.n * c.unit.d)
  return { ...draft, bpmText: formatTempoText(userTempo.beatBpm), beatUnit: unit?.value ?? draft.beatUnit }
}

function formatTempoText(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : String(Math.round(bpm * 100) / 100)
}

export interface StoredReviewChanges {
  readonly hands: boolean
  readonly tempo: boolean
}

/** What the draft changes on a stored piece (nothing to save when both are false). */
export function storedReviewChanges(
  summary: ImportSummary,
  draft: ReviewDraft,
  userTempo: UserTempo | undefined,
): StoredReviewChanges {
  const hands = summary.voices.some((v) => (draft.hands[v.key] ?? v.hand) !== v.hand)
  let tempo = false
  if (userTempo) {
    const bpm = parsePracticeBpm(draft.bpmText)
    const unit = unitFor(draft.beatUnit)
    tempo =
      typeof bpm === 'number' &&
      (bpm !== userTempo.beatBpm || unit.n * userTempo.beatUnit.d !== userTempo.beatUnit.n * unit.d)
  }
  return { hands, tempo }
}

export interface FinalizedReview extends FinalizedImport {
  readonly changes: StoredReviewChanges
}

/**
 * Apply a reviewed hand assignment and/or practice tempo to a stored piece's model, in the same
 * order as at import (hands, then the user tempo, which re-realizes rolls), and re-check that it
 * is still ready for scored practice. The score version stays: a new assignment has a new
 * `handsId` and a new tempo a new `tempoMapId`, so either starts a separate comparison context
 * (Q3) without touching earlier results. Throws when the draft is blocked or changes nothing.
 */
export function finalizeStoredReview(
  model: ScoreModel,
  summary: ImportSummary,
  draft: ReviewDraft,
  userTempo: UserTempo | undefined,
): FinalizedReview {
  const gate = reviewGate(summary, draft, true, userTempo !== undefined)
  if (!gate.canSave) throw new Error(gate.blockers.join(' '))
  const changes = storedReviewChanges(summary, draft, userTempo)
  if (!changes.hands && !changes.tempo) throw new Error('Nothing has changed.')
  let next = model
  if (changes.hands) {
    const byVoice: Record<VoiceKey, Hand> = {}
    for (const v of summary.voices) byVoice[v.key] = draft.hands[v.key] ?? v.hand
    next = applyHandAssignment(next, byVoice)
  }
  let nextTempo: UserTempo | undefined
  if (userTempo) {
    nextTempo = changes.tempo
      ? { beatBpm: parsePracticeBpm(draft.bpmText) as number, beatUnit: unitFor(draft.beatUnit) }
      : userTempo
    next = withUserTempo(next, nextTempo.beatBpm, nextTempo.beatUnit)
  }
  const after = summarizeImport(next)
  if (!after.readiness.scoredPractice) throw new Error(after.readiness.blockers.join(' '))
  return { model: next, summary: after, changes, ...(nextTempo ? { userTempo: nextTempo } : {}) }
}

/** "Upper staff 120 · lower staff 3" for a voice's notes per staff (global staff indices). */
export function describeStaffUse(notesPerStaff: Readonly<Record<number, number>>, staffCount: number): string {
  const entries = Object.entries(notesPerStaff)
    .map(([staff, count]) => [Number(staff), count] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0] - b[0])
  return entries.map(([staff, count]) => `${count} on ${staffName(staff, staffCount)}`).join(', ')
}

export function staffName(staff: number, staffCount: number): string {
  return staffCount === 2 ? (staff === 0 ? 'the upper staff' : 'the lower staff') : `staff ${staff + 1}`
}

/** "6 notes written on the upper staff in bar 22" for a cross-staff voice; '' for a single-staff voice. */
export function describeCrossStaff(v: SummaryVoice, staffCount: number): string {
  if (v.crossStaffBars.length === 0) return ''
  const away = Object.entries(v.notesPerStaff)
    .filter(([staff]) => Number(staff) !== v.homeStaff)
    .reduce((sum, [, count]) => sum + count, 0)
  const staves = Object.keys(v.notesPerStaff)
    .map(Number)
    .filter((staff) => staff !== v.homeStaff && (v.notesPerStaff[staff] ?? 0) > 0)
  const where = staves.length === 1 ? staffName(staves[0]!, staffCount) : 'other staves'
  const bars = v.crossStaffBars
  const barText = `${bars.length === 1 ? 'bar' : 'bars'} ${bars.slice(0, 6).join(', ')}${bars.length > 6 ? ', …' : ''}`
  return `${away} ${away === 1 ? 'note' : 'notes'} written on ${where} in ${barText}`
}

export interface HandLine {
  readonly hand: Hand
  /** "Voice 1 and voice 2", "voices 1, 2 and 5 of Piano" … (empty: 'No voices'). */
  readonly voices: string
  readonly notes: number
}

/** One line per hand from the draft: which voices and how many notes it plays. */
export function handLines(voices: readonly SummaryVoice[], hands: Readonly<Record<VoiceKey, Hand>>): HandLine[] {
  const multiPart = new Set(voices.map((v) => v.partId)).size > 1
  return (['R', 'L'] as const).map((hand) => {
    const own = voices.filter((v) => (hands[v.key] ?? v.hand) === hand)
    const names = own.map((v) => (multiPart ? `voice ${v.voice} of ${v.partName}` : `voice ${v.voice}`))
    const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    const notes = own.reduce((sum, v) => sum + Object.values(v.notesPerStaff).reduce((a, b) => a + b, 0), 0)
    return { hand, voices: list, notes }
  })
}
