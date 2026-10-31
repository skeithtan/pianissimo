/**
 * Helpers over the `PassageRange` contract (spec "Repeating passages"; DECISIONS U19, U21–U23).
 *
 * A passage is a run of measure occurrences (`fromOcc`…`toOcc`, both included). Its optional
 * exact edges make it a note-level loop: `start` (a note onset inside `fromOcc`) and `end` (an
 * exclusive position inside `toOcc`: the next onset after the loop's last note). A missing edge is
 * the barline, so whole-bar passages — every record stored before note-level loops — keep their
 * meaning and their comparison keys. `normalizePassage` keeps edges only strictly inside a bar.
 *
 * Pure and worker-safe: exact rationals, no DOM.
 */
import { type Rational, ZERO, add, cmp, div, eq, gt, isZero, key, lt, rat, sub } from '../music/rational'
import { isWholeBars, passageKey, type PassageRange } from './practice'

// The two contract-level helpers live beside the contract (practice.ts keeps the initial shell
// free of the rest of this module); re-exported so passage users find everything here.
export { isWholeBars, passageKey }
import type { Hand, HandSelection, MeterEvent, ScoreModel } from './score'

/** Exact performance bounds of a passage: `[start, end)` in whole notes. */
export interface PassageBounds {
  readonly start: Rational
  readonly end: Rational
}

type Bars = Pick<ScoreModel, 'occurrences' | 'totalDuration'>

const isRational = (v: unknown): v is Rational =>
  typeof v === 'object' &&
  v !== null &&
  Number.isInteger((v as Rational).n) &&
  Number.isInteger((v as Rational).d) &&
  (v as Rational).d > 0

function occEnd(model: Bars, occ: number): Rational {
  const o = model.occurrences[occ]
  return o ? add(o.start, o.duration) : model.totalDuration
}

/** Occurrence containing `pos` (start ≤ pos < end), clamped to the first and last bar. */
export function occurrenceAt(model: Pick<ScoreModel, 'occurrences'>, pos: Rational): number {
  const occs = model.occurrences
  let lo = 0
  let hi = occs.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cmp(occs[mid]!.start, pos) <= 0) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Occurrence holding the instant just before `pos` (an exclusive end on a barline is the bar before). */
function occurrenceBefore(model: Pick<ScoreModel, 'occurrences'>, pos: Rational): number {
  const i = occurrenceAt(model, pos)
  const o = model.occurrences[i]
  return o && i > 0 && cmp(o.start, pos) >= 0 ? i - 1 : i
}

/**
 * Exact `[start, end)` of a passage; null = the whole piece. Throws a RangeError for bars outside
 * the piece or inverted edges (callers normalize user input first).
 */
export function passageBounds(model: Bars, p: PassageRange | null): PassageBounds {
  if (p === null) return { start: ZERO, end: model.totalDuration }
  const first = model.occurrences[p.fromOcc]
  const last = model.occurrences[p.toOcc]
  if (!first || !last || p.fromOcc > p.toOcc) {
    throw new RangeError(`Invalid passage ${p.fromOcc}–${p.toOcc} (score has ${model.occurrences.length} bars)`)
  }
  const start = p.start ?? first.start
  const end = p.end ?? add(last.start, last.duration)
  if (!lt(start, end)) throw new RangeError(`Invalid passage edges ${key(start)}–${key(end)}`)
  return { start, end }
}

/**
 * The passage for exact bounds `[start, end)`: bars from the positions, exact edges kept only
 * inside a bar. Null when the bounds are empty or the piece has no bars.
 */
export function passageFromBounds(model: Bars, start: Rational, end: Rational): PassageRange | null {
  if (model.occurrences.length === 0) return null
  const s = lt(start, ZERO) ? ZERO : start
  const e = gt(end, model.totalDuration) ? model.totalDuration : end
  if (!lt(s, e)) return null
  const fromOcc = occurrenceAt(model, s)
  const toOcc = occurrenceBefore(model, e)
  const first = model.occurrences[fromOcc]!
  return {
    fromOcc,
    toOcc,
    ...(eq(s, first.start) ? {} : { start: s }),
    ...(eq(e, occEnd(model, toOcc)) ? {} : { end: e }),
  }
}

