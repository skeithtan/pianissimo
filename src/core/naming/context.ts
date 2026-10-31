import type { Step } from '../music/pitch'
import type { AccidentalContext } from '../model/score'

const SHARP_ORDER: readonly Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const FLAT_ORDER: readonly Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F']

/** Alteration (-1, 0 or +1) a key signature of `fifths` applies to every octave of `step`. */
export function keySignatureAlter(step: Step, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, Math.min(fifths, 7)).includes(step) ? 1 : 0
  if (fifths < 0) return FLAT_ORDER.slice(0, Math.min(-fifths, 7)).includes(step) ? -1 : 0
  return 0
}

/**
 * The alteration a reader assumes for this written staff position *before* the note's own
 * accidental: the latest carried accidental on the same step and written octave, otherwise
 * the key signature. `writtenOctave` is the engraved octave (sounding octave minus ottava shift).
 */
export function contextAlter(context: AccidentalContext, step: Step, writtenOctave: number): number {
  for (let i = context.carried.length - 1; i >= 0; i--) {
    const entry = context.carried[i]
    if (entry && entry[0] === step && entry[1] === writtenOctave) return entry[2]
  }
  return keySignatureAlter(step, context.keyFifths)
}
