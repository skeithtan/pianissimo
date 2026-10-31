import type { Spelling, Step } from '../music/pitch'
import { spellingToMidi } from '../music/pitch'

/** Natural step for each pitch class that is a white key. */
const WHITE_STEP: Readonly<Record<number, Step>> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' }
/** Black-key spellings by pitch class, as [sharp, flat]. */
const BLACK_SPELLING: Readonly<Record<number, readonly [Step, Step]>> = {
  1: ['C', 'D'],
  3: ['D', 'E'],
  6: ['F', 'G'],
  8: ['G', 'A'],
  10: ['A', 'B'],
}

/** Scientific octave of a MIDI note (C4 = 60). */
export function midiOctave(midi: number): number {
  return Math.floor(midi / 12) - 1
}

/**
 * Plain spelling of a piano key: natural for white keys, sharp or flat for black keys by
 * `prefer`. The octave is the pitch's own octave (no B♯/C♭ crossings occur here).
 */
export function spellMidi(midi: number, prefer: 'sharp' | 'flat' = 'sharp'): Spelling {
  const pc = ((midi % 12) + 12) % 12
  const octave = midiOctave(midi)
  const natural = WHITE_STEP[pc]
  if (natural) return { step: natural, alter: 0, octave }
  const black = BLACK_SPELLING[pc]
  if (!black) throw new Error(`Unreachable pitch class ${pc}`)
  return prefer === 'sharp' ? { step: black[0], alter: 1, octave } : { step: black[1], alter: -1, octave }
}

/**
 * Spec "Simplify enharmonic names": the same piano key with the simplest name.
 *  - A spelling on a white key becomes the natural name (B♯→C, C♭→B, E♯→F, F♭→E, F𝄪→G, B𝄫→A…).
 *  - A single sharp or flat on a black key is an ordinary spelling and is kept (E♭, C♯).
 *  - A double accidental on a black key (E𝄪, B𝄪, F𝄫, C𝄫) becomes a single accidental in the
 *    original direction (E𝄪→F♯, F𝄫→E♭).
 * The octave is recalculated from the pitch, so B♯4 is C5 and C♭4 is B3.
 */
export function simplifySpelling(s: Spelling): Spelling {
  if (s.alter === 0) return s
  const midi = spellingToMidi(s)
  const pc = ((midi % 12) + 12) % 12
  if (WHITE_STEP[pc]) return spellMidi(midi)
  if (Math.abs(s.alter) === 1) return s
  return spellMidi(midi, s.alter > 0 ? 'sharp' : 'flat')
}

/**
 * Guard for data outside the supported alteration range (microtones, triple accidentals):
 * such a pitch is respelled as the nearest plain piano key instead of failing a label.
 */
export function normalizeSpelling(s: Spelling): Spelling {
  if (Number.isInteger(s.alter) && Math.abs(s.alter) <= 2) return s
  return spellMidi(Math.round(spellingToMidi(s)), s.alter < 0 ? 'flat' : 'sharp')
}
