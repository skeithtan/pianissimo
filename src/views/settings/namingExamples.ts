/**
 * Worked examples for the live naming preview (spec "Mistake feedback and hints": the table of
 * original effective pitches and the C♯-major B♯4 case). Each example is a performed-note shape
 * with the key signature a reader would see, so every naming switch visibly changes the result.
 */
import type { NamingSettings } from '../../core/model/settings'
import { labelText, type LabelableNote } from '../../core/naming'

export interface NamingExample {
  readonly id: string
  /** What is written, in plain words. */
  readonly description: string
  readonly note: LabelableNote
}

export const NAMING_EXAMPLES: readonly NamingExample[] = [
  {
    id: 'b-sharp-c-sharp-major',
    description: 'B♯4 in C♯ major',
    note: {
      sounding: { step: 'B', alter: 1, octave: 4 },
      ottavaShift: 0,
      accidentalContext: { keyFifths: 7, carried: [] },
    },
  },
  {
    id: 'c-sharp-d-major',
    description: 'C♯4 in D major (sharp from the key signature)',
    note: {
      sounding: { step: 'C', alter: 1, octave: 4 },
      ottavaShift: 0,
      accidentalContext: { keyFifths: 2, carried: [] },
    },
  },
  {
    id: 'f-double-sharp',
    description: 'F\u{1D12A}4',
    note: {
      sounding: { step: 'F', alter: 2, octave: 4 },
      ottavaShift: 0,
      accidentalContext: { keyFifths: 0, carried: [] },
    },
  },
  {
    id: 'b-flat-f-major',
    description: 'B♭4 in F major (flat from the key signature)',
    note: {
      sounding: { step: 'B', alter: -1, octave: 4 },
      ottavaShift: 0,
      accidentalContext: { keyFifths: -1, carried: [] },
    },
  },
]

/** The label each example gets under the given naming preferences. */
export function exampleLabels(naming: NamingSettings): readonly { example: NamingExample; label: string }[] {
  return NAMING_EXAMPLES.map((example) => ({ example, label: labelText(example.note, naming) }))
}
