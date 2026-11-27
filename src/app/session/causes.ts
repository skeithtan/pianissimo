/**
 * Probable cause of one wrong key at one onset group, and whether the player was hunting for the
 * note. Pure and structured: returns kinds only, never player-facing strings.
 */
import type { Timeline } from '../../core/engine/timeline'
import type { GroupOutcome } from '../../core/model/practice'
import type { ClefEvent, ClefKey, PerformedNote, ScoreModel } from '../../core/model/score'
import { STEP_SEMITONES, diatonicIndex, type Step } from '../../core/music/pitch'
import { eq, le } from '../../core/music/rational'
import { labelFor } from '../../core/naming'
import { clefMiddleLineIndex, stepFromDiatonicIndex } from '../../core/naming/clef'
import { contextAlter, keySignatureAlter } from '../../core/naming/context'
import { LETTERS, sameLetterSpelling, standInFor } from './mistakes'

export type PressCause =
  /** The written note carries its own accidental sign (a sharp, flat or natural printed on it) and the key pressed ignores it. */
  | 'printed-accidental'
  /** No sign on the note: an accidental earlier in the same bar on the same line still applies, and the key pressed ignores it. */
  | 'carried-accidental'
  /** No sign on the note and nothing carried: the key signature alters it, and the key pressed is the unaltered note. */
  | 'key-signature'
  /** The key pressed has an alteration the note does not have here, and that alteration applied to the same step in the previous bar. */
  | 'stale-accidental'
  /** The key belongs to the next onset group (the player jumped ahead). */
  | 'jumped-ahead'
  /** The key belongs to the previous onset group (the player replayed it). */
  | 'replayed-previous'
  /** One-hand practice: the key is a note the other hand plays at this position. */
  | 'other-hand'
  /** The key is the written note read in the clef this staff had before a recent clef change. */
  | 'clef'
  /** The same note in another octave. */
  | 'octave'
  | null

export interface PressCauseInput {
  /** The wrong key (MIDI). */
  readonly pitch: number
  /** Index into `timeline.groups`. */
  readonly group: number
  readonly timeline: Timeline
  readonly model: Pick<ScoreModel, 'notes' | 'clefs'>
}

const CLEF_CHANGE_LOOKBACK_OCCS = 2

/**
 * Most likely cause of a wrong key at `group`, checked in precedence order:
 * 1. `jumped-ahead` / `replayed-previous` (adjacent onset groups).
 * 2. `other-hand` (automatic part at the same position in one-hand practice).
 * 3. Accidental family on a 1-semitone same-letter slip (`printed-accidental`,
 *    `carried-accidental`, `key-signature`, `stale-accidental`). When none of the four apply,
 *    falls through to rules 4 and 5 rather than returning null immediately.
 * 4. `clef` (written staff position read in the previous clef after a recent change).
 * 5. `octave` (12 or 24 semitones from a required pitch).
 * 6. `null`.
 */
