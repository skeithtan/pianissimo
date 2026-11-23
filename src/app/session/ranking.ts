import { msg } from '../../i18n/messages'
/**
 * The expanded result card's ranking of a pass's mistakes (DECISIONS U99), with the wrong keys in
 * words and as ghost notes. Pure; kept apart from `mistakes.ts` (which the session needs on every
 * result) so it loads with the card, on its first expansion, not with Practice.
 */
import { barLabel, type Timeline } from '../../core/engine'
import type { GroupOutcome } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import { diatonicIndex, type Spelling } from '../../core/music/pitch'
import { NATURAL, accidentalGlyph, contextAlter, labelFor, labelForMidi, spellMidi } from '../../core/naming'
import type { GhostNote } from '../../render/excerpt'
import { COUNTS, LETTERS, REPEATED_MISTAKE_PASSES, pressNames, sameLetterSpelling, standInFor } from './mistakes'
import type { PassRecord } from './run'

type Group = Timeline['groups'][number]

/** "three passes running", "twice now" (2), "" for a mistake of this pass only. */
export function passesText(passes: number): string {
  if (passes >= 3) return msg('{0} passes running', msg(COUNTS[passes] ?? String(passes)))
  return passes === 2 ? msg('twice now') : ''
}

/**
 * How a wrong key relates to the music written at its place: the same letter a semitone off (an
 * accidental slip), the same note in another octave, a key one or two semitones from a written
 * note (a finger on the neighbor key), or a key that belongs to nothing written there.
 */
export type PressKind = 'accidental' | 'octave' | 'neighbor' | 'extra'

/** A key pressed in place of a written note is within this many semitones of it (`neighbor`). */
export const NEIGHBOR_SEMITONES = 2

/** One wrong key of the latest pass at one place. */
export interface WrongPress {
  /** The key (MIDI). */
  readonly pitch: number
  readonly kind: PressKind
  /** The written pitch it stood for (`standInFor`); for `extra`, the nearest written pitch. */
  readonly expectedPitch: number
  /** Performed-note index of `expectedPitch`: its spelling, staff and notehead in the score. */
  readonly expectedNote: number
  /** Passes running, the latest included, with this key at this place (1: this pass only). */
  readonly passes: number
}

/**
 * Severity, most severe first: the same wrong key at the same place three or more passes running
 * (P24), the same key twice running (a habit forming), the same place wrong in several recent
 * passes with different keys, then this pass only: a wrong key in place of a written note, an
 * extra key, a group the music passed (Keep time), timing and touch (too soon, too late, a
 * spread chord, a re-attacked tie).
 */
export type MistakeLevel = 'repeated' | 'habit' | 'trouble' | 'replaced' | 'extra' | 'missed' | 'timing'

export const MISTAKE_LEVELS: readonly MistakeLevel[] = [
  'repeated',
  'habit',
  'trouble',
  'replaced',
  'extra',
  'missed',
  'timing',
]

/** One place (an onset group) of the latest pass that went wrong, with why it ranks where it does. */
export interface RankedMistake {
  readonly level: MistakeLevel
  /** A few words on why it ranks here ("Same wrong key three passes running"). */
  readonly reason: string
  /** Engine group index in the loop's timeline. */
  readonly group: number
  readonly occ: number
  /** Printed bar label: "12", or "12 (pass 2)". */
  readonly bar: string
  /** The group's written notes inside the passage (performed-note indices: the ring's notes). */
  readonly notes: readonly number[]
  /** This pass's wrong keys at the group, most passes first, then low to high. */
  readonly presses: readonly WrongPress[]
  /** Recent passes that reached the group and went wrong there, the latest included (`trouble`). */
  readonly passesWrong: number
  /** Recent passes that reached the group (the denominator of `passesWrong`). */
  readonly passesReached: number
  /** The correction mark's kind and text at the group (the ring's label), when it has one. */
  readonly mark: { readonly kind: string; readonly text: string } | null
}

/** A group's correction mark (`correctionMarksByGroup`): the ring's notes, kind and text. */
export interface GroupMark {
  readonly notes: readonly number[]
  readonly kind: string
  readonly text: string
}

const TIMING_KINDS = new Set(['early', 'late', 'spread', 'tie'])

/** Plain wrong keys of a group outcome (records before `wrongPitches` existed have none). */
function wrongKeys(g: GroupOutcome): number[] {
  return [...new Set(g.wrongPitches ?? [])]
}

