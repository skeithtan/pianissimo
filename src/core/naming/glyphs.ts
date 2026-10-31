/** Accidental glyphs used in every note label (spec: ♯ ♭ ♮ 𝄪 𝄫). */
export const SHARP = '♯'
export const FLAT = '♭'
export const NATURAL = '♮'
export const DOUBLE_SHARP = '\u{1D12A}'
export const DOUBLE_FLAT = '\u{1D12B}'

/**
 * Glyph for a chromatic alteration in semitones. Zero has no glyph here: whether a natural sign
 * is shown is a context decision made by the label policy, not a property of the alteration.
 */
export function accidentalGlyph(alter: number): string {
  switch (alter) {
    case 1:
      return SHARP
    case -1:
      return FLAT
    case 2:
      return DOUBLE_SHARP
    case -2:
      return DOUBLE_FLAT
    default:
      return ''
  }
}

/** Number of user-visible characters (code points), so 𝄪 counts as one. */
export function visibleLength(text: string): number {
  return Array.from(text).length
}
