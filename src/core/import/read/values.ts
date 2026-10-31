/**
 * Small MusicXML value parsers. Durations and divisions are MusicXML decimals; they are read
 * as exact rationals so tuplets and odd `<divisions>` never accumulate floating-point drift.
 */
import { type Rational, add, div, mul, rat } from '../../music/rational'

/** Exact rational for a non-negative decimal string ("3", "1.5", ".25"); undefined if invalid. */
export function decimalRat(s: string | undefined): Rational | undefined {
  if (s === undefined) return undefined
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(s)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return undefined
  const frac = (m[3] ?? '').slice(0, 9)
  const whole = m[2] === '' ? 0 : Number(m[2])
  const scale = 10 ** frac.length
  const n = whole * scale + (frac === '' ? 0 : Number(frac))
  if (!Number.isSafeInteger(n)) return undefined
  return rat(m[1] === '-' ? -n : n, scale)
}

/** MusicXML duration (in divisions per quarter note) → whole notes. */
export function divisionsToWhole(duration: Rational, divisions: Rational): Rational {
  return div(duration, mul(divisions, rat(4)))
}

/** Whole notes → MusicXML duration in the given divisions (may be fractional). */
export function wholeToDivisions(whole: Rational, divisions: Rational): Rational {
  return mul(whole, mul(divisions, rat(4)))
}

const NOTE_TYPES: Readonly<Record<string, Rational>> = {
  maxima: rat(8),
  long: rat(4),
  breve: rat(2),
  whole: rat(1),
  half: rat(1, 2),
  quarter: rat(1, 4),
  eighth: rat(1, 8),
  '16th': rat(1, 16),
  '32nd': rat(1, 32),
  '64th': rat(1, 64),
  '128th': rat(1, 128),
  '256th': rat(1, 256),
  '512th': rat(1, 512),
  '1024th': rat(1, 1024),
}

/** Note-type name ("quarter", "16th") with augmentation dots → whole notes. */
export function noteTypeValue(type: string, dots = 0): Rational | undefined {
  const base = NOTE_TYPES[type.trim()]
  if (!base) return undefined
  let value = base
  let part = base
  for (let i = 0; i < dots; i++) {
    part = mul(part, rat(1, 2))
    value = add(value, part)
  }
  return value
}

/** True when a rational's denominator is a power of two (an ordinary, non-tuplet value). */
export function isDyadic(r: Rational): boolean {
  let d = r.d
  while (d % 2 === 0) d /= 2
  return d === 1
}

export function clampVelocity(v: number): number {
  return Math.max(1, Math.min(127, Math.round(v)))
}