/**
 * The latest pass's mistakes ranked by severity (`MistakeLevel`), for the expanded result card.
 * Uses only `records` (the session's last passes, oldest first; only those of the latest
 * record's comparison context count) and the group marks of the latest record. Within a level:
 * more passes first (repeated, habit), more passes wrong at the place (trouble), more wrong keys,
 * then score order. A group with neither a wrong key nor a mark is left out.
 */
export function rankMistakes(
  records: readonly PassRecord[],
  timeline: Timeline,
  model: Pick<ScoreModel, 'notes' | 'occurrences'>,
  marks: ReadonlyMap<number, GroupMark>,
): RankedMistake[] {
  const latest = records.at(-1)
  if (!latest || latest.kind === 'reading' || !latest.groups) return []
  const run = records.filter((r) => r.kind !== 'reading' && r.groups && r.contextKey === latest.contextKey)
  // By group: a pass can be a whole piece.
  const byGroup = run.map((r) => new Map(r.groups!.map((g) => [g.group, g])))
  const out: RankedMistake[] = []
  for (const outcome of latest.groups) {
    const group = timeline.groups[outcome.group]
    if (!group) continue
    const mark = marks.get(outcome.group) ?? null
    const keys = wrongKeys(outcome)
    const earlier = byGroup.map((groups) => groups.get(outcome.group))
    const presses: WrongPress[] = keys.map((pitch) => {
      let passes = 0
      for (let i = earlier.length - 1; i >= 0; i--) {
        const e = earlier[i]
        if (!e) continue
        if (!(e.wrongPitches ?? []).includes(pitch)) break
        passes++
      }
      const k = standInFor(pitch, group, model)
      const expectedPitch = group.pitches[k]!
      return {
        pitch,
        kind: pressKind(pitch, expectedPitch, group, model),
        expectedPitch,
        expectedNote: group.notesByPitch[k]?.[0] ?? group.notes[0]!,
        passes: Math.max(1, passes),
      }
    })
    presses.sort((a, b) => b.passes - a.passes || a.pitch - b.pitch)
    const reached = earlier.filter((e) => e !== undefined)
    const wrongAt = (e: GroupOutcome) =>
      (e.wrongPitches ?? []).length > 0 ||
      (!e.wrongPitches && e.wrongAttacks - e.earlyAttacks - (e.tieEndPresses ?? 0) > 0)
    const passesWrong = keys.length > 0 ? reached.filter(wrongAt).length : 0
    const top = presses[0]?.passes ?? 0
    let level: MistakeLevel
    if (top >= REPEATED_MISTAKE_PASSES) level = 'repeated'
    else if (top === 2) level = 'habit'
    else if (passesWrong >= 2) level = 'trouble'
    else if (presses.some((p) => p.kind !== 'extra')) level = 'replaced'
    else if (presses.length > 0) level = 'extra'
    else if (mark?.kind === 'missed') level = 'missed'
    else if (mark && TIMING_KINDS.has(mark.kind)) level = 'timing'
    else continue
    out.push({
      level,
      reason: reasonFor(level, top, passesWrong, reached.length, mark),
      group: outcome.group,
      occ: group.occ,
      bar: barLabel(model as ScoreModel, group.occ),
      notes: mark?.notes ?? group.notes,
      presses,
      passesWrong,
      passesReached: reached.length,
      mark: mark ? { kind: mark.kind, text: mark.text } : null,
    })
  }
  const rank = (m: RankedMistake) => MISTAKE_LEVELS.indexOf(m.level)
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.presses[0]?.passes ?? 0) - (a.presses[0]?.passes ?? 0) ||
      b.passesWrong - a.passesWrong ||
      b.presses.length - a.presses.length ||
      a.group - b.group,
  )
}

function pressKind(pitch: number, expected: number, group: Group, model: Pick<ScoreModel, 'notes'>): PressKind {
  const d = Math.abs(pitch - expected)
  if (d === 12 || d === 24) return 'octave'
  if (d === 1) {
    const k = group.pitches.indexOf(expected)
    const note = model.notes[group.notesByPitch[k]?.[0] ?? -1]
    if (note && sameLetterSpelling(pitch, labelFor(note, LETTERS)) !== null) return 'accidental'
  }
  return d > 0 && d <= NEIGHBOR_SEMITONES ? 'neighbor' : 'extra'
}