/**
 * A usable passage from any input (stored records, presets, UI edits): bars clamped to the piece
 * and ordered; exact edges must be valid rationals inside the bars, else they are dropped (the
 * whole boundary bar); edges on a barline are omitted. Null for no passage or an empty piece.
 */
export function normalizePassage(model: Bars, p: PassageRange | null | undefined): PassageRange | null {
  if (!p) return null
  const last = model.occurrences.length - 1
  if (last < 0) return null
  const clamp = (v: number): number => Math.max(0, Math.min(last, Number.isFinite(v) ? Math.trunc(v) : 0))
  const a = clamp(p.fromOcc)
  const b = clamp(p.toOcc)
  const fromOcc = Math.min(a, b)
  const toOcc = Math.max(a, b)
  const barStart = model.occurrences[fromOcc]!.start
  const barEnd = occEnd(model, toOcc)
  const start = isRational(p.start) && gt(p.start, barStart) && lt(p.start, occEnd(model, fromOcc)) ? p.start : null
  const end =
    isRational(p.end) && lt(p.end, barEnd) && gt(p.end, model.occurrences[toOcc]!.start) ? rat(p.end.n, p.end.d) : null
  const s = start ? rat(start.n, start.d) : barStart
  const e = end ?? barEnd
  if (!lt(s, e)) return { fromOcc, toOcc }
  return passageFromBounds(model, s, e)
}

