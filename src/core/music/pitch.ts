/**
 * Pitch spelling and MIDI conversion.
 *
 * A `Spelling` keeps the score's letter + alteration + octave (scientific pitch
 * notation, middle C = C4 = MIDI 60). The MIDI number is the piano key; enharmonic
 * spellings of one key share a MIDI number. Correctness is always judged on MIDI numbers.
 */
export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B'

export const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

/** Semitones above C for each natural step. */
export const STEP_SEMITONES: Readonly<Record<Step, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}

export interface Spelling {
  readonly step: Step
  /** Chromatic alteration in semitones: -2 (𝄫) … +2 (𝄪). Non-integers are microtones (unsupported). */
  readonly alter: number
  /** Scientific octave: C4 is middle C. B♯3 is spelled in octave 3 but sounds as C4. */
  readonly octave: number
}

export function spellingToMidi(s: Spelling): number {
  return (s.octave + 1) * 12 + STEP_SEMITONES[s.step] + s.alter
}

export function isStep(x: string): x is Step {
  return x.length === 1 && 'CDEFGAB'.includes(x)
}

/** Diatonic index (C0 = 0, D0 = 1, … C4 = 28). Useful for staff positions and ledger math. */
export function diatonicIndex(s: Pick<Spelling, 'step' | 'octave'>): number {
  return s.octave * 7 + STEPS.indexOf(s.step)
}

/** Shift a spelling by whole octaves (used for ottava written/sounding conversion). */
export function shiftOctaves(s: Spelling, octaves: number): Spelling {
  return { step: s.step, alter: s.alter, octave: s.octave + octaves }
}

export const MIDI_MIN_PIANO = 21 // A0
export const MIDI_MAX_PIANO = 108 // C8
