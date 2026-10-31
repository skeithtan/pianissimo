import type { AccidentalContext, PerformedNote } from '../model/score'
import type { NamingSettings } from '../model/settings'
import type { Spelling, Step } from '../music/pitch'
import { contextAlter } from './context'
import { accidentalGlyph, NATURAL, visibleLength } from './glyphs'
import { normalizeSpelling, simplifySpelling, spellMidi } from './simplify'

/** The parts of a performed note that naming reads. `PerformedNote` satisfies this. */
export type LabelableNote = Pick<PerformedNote, 'sounding' | 'ottavaShift' | 'accidentalContext'>

/** A note name split into the parts a renderer can lay out separately. */
export interface NoteLabel {
  /** "C" … "B", or "do" … "si"/"ti" in fixed-do. */
  readonly name: string
  /** "♯", "♭", "♮", "𝄪", "𝄫" or "" when none is shown. */
  readonly accidental: string
  /** Displayed octave (middle C = 4), or null when octave display is off. */
  readonly octave: number | null
  /** `name + accidental + octave`, e.g. "C♯4" or "do♯4". */
  readonly text: string
}

const LETTER_NAMES: Readonly<Record<Step, string>> = { C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', A: 'A', B: 'B' }
const SOLFEGE: Readonly<Record<Step, string>> = { C: 'do', D: 're', E: 'mi', F: 'fa', G: 'sol', A: 'la', B: 'si' }

/** Name of a step in the configured naming system (fixed do: C is always do). */
export function stepName(step: Step, naming: Pick<NamingSettings, 'system' | 'seventh'>): string {
  if (naming.system === 'letter') return LETTER_NAMES[step]
  return step === 'B' && naming.seventh === 'ti' ? 'ti' : SOLFEGE[step]
}

function build(name: string, accidental: string, octave: number | null): NoteLabel {
  return { name, accidental, octave, text: `${name}${accidental}${octave ?? ''}` }
}

/**
 * Spec "Mistake feedback and hints": the label for a note's resolved *sounding* pitch.
 *
 * Ottava is applied exactly once: `note.sounding` is already the sounding pitch, so written C4
 * under 8va is labeled C5. `ottavaShift` is used only to find the written staff position that
 * key-signature and carried accidentals are keyed by (written octave = sounding − shift).
 *
 * - Simplify enharmonics: respell first (B♯4→C5, C♭4→B3, F𝄪4→G4), then convert to fixed do.
 * - Always show effective accidentals ON: name the actual pitch as if read without a key
 *   signature; ♮ appears only where a natural cancels an alteration the context implies.
 * - OFF: omit an accidental that equals what the key and measure context already imply; a
 *   change or cancellation stays visible, including for a respelled name (B♯4 in C♯ major
 *   simplifies to "C♮5", because written C5 is C♯ there).
 *
 * Naming never changes the pitch, MIDI matching, or label eligibility.
 */
export function labelFor(note: LabelableNote, naming: NamingSettings): NoteLabel {
  const original = normalizeSpelling(note.sounding)
  const shown = naming.simplifyEnharmonics ? simplifySpelling(original) : original
  const writtenOctave = (octave: number) => octave - note.ottavaShift
  const implied = (s: Spelling) => contextAlter(note.accidentalContext, s.step, writtenOctave(s.octave))

  let accidental: string
  if (naming.alwaysShowEffectiveAccidentals) {
    if (shown.alter !== 0) accidental = accidentalGlyph(shown.alter)
    else accidental = original.alter === 0 && implied(original) !== 0 ? NATURAL : ''
  } else if (shown.alter === implied(shown)) {
    accidental = ''
  } else {
    accidental = shown.alter === 0 ? NATURAL : accidentalGlyph(shown.alter)
  }
  return build(stepName(shown.step, naming), accidental, naming.showOctave ? shown.octave : null)
}

/** `labelFor(note, naming).text`. */
export function labelText(note: LabelableNote, naming: NamingSettings): string {
  return labelFor(note, naming).text
}

const NO_CONTEXT: AccidentalContext = { keyFifths: 0, carried: [] }

/**
 * Label for a bare piano key with no score context (keyboard guide landmarks, tests).
 * Black keys are spelled with sharps unless `prefer` is `'flat'`.
 */
export function labelForMidi(midi: number, naming: NamingSettings, prefer: 'sharp' | 'flat' = 'sharp'): NoteLabel {
  return labelFor({ sounding: spellMidi(midi, prefer), ottavaShift: 0, accidentalContext: NO_CONTEXT }, naming)
}

/**
 * Widest label this naming configuration can produce, in characters, for layout reservation
 * (spec R3: label room is reserved so revealing hints never reflows the music). Counts one
 * accidental glyph always and a one-digit octave (piano octaves 0–8) when octaves are shown.
 */
export function maxLabelWidthChars(naming: NamingSettings): number {
  const steps: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
  const widest = Math.max(...steps.map((s) => visibleLength(stepName(s, naming))))
  return widest + 1 + (naming.showOctave ? 1 : 0)
}
