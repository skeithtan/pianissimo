import { msg } from '../../i18n/messages'
/**
 * The expanded result card's ranking of a pass's mistakes (DECISIONS U99), with the wrong keys in
 * words and as ghost notes. Pure; kept apart from `mistakes.ts` (which the session needs on every
 * result) so it loads with the card, on its first expansion, not with Practice.
 */
import { barLabel, type Timeline } from '../../core/engine'
import type { SpotVisit } from '../../core/history'
import type { GroupOutcome } from '../../core/model/practice'
import type { ClefKey, Hand, ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import { diatonicIndex, type Spelling, type Step } from '../../core/music/pitch'
import {
  NATURAL,
  accidentalGlyph,
  clefShortName,
  contextAlter,
  labelFor,
  labelForMidi,
  simplifySpelling,
  spellMidi,
  stepName,
} from '../../core/naming'
import type { GhostNote } from '../../render/excerpt'
import { causeClef, isHunting, pressCause, type PressCause } from './causes'
import { classifyCorrections } from './corrections'
import { COUNTS, LETTERS, REPEATED_MISTAKE_PASSES, pressNames, sameLetterSpelling, standInFor } from './mistakes'
import { pauseThresholdMs } from './pauses'
import type { MistakePattern } from './patterns'
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
  /**
   * Struck together with a right note (`true` in `extraPitches`), pressed alone (`false` when
   * `extraPitches` is present and the pitch is not in it), or unknown (`null` on older records).
   */
  readonly together: boolean | null
  /** True when the group required two or more distinct pitches ("... with the chord"). */
  readonly chord?: boolean
  /** Probable cause for a wrong key pressed alone (`together === false`). */
  readonly cause?: PressCause
  /** Current clef on the staff when `cause === 'clef'`. */
  readonly clef?: ClefKey | null
}

/**
 * Severity, most severe first: the same wrong key at the same place three or more passes running
 * (P24), the same key twice running (a habit forming), the same place wrong in several recent
 * passes with different keys, then this pass only: a wrong key in place of a written note, an
 * extra key, a group the music passed (Keep time), timing and touch (too soon, too late, a
 * spread chord, a re-attacked tie).
 */
export type MistakeLevel = 'repeated' | 'habit' | 'trouble' | 'hesitation' | 'replaced' | 'extra' | 'missed' | 'timing'

export const MISTAKE_LEVELS: readonly MistakeLevel[] = [
  'repeated',
  'habit',
  'trouble',
  'hesitation',
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
  /** Recent gated passes that paused cleanly at or above `pauseThresholdMs` (`hesitation`). */
  readonly passesPaused?: number
  /** The correction mark's kind and text at the group (the ring's label), when it has one. */
  readonly mark: { readonly kind: string; readonly text: string; readonly repeat?: number } | null
  /** Additional problem classes at the same place beyond `mark`, in priority order. */
  readonly also?: readonly { readonly kind: string; readonly text: string }[]
  /** True when the player tried several different keys alone before the right note (`isHunting`). */
  readonly hunting?: boolean
  /** Two-hand chord: the hand whose attacks all came after the other's (`GroupOutcome.lateHand`). */
  readonly lateHand?: Hand | null
  /** Recent visits at this place, oldest first, at most 8, this pass last. */
  readonly history: readonly ('wrong' | 'clean')[]
}

/** A group's correction mark (`correctionMarksByGroup`): the ring's notes, kind and text. */
export interface GroupMark {
  readonly notes: readonly number[]
  readonly kind: string
  readonly text: string
  readonly repeat?: number
}

const TIMING_KINDS = new Set(['early', 'late', 'spread', 'tie'])

/** Plain wrong keys of a group outcome (records before `wrongPitches` existed have none). */
function wrongKeys(g: GroupOutcome): number[] {
  return [...new Set(g.wrongPitches ?? [])]
}

/**
 * The latest pass's mistakes ranked by severity (`MistakeLevel`), for the expanded result card.
 * Counts repeat streaks and trouble ratios from `spots` (visit history per group index of
 * `timeline`, oldest first, `latest` included); a place with no history behaves as this pass only.
 * Scored attempts and Wait runs count, never one reading traversal. Within a level: more passes
 * first (repeated, habit), more passes wrong at the place (trouble), more wrong keys, then score
 * order. A group with neither a wrong key nor a mark is left out.
 */
