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

function gcdBig(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b !== 0n) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

function ratBig(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new RangeError('Rational denominator is zero')
  if (n === 0n) return ZERO
  const g = gcdBig(n, d)
  const sign = d < 0n ? -1n : 1n
  return rat(Number((sign * n) / g), Number((sign * d) / g))
}

export function rat(n: number, d = 1): Rational {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) {
    throw new RangeError(`Rational parts must be safe integers: ${n}/${d}`)
  }
  if (d === 0) throw new RangeError('Rational denominator is zero')
  if (n === 0) return ZERO
  const g = gcd(n, d)
  const sign = d < 0 ? -1 : 1
  return { n: (sign * n) / g, d: (sign * d) / g }
}

export const ZERO: Rational = Object.freeze({ n: 0, d: 1 })
export const ONE: Rational = Object.freeze({ n: 1, d: 1 })

export function add(a: Rational, b: Rational): Rational {
  const g = gcd(a.d, b.d)
  const ad = a.d / g
  const bd = b.d / g
  const p1 = a.n * bd
  const p2 = b.n * ad
  const num = p1 + p2
  const den = ad * b.d
  if (Number.isSafeInteger(p1) && Number.isSafeInteger(p2) && Number.isSafeInteger(num) && Number.isSafeInteger(den)) {
    return rat(num, den)
  }
  return ratBig(BigInt(a.n) * BigInt(bd) + BigInt(b.n) * BigInt(ad), BigInt(ad) * BigInt(b.d))
}

export function sub(a: Rational, b: Rational): Rational {
  const g = gcd(a.d, b.d)
  const ad = a.d / g
  const bd = b.d / g
  const p1 = a.n * bd
  const p2 = b.n * ad
  const num = p1 - p2
  const den = ad * b.d
  if (Number.isSafeInteger(p1) && Number.isSafeInteger(p2) && Number.isSafeInteger(num) && Number.isSafeInteger(den)) {
    return rat(num, den)
  }
  return ratBig(BigInt(a.n) * BigInt(bd) - BigInt(b.n) * BigInt(ad), BigInt(ad) * BigInt(b.d))
}

export function mul(a: Rational, b: Rational): Rational {
  const g1 = gcd(a.n, b.d)
  const g2 = gcd(b.n, a.d)
  const an = a.n / g1
  const bn = b.n / g2
  const ad = a.d / g2
  const bd = b.d / g1
  const num = an * bn
  const den = ad * bd
  if (Number.isSafeInteger(num) && Number.isSafeInteger(den)) return rat(num, den)
  return ratBig(BigInt(an) * BigInt(bn), BigInt(ad) * BigInt(bd))
}

export function div(a: Rational, b: Rational): Rational {
  if (b.n === 0) throw new RangeError('Division by zero rational')
  const g1 = gcd(a.n, b.n)
  const g2 = gcd(b.d, a.d)
  const an = a.n / g1
  const bd = b.d / g2
  const ad = a.d / g2
  const bn = b.n / g1
  const num = an * bd
  const den = ad * bn
  if (Number.isSafeInteger(num) && Number.isSafeInteger(den)) return rat(num, den)
  return ratBig(BigInt(an) * BigInt(bd), BigInt(ad) * BigInt(bn))
}

/** Negative if a < b, zero if equal, positive if a > b. */
export function cmp(a: Rational, b: Rational): number {
  if (a.d === b.d) return a.n - b.n
  const g = gcd(a.d, b.d)
  const left = a.n * (b.d / g)
  const right = b.n * (a.d / g)
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right
  const diff = BigInt(a.n) * BigInt(b.d / g) - BigInt(b.n) * BigInt(a.d / g)
  return diff < 0n ? -1 : diff > 0n ? 1 : 0
}
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
