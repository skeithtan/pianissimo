import type { ClefKey } from '../model/score'
import type { ClefLabelRule, LabelCondition, PersistentLabelSettings } from '../model/settings'
import { DISABLED_RULE } from '../model/settings'
import { spellingToMidi } from '../music/pitch'

/** The part of a performed note that label eligibility reads: sounding MIDI and governing clef. */
export interface EligibilityNote {
  /** Resolved sounding pitch (ottava applied). Enharmonic spellings share this number. */
  readonly midi: number
  /** Clef governing the note's displayed staff at its position. */
  readonly clef: ClefKey
}

function thresholdMidi(condition: LabelCondition): number | null {
  if (!condition.enabled || condition.threshold === null) return null
  const midi = spellingToMidi(condition.threshold)
  return Number.isFinite(midi) ? midi : null
}

/**
 * Spec "Persistent score labels" (Conditional): strict comparisons on resolved sounding MIDI.
 * Show-below X labels `midi < midi(X)`; show-above Y labels `midi > midi(Y)`; enabled
 * conditions combine with OR. A condition that is disabled or has no threshold labels nothing,
 * so a rule with both off labels no note.
 */
export function ruleLabelsMidi(rule: ClefLabelRule, midi: number): boolean {
  const below = thresholdMidi(rule.below)
  const above = thresholdMidi(rule.above)
  return (below !== null && midi < below) || (above !== null && midi > above)
}

/**
 * Rule for a clef. A clef that has no entry yet gets a both-disabled rule: thresholds are never
 * copied from another clef implicitly (spec: bass is not initialized from treble).
 */
export function ruleForClef(labels: PersistentLabelSettings, clefKey: ClefKey): ClefLabelRule {
  return labels.rules[clefKey] ?? DISABLED_RULE
}

/**
 * Whether a persistent label is shown for this note under the label settings.
 *
 * `off` never; `all` for every pitched note (rests have no `PerformedNote`); `conditional`
 * applies the rule of the note's own clef. Only the sounding MIDI number and clef are read, so
 * naming language, spelling and simplification, hand assignment and the printed accidental
 * can never change which notes qualify.
 */
export function isPersistentLabelVisible(note: EligibilityNote, labels: PersistentLabelSettings): boolean {
  switch (labels.mode) {
    case 'off':
      return false
    case 'all':
      return true
    case 'conditional':
      return ruleLabelsMidi(ruleForClef(labels, note.clef), note.midi)
  }
}