/** Same bars and same exact edges. */
export function samePassage(a: PassageRange | null, b: PassageRange | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const sameEdge = (x: Rational | undefined, y: Rational | undefined): boolean =>
    x === y || (x !== undefined && y !== undefined && eq(x, y))
  return a.fromOcc === b.fromOcc && a.toOcc === b.toOcc && sameEdge(a.start, b.start) && sameEdge(a.end, b.end)
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────

const VULGAR: Readonly<Record<string, string>> = {
  '1/2': '½',
  '1/3': '⅓',
  '2/3': '⅔',
  '1/4': '¼',
  '3/4': '¾',
  '1/8': '⅛',
  '3/8': '⅜',
  '5/8': '⅝',
  '7/8': '⅞',
}

function meterAt(meters: readonly MeterEvent[], pos: Rational): MeterEvent | undefined {
  let found: MeterEvent | undefined
  for (const m of meters) {
    if (cmp(m.at, pos) <= 0) found = m
    else break
  }
  return found
}

/** The counted beat of a meter: the dotted beat in compound meters (6/8 → ♩.), else 1/beatType. */
function meterBeat(m: MeterEvent | undefined): Rational {
  if (!m) return rat(1, 4)
  const compound = m.beats > 3 && m.beats % 3 === 0 && m.beatType >= 8
  return compound ? rat(3, m.beatType) : rat(1, m.beatType)
}

type Words = Pick<ScoreModel, 'occurrences' | 'meters' | 'sourceMeasures'>

/** Printed bar label for an occurrence: "12" or "12 (pass 2)". */
function barText(model: Pick<ScoreModel, 'occurrences'>, occ: number): string {
  const o = model.occurrences[occ]
  if (!o) return `${occ + 1}`
  return o.pass > 1 ? `${o.number} (pass ${o.pass})` : o.number
}

/**
 * The beat a position falls on within its bar, counted from 1 in the meter's beat ("3", "2½",
 * "1.38" for odd subdivisions). A pickup counts from where its notes sit in a full bar.
 */
export function beatText(model: Words, pos: Rational): string {
  const occ = occurrenceAt(model, pos)
  const o = model.occurrences[occ]
  if (!o) return '1'
  const src = model.sourceMeasures[o.sourceMeasure]
  const missing = src?.implicit ? sub(src.nominalDuration, o.duration) : ZERO
  const offset = add(sub(pos, o.start), gt(missing, ZERO) ? missing : ZERO)
  const beats = add(div(offset, meterBeat(meterAt(model.meters, o.start))), rat(1))
  const whole = Math.floor(beats.n / beats.d)
  const frac = sub(beats, rat(whole))
  if (isZero(frac)) return String(whole)
  const glyph = VULGAR[key(frac)]
  if (glyph) return `${whole}${glyph}`
  return String(Math.round((beats.n / beats.d) * 100) / 100)
}

/** "Bar 12, beat 3" (always with the beat): the strip's drag readout. */
export function positionText(model: Words, pos: Rational): string {
  return `Bar ${barText(model, occurrenceAt(model, pos))}, beat ${beatText(model, pos)}`
}

function handsOf(h: HandSelection): readonly Hand[] {
  return h === 'right' ? ['R'] : h === 'left' ? ['L'] : ['R', 'L']
}

/**
 * Sorted distinct onset positions where the hands attack a written note (grace notes and tie
 * continuations excluded): the notes a loop edge or the dragged playhead snaps to (U19).
 * 'none' (Listen) and 'both' take both hands.
 */
export function onsetPositions(model: Pick<ScoreModel, 'notes'>, hands: HandSelection): Rational[] {
  const allowed = handsOf(hands)
  const seen = new Map<string, Rational>()
  for (const n of model.notes) {
    if (n.grace || n.cue || n.tieContinuation || !allowed.includes(n.hand)) continue
    const k = key(n.onset)
    if (!seen.has(k)) seen.set(k, n.onset)
  }
  return [...seen.values()].sort(cmp)
}

/** Last attack of the hands in `[start, end)` (the loop's last note); `start` when there is none. */
export function lastOnsetIn(
  model: Pick<ScoreModel, 'notes'>,
  hands: HandSelection,
  start: Rational,
  end: Rational,
): Rational {
  const allowed = handsOf(hands)
  let last = start
  for (const n of model.notes) {
    if (n.grace || n.cue || n.tieContinuation || !allowed.includes(n.hand)) continue
    if (cmp(n.onset, last) > 0 && lt(n.onset, end)) last = n.onset
  }
  return last
}

/** What describing a passage reads from a score model (the Results view keeps just this). */
export type PassageWords = Words & Pick<ScoreModel, 'notes' | 'totalDuration'>

/**
 * One edge of a loop in words, for the Repeat panel: the start is the bar ("Bar 12") or its first
 * note ("Bar 12, beat 3"); the end is the bar ("Bar 14", through its end) or the loop's last note
 * ("Bar 14, beat 2").
 */
export function edgeText(model: PassageWords, p: PassageRange, edge: 'start' | 'end', hands: HandSelection): string {
  if (edge === 'start') {
    const bar = `Bar ${barText(model, p.fromOcc)}`
    return p.start ? `${bar}, beat ${beatText(model, p.start)}` : bar
  }
  const bar = `Bar ${barText(model, p.toOcc)}`
  if (!p.end) return bar
  const { start, end } = passageBounds(model, p)
  return `${bar}, beat ${beatText(model, lastOnsetIn(model, hands, start, end))}`
}

/**
 * A passage in words, capitalized: "Bar 12", "Bars 12–14" for whole bars (as before);
 * "Bar 12, beat 3 – bar 14", "Bar 12 – bar 14, beat 2" or "Bar 12, beats 2–3" for note-level
 * loops (the end names the loop's last note, U22). `hands` decides which notes are counted.
 */
export function describePassage(model: PassageWords, p: PassageRange | null, hands: HandSelection = 'both'): string {
  if (!p) return 'Whole piece'
  const from = barText(model, p.fromOcc)
  if (isWholeBars(p)) return p.fromOcc === p.toOcc ? `Bar ${from}` : `Bars ${from}–${barText(model, p.toOcc)}`
  if (p.fromOcc === p.toOcc) {
    const { start, end } = passageBounds(model, p)
    const a = beatText(model, start)
    const b = beatText(model, lastOnsetIn(model, hands, start, end))
    return a === b ? `Bar ${from}, beat ${a}` : `Bar ${from}, beats ${a}–${b}`
  }
  const first = edgeText(model, p, 'start', hands)
  const lastText = edgeText(model, p, 'end', hands)
  return `${first} – ${lastText.charAt(0).toLowerCase()}${lastText.slice(1)}`
}

/** Validation: a stored edge is absent or a usable rational. */
export function validEdge(v: unknown): boolean {
  return v === undefined || isRational(v)
}
