import type { Spelling, Step } from '../music/pitch'
import { spellingToMidi } from '../music/pitch'
import { accidentalGlyph } from './glyphs'

export type ParseSpellingResult =
  { readonly ok: true; readonly spelling: Spelling } | { readonly ok: false; readonly error: string }

const SOLFEGE_STEP: Readonly<Record<string, Step>> = {
  do: 'C',
  re: 'D',
  mi: 'E',
  fa: 'F',
  sol: 'G',
  la: 'A',
  si: 'B',
  ti: 'B',
}

const ACCIDENTAL_ALTER: Readonly<Record<string, number>> = {
  '#': 1,
  '♯': 1,
  b: -1,
  '♭': -1,
  x: 2,
  '×': 2,
  '\u{1D12A}': 2,
  '\u{1D12B}': -2,
  '♮': 0,
}

const FORMAT_HINT = 'Write a note name, an optional ♯ or ♭, then the octave, for example C4, F♯3 or Bb5.'
const MIDI_LOW = 0
const MIDI_HIGH = 127

function fail(error: string): ParseSpellingResult {
  return { ok: false, error }
}

function parseAlter(marks: readonly string[]): number | string {
  if (marks.length === 0) return 0
  const natural = marks.filter((m) => m === '♮').length
  if (natural > 0) return marks.length === 1 ? 0 : 'A natural sign cannot be combined with other accidentals.'
  const values = marks.map((m) => ACCIDENTAL_ALTER[m] ?? 0)
  const sharp = values.some((v) => v > 0)
  const flat = values.some((v) => v < 0)
  if (sharp && flat) return 'Use sharps or flats, not both.'
  const total = values.reduce((sum, v) => sum + v, 0)
  if (Math.abs(total) > 2) return 'At most two sharps or two flats are supported (𝄪 or 𝄫).'
  return total
}

/**
 * Parse a threshold pitch typed by the user: letter or fixed-do name, optional accidentals,
 * and a required octave (middle C = C4). Accepts "C#4", "C♯4", "Bb3", "B♭3", "Cx4", "C##4",
 * "C𝄪4", "Ebb4", "E𝄫4", "B♮3", "do#4", "sol4", "ti3", in any letter case. The octave is
 * required because a threshold must be unambiguous even when octave labels are hidden.
 */
export function parseSpelling(text: string): ParseSpellingResult {
  const input = text.replace(/\s+/gu, '').replace(/−/gu, '-').toLowerCase()
  if (input === '') return fail('Enter a pitch such as C4 or B♭3.')

  const match = /^(do|re|mi|fa|sol|la|si|ti|[a-g])([^\d-]*)(-?\d+)?$/u.exec(input)
  if (!match) {
    const first = Array.from(input)[0] ?? ''
    return /[a-z]/u.test(first)
      ? fail(`"${text.trim()}" is not a note name. Use C D E F G A B (or do re mi fa sol la si/ti). ${FORMAT_HINT}`)
      : fail(`Could not read "${text.trim()}". ${FORMAT_HINT}`)
  }
  const [, name = '', accidentals = '', octaveText] = match
  const step = SOLFEGE_STEP[name] ?? (name.toUpperCase() as Step)

  const marks = Array.from(accidentals)
  const unknown = marks.find((m) => !(m in ACCIDENTAL_ALTER))
  if (unknown !== undefined) return fail(`"${unknown}" is not an accidental. Use ♯ (#), ♭ (b), 𝄪 (x), 𝄫 (bb) or ♮.`)
  const alter = parseAlter(marks)
  if (typeof alter === 'string') return fail(alter)

  if (octaveText === undefined) return fail(`Add the octave number, for example ${step}4. Middle C is C4.`)
  const spelling: Spelling = { step, alter, octave: Number.parseInt(octaveText, 10) }
  const midi = spellingToMidi(spelling)
  if (midi < MIDI_LOW || midi > MIDI_HIGH) {
    return fail(`${formatSpelling(spelling)} is outside the MIDI range (C-1 to G9).`)
  }
  return { ok: true, spelling }
}

/** Letter-name text for a spelling, always with its octave: "C♯5", "B♭3", "E𝄫4". */
export function formatSpelling(s: Spelling): string {
  return `${s.step}${accidentalGlyph(s.alter)}${s.octave}`
}