export function pressCause(input: PressCauseInput): PressCause {
  const { pitch, group, timeline, model } = input
  const g = timeline.groups[group]
  if (!g || g.pitches.includes(pitch)) return null

  // 1. Adjacent onset groups win over everything else (in stepwise music, next/prev is a neighbor).
  const next = timeline.groups[group + 1]
  if (next && next.pitches.includes(pitch)) return 'jumped-ahead'
  const prev = timeline.groups[group - 1]
  if (prev && prev.pitches.includes(pitch)) return 'replayed-previous'

  // 2. Other hand's note at this same position (one-hand practice).
  const auto = timeline.automatic.find((a) => eq(a.position, g.position))
  if (auto && auto.notes.some((ni) => model.notes[ni]?.midi === pitch)) return 'other-hand'

  // 3. Accidental family (one semitone from a required pitch on the same letter). Falls through
  //    to clef/octave when none of the four accidental causes apply.
  const k = standInFor(pitch, g, model)
  const expectedPitch = g.pitches[k]
  const expectedNote = expectedPitch !== undefined ? model.notes[g.notesByPitch[k]?.[0] ?? -1] : undefined
  if (
    expectedNote &&
    expectedPitch !== undefined &&
    Math.abs(pitch - expectedPitch) === 1 &&
    sameLetterSpelling(pitch, labelFor(expectedNote, LETTERS)) !== null
  ) {
    const { step, octave, alter: actual } = expectedNote.written
    const implied = contextAlter(expectedNote.accidentalContext, step, octave)
    if (actual !== implied) return 'printed-accidental'
    if (expectedNote.accidentalContext.carried.some(([s, oct]) => s === step && oct === octave)) {
      return 'carried-accidental'
    }
    if (keySignatureAlter(step, expectedNote.accidentalContext.keyFifths) !== 0) return 'key-signature'
    const pressedAlter = actual + (pitch - expectedPitch)
    if (
      expectedNote.occ > 0 &&
      hasAlterationInBar(model.notes, expectedNote.occ - 1, expectedNote.staff, step, pressedAlter)
    ) {
      return 'stale-accidental'
    }
  }

  // 4. Recent clef change on a note's staff (within 2 occurrences back, not the staff's first clef).
  if (causeClef(input) !== null) return 'clef'

  // 5. Same note in another octave (1 or 2 octaves away).
  if (
    g.pitches.some((p) => {
      const d = Math.abs(pitch - p)
      return d === 12 || d === 24
    })
  ) {
    return 'octave'
  }

  return null
}

/**
 * When a wrong key matches a recent clef change (rule 4 of `pressCause`), returns the current
 * clef key on that staff; otherwise null.
 */
export function causeClef(input: PressCauseInput): ClefKey | null {
  const { pitch, group, timeline, model } = input
  const g = timeline.groups[group]
  if (!g || g.pitches.includes(pitch)) return null
  const pitchClass = mod12(pitch)
  for (const ni of g.notes) {
    const note = model.notes[ni]
    if (!note) continue
    const change = recentClefChange(model.clefs, note.staff, g.position, note.occ)
    if (!change) continue
    const curMid = clefMiddleLineIndex(change.current.key)
    const prevMid = clefMiddleLineIndex(change.previous.key)
    if (curMid === null || prevMid === null) continue
    const misreadStep = stepFromDiatonicIndex(diatonicIndex(note.written) + (prevMid - curMid)).step
    const misreadAlter = keySignatureAlter(misreadStep, note.accidentalContext.keyFifths)
    if (mod12(STEP_SEMITONES[misreadStep] + misreadAlter) === pitchClass) return change.current.key
  }
  return null
}

/** A place where the player tried several different keys alone before the right one: they did not know the note. */
export function isHunting(outcome: GroupOutcome): boolean {
  const wrong = outcome.wrongPitches
  if (!wrong || wrong.length < 2) return false
  const extra = outcome.extraPitches ? new Set(outcome.extraPitches) : null
  const distinct = new Set<number>()
  for (const p of wrong) {
    if (extra && extra.has(p)) continue
    distinct.add(p)
    if (distinct.size >= 2) return true
  }
  return false
}

function mod12(n: number): number {
  return ((n % 12) + 12) % 12
}

function hasAlterationInBar(
  notes: readonly PerformedNote[],
  occ: number,
  staff: number,
  step: Step,
  alter: number,
): boolean {
  return notes.some(
    (n) => !n.cue && n.occ === occ && n.staff === staff && n.written.step === step && n.written.alter === alter,
  )
}

function recentClefChange(
  clefs: readonly ClefEvent[],
  staff: number,
  position: Timeline['groups'][number]['position'],
  occ: number,
): { readonly previous: ClefEvent; readonly current: ClefEvent } | null {
  // Collapse consecutive identical clef keys (e.g. a restated clef after a repeat jump).
  const distinct: ClefEvent[] = []
  for (const ev of clefs) {
    if (ev.staff !== staff || !le(ev.at, position)) continue
    if (distinct.length === 0 || distinct[distinct.length - 1]!.key !== ev.key) {
      distinct.push(ev)
    }
  }
  if (distinct.length < 2) return null
  const current = distinct[distinct.length - 1]!
  const previous = distinct[distinct.length - 2]!
  if (occ - current.occ > CLEF_CHANGE_LOOKBACK_OCCS) return null
  return { previous, current }
}
