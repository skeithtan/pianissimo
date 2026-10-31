import type { ClefKey } from '../model/score'
import type { ClefLabelRule, LabelCondition } from '../model/settings'
import type { Spelling } from '../music/pitch'
import { diatonicIndex, isStep, spellingToMidi } from '../music/pitch'
import { clefMiddleLineIndex, clefShortName, stepFromDiatonicIndex } from './clef'
import { ruleLabelsMidi } from './eligibility'
import { spellMidi } from './simplify'
import { formatSpelling } from './spelling-text'

export interface RuleIssue {
  /** Which control the message belongs to. */
  readonly field: 'below' | 'above' | 'range'
  readonly message: string
}

export interface RuleValidation {
  readonly ok: boolean
  readonly issues: readonly RuleIssue[]
}

const MIDI_LOW = 0
const MIDI_HIGH = 127
const CONDITION_TITLE = { below: 'Show below', above: 'Show above' } as const

/** Why a threshold is not a usable pitch, or null when it is valid. */
export function thresholdProblem(s: Spelling): string | null {
  if (!isStep(s.step)) return 'the note name must be C, D, E, F, G, A or B'
  if (!Number.isInteger(s.alter) || Math.abs(s.alter) > 2) return 'the accidental must be ♮, ♯, ♭, 𝄪 or 𝄫'
  if (!Number.isInteger(s.octave)) return 'the octave must be a whole number'
  const midi = spellingToMidi(s)
  if (midi < MIDI_LOW || midi > MIDI_HIGH) return `${formatSpelling(s)} is outside the MIDI range (C-1 to G9)`
  return null
}

function checkCondition(
  field: 'below' | 'above',
  condition: LabelCondition,
): { midi: number | null; issue?: RuleIssue } {
  if (!condition.enabled) return { midi: null }
  const title = CONDITION_TITLE[field]
  if (condition.threshold === null) {
    return {
      midi: null,
      issue: { field, message: `${title} is on but has no pitch. Enter a pitch such as C4 or B♭3.` },
    }
  }
  const problem = thresholdProblem(condition.threshold)
  if (problem !== null) return { midi: null, issue: { field, message: `${title}: ${problem}.` } }
  return { midi: spellingToMidi(condition.threshold) }
}

/**
 * Spec "Persistent score labels": reject an enabled condition without a valid pitch and, when
 * both conditions are enabled, a lower boundary (Show below) above the upper boundary
 * (Show above), which would label every note. Equal boundaries are allowed (one pitch stays
 * unlabeled). Disabled conditions are never validated. Both off is valid: it labels nothing.
 */
export function validateRule(rule: ClefLabelRule): RuleValidation {
  const below = checkCondition('below', rule.below)
  const above = checkCondition('above', rule.above)
  const issues: RuleIssue[] = []
  if (below.issue) issues.push(below.issue)
  if (above.issue) issues.push(above.issue)
  if (
    below.midi !== null &&
    above.midi !== null &&
    below.midi > above.midi &&
    rule.below.threshold &&
    rule.above.threshold
  ) {
    const lower = formatSpelling(rule.below.threshold)
    const upper = formatSpelling(rule.above.threshold)
    issues.push({
      field: 'range',
      message:
        `Show below ${lower} is higher than Show above ${upper}, so every note would be labeled. ` +
        `Choose a "below" pitch of ${upper} or lower, or an "above" pitch of ${lower} or higher.`,
    })
  }
  return { ok: issues.length === 0, issues }
}

function activeThreshold(condition: LabelCondition): Spelling | null {
  return condition.enabled && condition.threshold !== null && thresholdProblem(condition.threshold) === null
    ? condition.threshold
    : null
}

/**
 * Plain-language summary of a clef rule for the settings screen, e.g.
 * "Treble clef: label notes below C4 or above C5. Notes from C4 through C5 stay unlabeled."
 */
