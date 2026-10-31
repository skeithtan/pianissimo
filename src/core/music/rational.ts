/**
 * Exact rational arithmetic for musical positions and durations.
 *
 * Unit convention across the app: **whole notes**. A quarter note is 1/4, a dotted
 * quarter 3/8. Values are always normalized (gcd-reduced, positive denominator), so
 * structural equality (`n` and `d`) is value equality.
 */
export interface Rational {
  readonly n: number
  readonly d: number
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

export function rat(n: number, d = 1): Rational {
  if (!Number.isInteger(n) || !Number.isInteger(d)) {
    throw new RangeError(`Rational parts must be integers: ${n}/${d}`)
  }
  if (d === 0) throw new RangeError('Rational denominator is zero')
  if (n === 0) return ZERO
  const g = gcd(n, d)
  const sign = d < 0 ? -1 : 1
  return { n: (sign * n) / g, d: (sign * d) / g }
}

export const ZERO: Rational = Object.freeze({ n: 0, d: 1 })
export const ONE: Rational = Object.freeze({ n: 1, d: 1 })

export const add = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d)
export const sub = (a: Rational, b: Rational): Rational => rat(a.n * b.d - b.n * a.d, a.d * b.d)
export const mul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d)
export const div = (a: Rational, b: Rational): Rational => {
  if (b.n === 0) throw new RangeError('Division by zero rational')
  return rat(a.n * b.d, a.d * b.n)
}

/** Negative if a < b, zero if equal, positive if a > b. */
export const cmp = (a: Rational, b: Rational): number => a.n * b.d - b.n * a.d
export const eq = (a: Rational, b: Rational): boolean => a.n === b.n && a.d === b.d
export const lt = (a: Rational, b: Rational): boolean => cmp(a, b) < 0
export const le = (a: Rational, b: Rational): boolean => cmp(a, b) <= 0
export const gt = (a: Rational, b: Rational): boolean => cmp(a, b) > 0
export const ge = (a: Rational, b: Rational): boolean => cmp(a, b) >= 0
export const min = (a: Rational, b: Rational): Rational => (le(a, b) ? a : b)
export const max = (a: Rational, b: Rational): Rational => (ge(a, b) ? a : b)
export const isZero = (a: Rational): boolean => a.n === 0

export const toNumber = (a: Rational): number => a.n / a.d

/** MusicXML `<duration>` in divisions-per-quarter → whole notes. */
export const fromDivisions = (duration: number, divisionsPerQuarter: number): Rational =>
  rat(duration, divisionsPerQuarter * 4)

/** Stable string key, e.g. for Map lookups: "3/8". */
export const key = (a: Rational): string => `${a.n}/${a.d}`

export const parseKey = (s: string): Rational => {
  const [n, d] = s.split('/').map(Number)
  return rat(n ?? 0, d ?? 1)
}

export const toString = (a: Rational): string => (a.d === 1 ? `${a.n}` : `${a.n}/${a.d}`)
