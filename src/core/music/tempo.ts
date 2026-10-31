/**
 * Tempo map in performance positions (whole notes).
 *
 * Spec formula per constant-tempo segment:
 *   seconds = 60 × length(whole notes) ÷ (BPM × beatUnit(whole notes))
 * which equals 240 × length ÷ quarterBpm. A dotted-quarter beat is 3/8, not 1/4.
 * A speed multiplier scales the whole map (relative tempo changes preserved).
 */
import { type Rational, ZERO, cmp, sub, toNumber, rat } from './rational'

export interface TempoSegment {
  /** Performance position where this tempo begins. */
  readonly start: Rational
  /** Quarter notes per minute (MusicXML `sound/@tempo` semantics). */
  readonly quarterBpm: number
  /** Displayed beat unit in whole notes (quarter = 1/4, dotted quarter = 3/8). */
  readonly beatUnit: Rational
  /** Displayed beats per minute for `beatUnit`. */
  readonly beatBpm: number
  readonly source: 'sound' | 'metronome' | 'both' | 'user'
}

export interface TempoMapData {
  /** Sorted by start; first segment starts at 0 when non-empty. Empty = no numerical tempo. */
  readonly segments: readonly TempoSegment[]
}

export const QUARTER: Rational = rat(1, 4)

export function quarterBpmFromBeat(beatBpm: number, beatUnit: Rational): number {
  return beatBpm * (toNumber(beatUnit) / 0.25)
}

export function beatBpmFromQuarter(quarterBpm: number, beatUnit: Rational): number {
  return quarterBpm / (toNumber(beatUnit) / 0.25)
}

export function isValidMultiplier(m: number): boolean {
  return Number.isFinite(m) && m > 0
}

export function hasTempo(map: TempoMapData): boolean {
  return map.segments.length > 0
}

function segmentIndexAt(map: TempoMapData, pos: Rational): number {
  const segs = map.segments
  let lo = 0
  let hi = segs.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segs[mid]!
    if (cmp(s.start, pos) <= 0) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

export function segmentAt(map: TempoMapData, pos: Rational): TempoSegment {
  const seg = map.segments[segmentIndexAt(map, pos)]
  if (!seg) throw new Error('Tempo map is empty: a practice tempo is required')
  return seg
}

/** Seconds from performance position 0 to `pos` at the given speed multiplier. */
export function secondsAt(map: TempoMapData, pos: Rational, multiplier = 1): number {
  return secondsBetween(map, ZERO, pos, multiplier)
}

/** Seconds between two performance positions (a ≤ b) at the given multiplier. */
export function secondsBetween(map: TempoMapData, a: Rational, b: Rational, multiplier = 1): number {
  if (!isValidMultiplier(multiplier)) throw new RangeError(`Invalid speed multiplier ${multiplier}`)
  if (cmp(b, a) < 0) return -secondsBetween(map, b, a, multiplier)
  const segs = map.segments
  if (segs.length === 0) throw new Error('Tempo map is empty: a practice tempo is required')
  let total = 0
  let i = segmentIndexAt(map, a)
  let cursor = a
  while (cmp(cursor, b) < 0) {
    const seg = segs[i]!
    const next = segs[i + 1]
    const segEnd = next && cmp(next.start, b) < 0 ? next.start : b
    const len = toNumber(sub(segEnd, cursor))
    total += (240 * len) / seg.quarterBpm
    cursor = segEnd
    i++
  }
  return total / multiplier
}

/**
 * Float performance position (whole notes) reached `sec` seconds after position 0.
 * Used for cursor animation; scheduling uses exact positions converted with `secondsAt`.
 */
export function positionAtSeconds(map: TempoMapData, sec: number, multiplier = 1): number {
  const segs = map.segments
  if (segs.length === 0) throw new Error('Tempo map is empty: a practice tempo is required')
  let remaining = sec * multiplier
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    const next = segs[i + 1]
    const startW = toNumber(seg.start)
    const wholesPerSec = seg.quarterBpm / 240
    if (!next) return startW + remaining * wholesPerSec
    const segSec = (240 * (toNumber(next.start) - startW)) / seg.quarterBpm
    if (remaining <= segSec) return startW + remaining * wholesPerSec
    remaining -= segSec
  }
  return 0
}

/** Effective displayed tempo at a position under a multiplier. */
export function effectiveTempoAt(
  map: TempoMapData,
  pos: Rational,
  multiplier = 1,
): { beatBpm: number; beatUnit: Rational; quarterBpm: number } {
  const seg = segmentAt(map, pos)
  return {
    beatBpm: seg.beatBpm * multiplier,
    beatUnit: seg.beatUnit,
    quarterBpm: seg.quarterBpm * multiplier,
  }
}

/** Multiplier that makes the displayed BPM at `pos` equal `targetBeatBpm` (BPM entry). */
export function multiplierForBpm(map: TempoMapData, pos: Rational, targetBeatBpm: number): number {
  const seg = segmentAt(map, pos)
  return targetBeatBpm / seg.beatBpm
}

/** A single-segment map for a user-supplied practice tempo (no numerical tempo in source). */
export function userTempoMap(beatBpm: number, beatUnit: Rational = QUARTER): TempoMapData {
  return {
    segments: [{ start: ZERO, quarterBpm: quarterBpmFromBeat(beatBpm, beatUnit), beatUnit, beatBpm, source: 'user' }],
  }
}

/** Stable identity of a tempo map for comparison contexts. */
export function tempoMapId(map: TempoMapData): string {
  return map.segments.map((s) => `${s.start.n}/${s.start.d}@${s.quarterBpm}`).join('|')
}

const BEAT_UNIT_NAMES: Record<string, string> = {
  '1/1': 'whole',
  '1/2': 'half',
  '3/4': 'dotted half',
  '1/4': 'quarter',
  '3/8': 'dotted quarter',
  '1/8': 'eighth',
  '3/16': 'dotted eighth',
  '1/16': 'sixteenth',
}

const BEAT_UNIT_GLYPHS: Record<string, string> = {
  '1/1': '𝅝',
  '1/2': '𝅗𝅥',
  '3/4': '𝅗𝅥.',
  '1/4': '♩',
  '3/8': '♩.',
  '1/8': '♪',
  '3/16': '♪.',
  '1/16': '𝅘𝅥𝅯',
}

export function beatUnitName(unit: Rational): string {
  return BEAT_UNIT_NAMES[`${unit.n}/${unit.d}`] ?? `${unit.n}/${unit.d} note`
}

export function beatUnitGlyph(unit: Rational): string {
  return BEAT_UNIT_GLYPHS[`${unit.n}/${unit.d}`] ?? `${unit.n}/${unit.d}`
}