export function describeRule(rule: ClefLabelRule, clefKey: ClefKey): string {
  const clef = `${clefShortName(clefKey)} clef`
  const validation = validateRule(rule)
  if (validation.issues.some((i) => i.field === 'range')) {
    return `${clef}: the two conditions overlap, so every note would be labeled.`
  }
  const below = activeThreshold(rule.below)
  const above = activeThreshold(rule.above)
  const pending = validation.issues.map((i) => CONDITION_TITLE[i.field as 'below' | 'above'])
  const needs = pending.length > 0 ? ` ${pending.join(' and ')} still needs a valid pitch.` : ''

  if (below && above) {
    return `${clef}: label notes below ${formatSpelling(below)} or above ${formatSpelling(above)}. Notes from ${formatSpelling(below)} through ${formatSpelling(above)} stay unlabeled.`
  }
  if (below) {
    return `${clef}: label notes below ${formatSpelling(below)}. Notes from ${formatSpelling(below)} upward stay unlabeled.${needs}`
  }
  if (above) {
    return `${clef}: label notes above ${formatSpelling(above)}. Notes up to ${formatSpelling(above)} stay unlabeled.${needs}`
  }
  return pending.length > 0
    ? `${clef}: no notes are labeled yet.${needs}`
    : `${clef}: no notes are labeled (both conditions are off).`
}

/** One pitch of the live sample shown beside a rule. */
export interface RuleSamplePitch {
  readonly midi: number
  readonly spelling: Spelling
  /** Letter-name text with octave, e.g. "C♯5". */
  readonly text: string
  /** Whether the rule would put a persistent label on this pitch. */
  readonly labeled: boolean
  /** True for the entered threshold pitches, so the UI can emphasize the boundaries. */
  readonly isThreshold: boolean
}

const SAMPLE_STEPS_EACH_SIDE = 9

/**
 * Live sample for "which notes will be labeled before applying": every natural pitch within
 * about two and a half octaves around the clef's staff, plus each valid enabled threshold and
 * its semitone neighbors (so strictness and black keys show, e.g. C5 unlabeled, C♯5 labeled).
 * Sorted low to high; one entry per piano key.
 */
export function sampleRule(rule: ClefLabelRule, clefKey: ClefKey): readonly RuleSamplePitch[] {
  const byMidi = new Map<number, { spelling: Spelling; isThreshold: boolean }>()
  const center = clefMiddleLineIndex(clefKey) ?? diatonicIndex({ step: 'C', octave: 4 })
  for (let index = center - SAMPLE_STEPS_EACH_SIDE; index <= center + SAMPLE_STEPS_EACH_SIDE; index++) {
    const { step, octave } = stepFromDiatonicIndex(index)
    const spelling: Spelling = { step, alter: 0, octave }
    const midi = spellingToMidi(spelling)
    if (midi >= MIDI_LOW && midi <= MIDI_HIGH) byMidi.set(midi, { spelling, isThreshold: false })
  }
  for (const threshold of [activeThreshold(rule.below), activeThreshold(rule.above)]) {
    if (!threshold) continue
    const midi = spellingToMidi(threshold)
    const prefer = threshold.alter < 0 ? 'flat' : 'sharp'
    for (const neighbor of [midi - 1, midi + 1]) {
      if (neighbor >= MIDI_LOW && neighbor <= MIDI_HIGH && !byMidi.has(neighbor)) {
        byMidi.set(neighbor, { spelling: spellMidi(neighbor, prefer), isThreshold: false })
      }
    }
    byMidi.set(midi, { spelling: threshold, isThreshold: true })
  }
  return [...byMidi.entries()]
    .sort(([a], [b]) => a - b)
    .map(([midi, { spelling, isThreshold }]) => ({
      midi,
      spelling,
      text: formatSpelling(spelling),
      labeled: ruleLabelsMidi(rule, midi),
      isThreshold,
    }))
}
