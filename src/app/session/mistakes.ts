/**
 * Repeated mistakes (DECISIONS P24): the same wrong key at the same place of a loop, pass after
 * pass, found in the per-group outcomes of the session's recent scored attempts (pure). The
 * session computes them in its frame, never in the MIDI input path, and hands them to the result
 * card as `AttemptSummary.repeatedMistakes`; `repeatedMistakeLine` words one for it.
 */
import { barLabel, type Timeline } from '../../core/engine'
import type { AttemptRecord } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import { NATURAL, labelFor, labelForMidi, type NoteLabel } from '../../core/naming'

/**
 * Passes in a row with the same wrong key at the same group before it counts as a habit: three,
 * like the spec's recurring-mistake flag (three error-bearing passes) and its recovery streak
 * (three clean passes). Two can be chance; a third is a pattern worth naming.
 */
export const REPEATED_MISTAKE_PASSES = 3
/** Recent scored attempts the session keeps to look for them. */
export const REPEATED_MISTAKE_HISTORY = 8

export interface RepeatedMistake {
  /** Engine group index in the loop's timeline (`timeline.groups`). */
  readonly group: number
  /** Measure occurrence of the group. */
  readonly occ: number
  /** Printed bar label: "12", or "12 (pass 2)" in a repeat. */
  readonly bar: string
  /** Every pitch the group requires (MIDI, ascending). */
  readonly expectedPitches: readonly number[]
  /** The required pitch the wrong key most likely stood for (see `standInFor`). */
  readonly expectedPitch: number
  /** Performed-note index of `expectedPitch`: its spelling in the score. */
  readonly expectedNote: number
  /** The wrong key (MIDI). */
  readonly wrongPitch: number
  /** Passes running, the latest included, with this wrong key at this group (≥ the threshold). */
  readonly passes: number
}

/**
 * The repeated mistakes of the latest attempt in `records` (oldest first): each wrong pitch of
 * its per-group outcomes that also occurred at the same group in the passes before it, counted
 * back while each earlier attempt of the same comparison context that reached the group had it.
 * An attempt that did not reach the group (stopped earlier) is skipped; one that reached it
 * without that wrong key ends the count. Only scored attempts with per-group outcomes count, and
 * the timeline must be the one the latest attempt ran on. Sorted by passes (most first), then
 * by group.
 */
export function repeatedMistakes(
  records: readonly AttemptRecord[],
  timeline: Timeline,
  model: Pick<ScoreModel, 'notes' | 'occurrences'>,
  minPasses: number = REPEATED_MISTAKE_PASSES,
): RepeatedMistake[] {
  const latest = records.at(-1)
  if (!latest || latest.kind !== 'scored' || !latest.groups) return []
  const run = records.filter((r) => r.kind === 'scored' && r.groups && r.contextKey === latest.contextKey)
  const out: RepeatedMistake[] = []
  for (const outcome of latest.groups) {
    const group = timeline.groups[outcome.group]
    if (!group) continue
    for (const wrongPitch of new Set(outcome.wrongPitches ?? [])) {
      let passes = 0
      for (let i = run.length - 1; i >= 0; i--) {
        const earlier = run[i]!.groups!.find((g) => g.group === outcome.group)
        if (!earlier) continue
        if (!(earlier.wrongPitches ?? []).includes(wrongPitch)) break
        passes++
      }
      if (passes < minPasses) continue
      const k = standInFor(wrongPitch, group, model)
      out.push({
        group: outcome.group,
        occ: group.occ,
        bar: barLabel(model as ScoreModel, group.occ),
        expectedPitches: group.pitches,
        expectedPitch: group.pitches[k]!,
        expectedNote: group.notesByPitch[k]?.[0] ?? group.notes[0]!,
        wrongPitch,
        passes,
      })
    }
  }
  return out.sort((a, b) => b.passes - a.passes || a.group - b.group || a.wrongPitch - b.wrongPitch)
}

type Group = Timeline['groups'][number]

