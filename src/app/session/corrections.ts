/**
 * The teacher's corrections after a scored attempt: one red-pen mark per onset group that went
 * wrong, came too soon or too late (or, in rhythm mode, was missed), was spread out or re-attacked a tie, built from the record's
 * per-group outcomes (pure).
 */
import type { Timeline } from '../../core/engine'
import { passageBounds, type PassageBounds } from '../../core/model/passage'
import type { AttemptRecord, GroupOutcome } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import { ge, lt } from '../../core/music/rational'
import { NATURAL, labelFor, labelForMidi } from '../../core/naming'
import type { CorrectionMark } from '../../render/strip/StripView'

export type { CorrectionMark }

/** A group completed at least this long after the music reached it is marked "Too late" (ms). */
export const LATE_MARK_MS = 350
/** A chord whose first and last attacks are at least this far apart is marked "Together" (ms). */
export const SPREAD_MARK_MS = 90

/** The parts of the score `correctionMarks` reads (`ScoreModel` satisfies it). */
export type CorrectionScore = Pick<ScoreModel, 'notes' | 'occurrences' | 'totalDuration'>

type Group = Timeline['groups'][number]

/**
 * One mark per group with a problem, in group order. A group with several gets the first of:
 * a wrong accidental ("F♯, not F"), a wrong octave ("Wrong octave ↑"), another wrong key ("Wrong
 * note(s)"), a re-attacked tie ("Tied, hold it"), a spread chord ("Together"), too soon, too
 * late. In a strict (rhythm mode) record a group the music passed is "Missed" (after the wrong
 * classes), and "Too late" means more than the record's tolerance after its scheduled time. A mark's notes are the group's performed-note indices (the strip's note ids) whose onset
 * lies inside the attempt's passage: a ring never goes around notes outside it (a tie head before
 * the loop start), and a mark with none left is dropped.
 * `score` spells the target as the score does, with the `naming` settings. Records without
 * per-group outcomes (older ones) give none; outcomes without the newer optional fields give
 * only the older classes.
 */
export function correctionMarks(
  record: AttemptRecord,
  timeline: Timeline,
  score: CorrectionScore,
  naming: NamingSettings,
): CorrectionMark[] {
  const bounds = attemptBounds(record, score)
  const marks: CorrectionMark[] = []
  for (const g of record.groups ?? []) {
    const group = timeline.groups[g.group]
    if (!group) continue
    const notes = group.notes.filter((n) => {
      const note = score.notes[n]
      return note !== undefined && (!bounds || (ge(note.onset, bounds.start) && lt(note.onset, bounds.end)))
    })
    if (notes.length === 0) continue
    const mark = classify(g, group, score, naming, record.rhythm?.toleranceMs)
    if (mark) marks.push({ notes, ...mark })
  }
  return marks
}

/** The attempt's passage bounds; null (no filter) when the record's passage does not fit the score. */
function attemptBounds(record: AttemptRecord, score: CorrectionScore): PassageBounds | null {
  const passage = record.context?.passage
  if (!passage) return null
  try {
    return passageBounds(score, passage)
  } catch {
    return null
  }
}

function classify(
  g: GroupOutcome,
  group: Group,
  score: CorrectionScore,
  naming: NamingSettings,
  strictToleranceMs: number | undefined,
): Omit<CorrectionMark, 'notes'> | null {
  const wrongPitches = g.wrongPitches ?? []
  for (const p of wrongPitches) {
    const text = accidentalSlip(p, group, score, naming)
    if (text) return { kind: 'accidental', text }
  }
  for (const p of wrongPitches) {
    const text = octaveSlip(p, group)
    if (text) return { kind: 'octave', text }
  }
  // `wrongAttacks` includes the too-early ones (right pitch, too soon) and may include tie-end
  // presses; the wrong pitches, when recorded, are the plain wrong keys.
  const wrong = g.wrongPitches
    ? g.wrongPitches.length
    : Math.max(0, g.wrongAttacks - g.earlyAttacks - (g.tieEndPresses ?? 0))
  if (wrong > 0) return { kind: 'wrong', text: wrong > 1 ? 'Wrong notes' : 'Wrong note' }
  if ((g.tieEndPresses ?? 0) > 0) return { kind: 'tie', text: 'Tied, hold it' }
  if ((g.spreadMs ?? 0) >= SPREAD_MARK_MS && group.pitches.length >= 2) return { kind: 'spread', text: 'Together' }
  if (strictToleranceMs !== undefined) {
    // Rhythm mode: the music never waited, so lateness is the offset from the scheduled time.
    if (g.missed === true) return { kind: 'missed', text: 'Missed' }
    if (g.earlyAttacks > 0) return { kind: 'early', text: 'Too soon' }
    if ((g.offsetMs ?? 0) > strictToleranceMs) return { kind: 'late', text: 'Too late' }
    return null
  }
  if (g.earlyAttacks > 0) return { kind: 'early', text: 'Too soon' }
  if (g.lateMs >= LATE_MARK_MS) return { kind: 'late', text: 'Too late' }
  return null
}

/**
 * A required pitch one semitone from the pressed key on the same letter (pressed F for F♯, F♯ /
 * G♭ for F♮ or G♮; the live accidental cue's rule, U30 revised): "F♯, not F", the target spelled
 * as the score does with its accidental always shown (♮ for a natural), the pressed key on the
 * target's letter. Null when no required pitch qualifies.
 */
function accidentalSlip(pitch: number, group: Group, score: CorrectionScore, naming: NamingSettings): string | null {
  const shown = { ...naming, alwaysShowEffectiveAccidentals: true }
  const pressed = [labelForMidi(pitch, shown, 'sharp'), labelForMidi(pitch, shown, 'flat')]
  for (let k = 0; k < group.pitches.length; k++) {
    if (Math.abs(group.pitches[k]! - pitch) !== 1) continue
    const note = score.notes[group.notesByPitch[k]?.[0] ?? -1]
    if (!note) continue
    const target = labelFor(note, shown)
    const wrong = pressed.find((l) => l.name === target.name)
    if (!wrong) continue
    return `${target.name}${target.accidental || NATURAL}${target.octave ?? ''}, not ${wrong.text}`
  }
  return null
}

/** The nearest required pitch 12 or 24 semitones away (a tie favors the lower): "Wrong octave ↑/↓". */
function octaveSlip(pitch: number, group: Group): string | null {
  let target: number | null = null
  for (const required of group.pitches) {
    const d = Math.abs(required - pitch)
    if (d !== 12 && d !== 24) continue
    const best = target === null ? Infinity : Math.abs(target - pitch)
    if (d < best || (d === best && required < target!)) target = required
  }
  if (target === null) return null
  return `Wrong octave ${target > pitch ? '↑' : '↓'}`
}