export function rankMistakes(
  latest: PassRecord | undefined,
  timeline: Timeline,
  model: Pick<ScoreModel, 'notes' | 'occurrences'> & { readonly clefs?: ScoreModel['clefs'] },
  marks: ReadonlyMap<number, GroupMark>,
  spots: ReadonlyMap<number, readonly SpotVisit[]>,
): RankedMistake[] {
  if (!latest || latest.kind === 'reading' || !latest.groups) return []
  const rhythm = latest.kind === 'run' ? undefined : latest.rhythm
  const causeModel = { notes: model.notes, clefs: model.clefs ?? [] }
  const out: RankedMistake[] = []
  for (const outcome of latest.groups) {
    const group = timeline.groups[outcome.group]
    if (!group) continue
    const mark = marks.get(outcome.group) ?? null
    const keys = wrongKeys(outcome)
    const visits = spots.get(outcome.group)
    const hasMemory = visits !== undefined && visits.length > 0
    const isChord = group.pitches.length >= 2
    const presses: WrongPress[] = keys.map((pitch) => {
      let passes = 0
      if (hasMemory) {
        for (let i = visits.length - 1; i >= 0; i--) {
          if (!visits[i]!.wrong.includes(pitch)) break
          passes++
        }
      }
      const k = standInFor(pitch, group, model)
      const expectedPitch = group.pitches[k]!
      const together: boolean | null = outcome.extraPitches === undefined ? null : outcome.extraPitches.includes(pitch)
      const cause: PressCause =
        together === false ? pressCause({ pitch, group: outcome.group, timeline, model: causeModel }) : null
      const clef = cause === 'clef' ? causeClef({ pitch, group: outcome.group, timeline, model: causeModel }) : null
      return {
        pitch,
        kind: pressKind(pitch, expectedPitch, group, model),
        expectedPitch,
        expectedNote: group.notesByPitch[k]?.[0] ?? group.notes[0]!,
        passes: Math.max(1, passes),
        together,
        ...(isChord ? { chord: true } : {}),
        ...(cause !== null ? { cause } : {}),
        ...(clef !== null ? { clef } : {}),
      }
    })
    presses.sort((a, b) => b.passes - a.passes || a.pitch - b.pitch)
    const passesReached = hasMemory ? visits.length : 1
    const passesWrong = keys.length > 0 ? (hasMemory ? visits.filter((v) => v.wrong.length > 0).length : 1) : 0
    const strict = latest.context.transport === 'strict' || rhythm !== undefined
    const pausedThisPass =
      !strict &&
      keys.length === 0 &&
      outcome.wrongAttacks === 0 &&
      outcome.missed !== true &&
      outcome.lateMs >= pauseThresholdMs(timeline, group)
    const passesPaused =
      pausedThisPass && hasMemory
        ? visits.filter(
            (v) =>
              !v.strict &&
              v.clean &&
              v.pauseMs >= pauseThresholdMs({ tempo: timeline.tempo, multiplier: v.multiplier }, group),
          ).length
        : 0
    const top = presses[0]?.passes ?? 0
    let level: MistakeLevel
    if (top >= REPEATED_MISTAKE_PASSES) level = 'repeated'
    else if (top === 2) level = 'habit'
    else if (passesWrong >= 2) level = 'trouble'
    else if (passesPaused >= 2) level = 'hesitation'
    else if (presses.some((p) => p.together !== true && p.kind !== 'extra')) level = 'replaced'
    else if (presses.length > 0) level = 'extra'
    else if (mark?.kind === 'missed') level = 'missed'
    else if (mark && TIMING_KINDS.has(mark.kind)) level = 'timing'
    else continue
    const history: readonly ('wrong' | 'clean')[] = hasMemory
      ? visits.slice(-8).map((v) => (v.clean ? 'clean' : 'wrong'))
      : [outcome.wrongAttacks === 0 && outcome.missed !== true ? 'clean' : 'wrong']
    const classes = classifyCorrections(outcome, group, timeline, model, LETTERS, rhythm?.toleranceMs)
    const also = classes.slice(1).map(({ kind, text }) => ({ kind, text }))
    const hunting = outcome.extraPitches !== undefined && isHunting(outcome)
    const lateHand = outcome.lateHand ?? null
    out.push({
      level,
      reason: reasonFor(level, top, passesWrong, passesPaused, passesReached, mark),
      group: outcome.group,
      occ: group.occ,
      bar: barLabel(model as ScoreModel, group.occ),
      notes: mark?.notes ?? group.notes,
      presses,
      passesWrong,
      passesReached,
      ...(passesPaused > 0 ? { passesPaused } : {}),
      mark: mark
        ? { kind: mark.kind, text: mark.text, ...(mark.repeat !== undefined ? { repeat: mark.repeat } : {}) }
        : null,
      also,
      ...(hunting ? { hunting: true } : {}),
      ...(lateHand !== null ? { lateHand } : {}),
      history,
    })
  }
  const rank = (m: RankedMistake) => MISTAKE_LEVELS.indexOf(m.level)
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.presses[0]?.passes ?? 0) - (a.presses[0]?.passes ?? 0) ||
      b.passesWrong - a.passesWrong ||
      (b.passesPaused ?? 0) - (a.passesPaused ?? 0) ||
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
  passesPaused: number,
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
    case 'hesitation':
      return msg(
        'Paused here in {0} of the last {1} passes',
        msg(COUNTS[passesPaused] ?? String(passesPaused)),
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

function accidentalWord(alter: number): string {
  switch (alter) {
    case 1:
      return msg('sharp')
    case -1:
      return msg('flat')
    case 2:
      return msg('double sharp')
    case -2:
      return msg('double flat')
    default:
      return msg('natural')
  }
}

function pitchClassName(step: Step, alter: number, naming: NamingSettings): string {
  const spelled = naming.simplifyEnharmonics ? simplifySpelling({ step, alter, octave: 4 }) : { step, alter, octave: 4 }
  return `${stepName(spelled.step, naming)}${accidentalGlyph(spelled.alter)}`
}

function clefPhrase(clefKey: ClefKey): string {
  if (clefKey === 'G2') return msg('treble')
  if (clefKey === 'F4') return msg('bass')
  return clefShortName(clefKey).toLowerCase()
}

/**
 * A wrong press in plain words, named with the naming settings:
 * - Struck together with a right note (`together === true`): "You also pressed F with G"
 *   ("... with the chord" for a chord).
 * - Pressed alone (`together === false`) with a cause: `jumped-ahead`, `replayed-previous` and
 *   `other-hand` replace the sentence; accidental causes and `clef` append a second sentence;
 *   `octave` adds nothing.
 * - Older records (`together === null`): today's distance-based wording unchanged.
 */
export function wrongPressLine(p: WrongPress, score: Pick<ScoreModel, 'notes'>, naming: NamingSettings): string {
  if (p.together === true) {
    const [wrong, expected] = pressNames(p.pitch, p.expectedPitch, p.expectedNote, score, naming)
    if (p.chord) return msg('You also pressed {0} with the chord', wrong)
    return msg('You also pressed {0} with {1}', wrong, expected)
  }

  const note = score.notes[p.expectedNote]
  const prefer = (note?.accidentalContext.keyFifths ?? 0) < 0 ? 'flat' : 'sharp'

  if (p.together === false && p.cause) {
    if (p.cause === 'jumped-ahead') return msg('You played the next note early.')
    if (p.cause === 'replayed-previous') return msg('You played the previous note again.')
    if (p.cause === 'other-hand') {
      const shown: NamingSettings = { ...naming, alwaysShowEffectiveAccidentals: true, showOctave: true }
      return msg("You pressed {0}: it is the other hand's note here.", labelForMidi(p.pitch, shown, prefer).text)
    }
  }

  let base: string
  if (p.kind === 'extra') {
    const shown: NamingSettings = { ...naming, alwaysShowEffectiveAccidentals: true, showOctave: true }
    base = msg('You pressed {0}: it is not in the score here', labelForMidi(p.pitch, shown, prefer).text)
  } else if (p.kind === 'octave') {
    const shown: NamingSettings = { ...naming, showOctave: true }
    const [wrong, expected] = pressNames(p.pitch, p.expectedPitch, p.expectedNote, score, shown)
    base = msg('You pressed {0}; the note is {1}', wrong, expected)
  } else {
    const [wrong, expected] = pressNames(p.pitch, p.expectedPitch, p.expectedNote, score, naming)
    base = msg('You pressed {0} where {1} is written', wrong, expected)
  }

  if (p.together !== false || !p.cause || p.cause === 'octave') return base

  const why = causeSentence(p, note, naming)
  return why ? `${base}. ${why}` : base
}

function causeSentence(
  p: WrongPress,
  note: ScoreModel['notes'][number] | undefined,
  naming: NamingSettings,
): string | null {
  switch (p.cause) {
    case 'key-signature': {
      if (!note) return null
      return msg('The key signature has {0}.', pitchClassName(note.written.step, note.written.alter, naming))
    }
    case 'carried-accidental':
      if (!note) return null
      return msg('The {0} from earlier in this bar still applies.', accidentalWord(note.written.alter))
    case 'printed-accidental':
      if (!note) return null
      return msg('The note has its own {0}.', accidentalWord(note.written.alter))
    case 'stale-accidental': {
      if (!note) return null
      const pressedAlter = note.written.alter + (p.pitch - p.expectedPitch)
      return msg('The {0} from the bar before does not apply here.', accidentalWord(pressedAlter))
    }
    case 'clef':
      if (!p.clef) return null
      return msg('Read in the clef before the change? This staff is in {0} clef now.', clefPhrase(p.clef))
    default:
      return null
  }
}

/** One pass-level pattern (`mistakePatterns`) in plain words, named with the naming settings. */
export function patternLine(pattern: MistakePattern, naming: NamingSettings): string {
  if (pattern.kind === 'hunting') {
    return msg('At {0} of {1} places you tried several keys.', pattern.count, pattern.of)
  }
  if (pattern.kind === 'hand') {
    return pattern.hand === 'L'
      ? msg('{0} of your {1} wrong notes were in the left hand.', pattern.count, pattern.of)
      : msg('{0} of your {1} wrong notes were in the right hand.', pattern.count, pattern.of)
  }
  switch (pattern.cause) {
    case 'key-signature':
      if (pattern.step !== undefined && pattern.alter !== undefined) {
        return msg(
          "{0} of your {1} wrong notes missed the key signature's {2}.",
          pattern.count,
          pattern.of,
          pitchClassName(pattern.step, pattern.alter, naming),
        )
      }
      return msg('{0} of your {1} wrong notes missed the key signature.', pattern.count, pattern.of)
    case 'printed-accidental':
      return msg('{0} of your {1} wrong notes missed a printed accidental.', pattern.count, pattern.of)
    case 'carried-accidental':
      return msg('{0} of your {1} wrong notes missed an accidental from earlier in the bar.', pattern.count, pattern.of)
    case 'stale-accidental':
      return msg(
        '{0} of your {1} wrong notes carried an accidental over from the bar before.',
        pattern.count,
        pattern.of,
      )
    case 'jumped-ahead':
      return msg('{0} of your {1} wrong notes were the next note, played early.', pattern.count, pattern.of)
    case 'replayed-previous':
      return msg('{0} of your {1} wrong notes repeated the previous note.', pattern.count, pattern.of)
    case 'other-hand':
      return msg("{0} of your {1} wrong notes were the other hand's note.", pattern.count, pattern.of)
    case 'clef':
      return msg('{0} of your {1} wrong notes were read in the previous clef.', pattern.count, pattern.of)
    case 'octave':
      return msg('{0} of your {1} wrong notes were in the wrong octave.', pattern.count, pattern.of)
  }
}

/** At most two pass-level pattern sentences for the expanded result card. */
export function patternLines(patterns: readonly MistakePattern[], naming: NamingSettings): string[] {
  return patterns.slice(0, 2).map((p) => patternLine(p, naming))
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