/**
 * Index in `group.pitches` of the required pitch a wrong key most likely replaced: one a
 * semitone away on the same letter (F for F♯, the accidental slip), else one 12 or 24 semitones
 * away (the wrong octave), else the nearest; equal distances favor the lower pitch.
 */
export function standInFor(pitch: number, group: Group, model: Pick<ScoreModel, 'notes'>): number {
  const ps = group.pitches
  for (let k = 0; k < ps.length; k++) {
    if (Math.abs(ps[k]! - pitch) !== 1) continue
    const note = model.notes[group.notesByPitch[k]?.[0] ?? -1]
    if (note && sameLetterSpelling(pitch, labelFor(note, LETTERS)) !== null) return k
  }
  let best = -1
  for (let pass = 0; pass < 2 && best < 0; pass++) {
    for (let k = 0; k < ps.length; k++) {
      const d = Math.abs(ps[k]! - pitch)
      if (pass === 0 && d !== 12 && d !== 24) continue
      if (best < 0 || d < Math.abs(ps[best]! - pitch)) best = k
    }
  }
  return Math.max(0, best)
}

export const LETTERS: NamingSettings = {
  system: 'letter',
  seventh: 'si',
  showOctave: false,
  alwaysShowEffectiveAccidentals: true,
  simplifyEnharmonics: false,
}

/** The wrong key spelled on the target's letter (F for F♯, F♯ for F♮), or null. */
export function sameLetterSpelling(
  pitch: number,
  target: NoteLabel,
  naming: NamingSettings = LETTERS,
): NoteLabel | null {
  for (const prefer of ['sharp', 'flat'] as const) {
    const l = labelForMidi(pitch, naming, prefer)
    if (l.name === target.name) return l
  }
  return null
}

export const COUNTS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/**
 * The names of a wrong key and the note it stood for: the expected note spelled as the score
 * does, with its accidental always shown (♮ when the wrong key is on the same letter); the wrong
 * key on the target's letter when it can be, else in the target's accidental direction; octave
 * numbers only when the two names would otherwise read the same (a wrong octave).
 */
export function pressNames(
  wrongPitch: number,
  expectedPitch: number,
  expectedNote: number,
  score: Pick<ScoreModel, 'notes'>,
  naming: NamingSettings,
): [wrong: string, expected: string] {
  const note = score.notes[expectedNote]
  const plain: NamingSettings = { ...naming, alwaysShowEffectiveAccidentals: true, showOctave: false }
  const octaves: NamingSettings = { ...plain, showOctave: true }
  const names = (n: NamingSettings): [string, string] => {
    const target = note ? labelFor(note, n) : labelForMidi(expectedPitch, n)
    // On the target's letter only a semitone away (F for F♯), never an octave away.
    const same = (wrongPitch - expectedPitch) % 12 === 0 ? null : sameLetterSpelling(wrongPitch, target, n)
    const wrong = same ?? labelForMidi(wrongPitch, n, target.accidental.includes('♭') ? 'flat' : 'sharp')
    const accidental = target.accidental || (same ? NATURAL : '')
    return [wrong.text, `${target.name}${accidental}${target.octave ?? ''}`]
  }
  const [wrong, expected] = names(plain)
  return wrong === expected ? names(octaves) : [wrong, expected]
}

/**
 * The result card's line for a repeated mistake: "F instead of F♯ in bar 12, three passes
 * running". Spelled by `pressNames`. Naming settings (letters or fixed do, si/ti, enharmonic
 * simplification) apply to both names.
 */
export function repeatedMistakeLine(
  m: RepeatedMistake,
  score: Pick<ScoreModel, 'notes'>,
  naming: NamingSettings,
): string {
  const [wrong, expected] = pressNames(m.wrongPitch, m.expectedPitch, m.expectedNote, score, naming)
  const passes = COUNTS[m.passes] ?? String(m.passes)
  return `${wrong} instead of ${expected} in bar ${m.bar}, ${passes} passes running`
}