function reasonFor(
  level: MistakeLevel,
  passes: number,
  passesWrong: number,
  reached: number,
  mark: GroupMark | null,
): string {
  switch (level) {
    case 'repeated':
      return msg('Same wrong key {0}', passesText(passes))
    case 'habit':
      return msg('Same wrong key twice now')
    case 'trouble':
      return msg(
        'Wrong here in {0} of the last {1} passes',
        msg(COUNTS[passesWrong] ?? String(passesWrong)),
        msg(COUNTS[reached] ?? String(reached)),
      )
    case 'replaced':
      return msg('A wrong key in place of a written note')
    case 'extra':
      return msg('A key that is not in the score here')
    case 'missed':
      return msg('The music moved on before it was played')
    case 'timing':
      return mark?.text ?? msg('Timing')
  }
}

/**
 * A wrong press in plain words, named with the naming settings: a key in place of a written
 * note, "You pressed D♭ where D♮ is written"; another octave, "You pressed C3; the note is C4";
 * a key that belongs to nothing written there, "You pressed E♭4: it is not in the score here"
 * (spelled in the key signature's direction: flats in a flat key, else sharps).
 */
export function wrongPressLine(p: WrongPress, score: Pick<ScoreModel, 'notes'>, naming: NamingSettings): string {
  if (p.kind === 'extra') {
    const note = score.notes[p.expectedNote]
    const prefer = (note?.accidentalContext.keyFifths ?? 0) < 0 ? 'flat' : 'sharp'
    const shown: NamingSettings = { ...naming, alwaysShowEffectiveAccidentals: true, showOctave: true }
    return msg('You pressed {0}: it is not in the score here', labelForMidi(p.pitch, shown, prefer).text)
  }
  if (p.kind === 'octave') {
    const shown: NamingSettings = { ...naming, showOctave: true }
    const [wrong, expected] = pressNames(p.pitch, p.expectedPitch, p.expectedNote, score, shown)
    return msg('You pressed {0}; the note is {1}', wrong, expected)
  }
  const [wrong, expected] = pressNames(p.pitch, p.expectedPitch, p.expectedNote, score, naming)
  return msg('You pressed {0} where {1} is written', wrong, expected)
}

/**
 * How a wrong press is spelled on the staff: on the written note's letter when it is a semitone
 * slip or a wrong octave (F for F♯); otherwise in the written note's accidental direction, else
 * the key signature's (flats in a flat key).
 */
export function pressSpelling(p: WrongPress, score: Pick<ScoreModel, 'notes'>): Spelling {
  const note = score.notes[p.expectedNote]
  if (note && (p.kind === 'accidental' || p.kind === 'octave')) {
    for (const prefer of ['sharp', 'flat'] as const) {
      const s = spellMidi(p.pitch, prefer)
      if (s.step === note.sounding.step) return s
    }
  }
  const alter = note?.sounding.alter ?? 0
  const flat = alter < 0 || (alter === 0 && (note?.accidentalContext.keyFifths ?? 0) < 0)
  return spellMidi(p.pitch, flat ? 'flat' : 'sharp')
}

/**
 * The ghost notehead for a wrong press on the excerpt (U99): on the staff of the written note it
 * stood for (an extra key: the nearest written note's), at its written position relative to that
 * note. Under an ottava the ghost is placed as the printed notes there are (its sounding pitch
 * shifted by the anchor's ottava), so it reads with the bracket. The accidental is shown when it
 * differs from what a reader assumes there (a written note of the place on the same line, else
 * the carried accidental or key signature). Null without a written anchor note (or a grace or cue
 * anchor, whose small heads would misplace it).
 */
export function pressGhost(
  p: WrongPress,
  place: readonly number[],
  score: Pick<ScoreModel, 'notes'>,
): GhostNote | null {
  const anchor = score.notes[p.expectedNote]
  if (!anchor || anchor.grace || anchor.cue) return null
  const sounding = pressSpelling(p, score)
  const written: Spelling = { ...sounding, octave: sounding.octave - anchor.ottavaShift }
  const steps = diatonicIndex(written) - diatonicIndex(anchor.written)
  const sameLine = place
    .map((n) => score.notes[n])
    .find(
      (n) => n && n.staff === anchor.staff && n.written.step === written.step && n.written.octave === written.octave,
    )
  const implied = sameLine
    ? sameLine.written.alter
    : contextAlter(anchor.accidentalContext, written.step, written.octave)
  const accidental = written.alter === implied ? '' : written.alter === 0 ? NATURAL : accidentalGlyph(written.alter)
  return { anchor: anchor.index, steps, accidental, place }
}
