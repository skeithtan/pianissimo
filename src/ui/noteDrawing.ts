/**
 * A piece drawn from its own notes (DECISIONS U154): time across, pitch up, the two hands apart.
 * The score screen's overview draws the whole piece, a Library row its opening bars. Geometry only:
 * each hand is one SVG path, so a long piece stays two elements.
 */
import type { ScoreModel } from '../core/model/score'
import { toNumber } from '../core/music/rational'
import { progressAt, totalLength, type OverviewMeasure } from './overviewMath'

/** One sounded note: its span as fractions of the drawing's width. */
export interface DrawnNote {
  readonly from: number
  readonly to: number
  readonly midi: number
  readonly left: boolean
}

type DrawnModel = Pick<ScoreModel, 'notes'>

/** The notes a drawing shows: every attack, with its tied length. Cue notes are not played. */
function attacks(model: DrawnModel): ScoreModel['notes'] {
  return model.notes.filter((n) => !n.tieContinuation && !n.cue)
}

/** Every note of the piece on the overview's own time scale. */
export function overviewNotes(model: DrawnModel, measures: readonly OverviewMeasure[]): DrawnNote[] {
  return attacks(model).map((n) => {
    const start = toNumber(n.onset)
    return {
      from: progressAt(measures, start),
      to: progressAt(measures, start + toNumber(n.soundingDuration)),
      midi: n.midi,
      left: n.hand === 'L',
    }
  })
}

/** The shortest a note is drawn on the overview: a sixteenth, within 1.4 px. */
export function shortestNote(measures: readonly OverviewMeasure[], width: number): number {
  const total = totalLength(measures)
  return total > 0 ? Math.max(1.4, width / total / 16) : 1.4
}

export interface NotePaths {
  readonly right: string
  readonly left: string
}

export interface NotePathOptions {
  readonly width: number
  readonly height: number
  /** The thickest a note gets; a wide range draws thinner, so close notes stay apart. */
  readonly thickness: number
  /** The shortest a note is drawn (px). */
  readonly shortest: number
}

const MIN_THICKNESS = 2.2
/** A range of an octave at least, so a narrow melody is not stretched over the whole height. */
const MIN_RANGE = 12
/** Between a note and the next one at the same pitch (px). */
const GAP = 0.8

const px = (v: number): string => String(Math.round(v * 10) / 10)

/** Too narrow for round ends to show (px): a long piece draws thousands of these. */
const PLAIN_PX = 2

/** A bar with round ends, standing up where it is shorter than it is thick. */
function bar(x: number, y: number, w: number, t: number): string {
  if (w < PLAIN_PX) return `M${px(x)} ${px(y)}h${px(w)}v${px(t)}h${px(-w)}z`
  const r = px(Math.min(w, t) / 2)
  if (w < t) {
    const run = px(t - w)
    return `M${px(x)} ${px(y + w / 2)}a${r} ${r} 0 0 1 ${px(w)} 0v${run}a${r} ${r} 0 0 1 ${px(-w)} 0z`
  }
  const run = w - t
  return `M${px(x + t / 2)} ${px(y)}h${px(run)}a${r} ${r} 0 0 1 0 ${px(t)}h${px(-run)}a${r} ${r} 0 0 1 0 ${px(-t)}z`
}

/** One path per hand, in px of a `width` × `height` box. */
export function notePaths(notes: readonly DrawnNote[], o: NotePathOptions): NotePaths {
  const paths = { right: '', left: '' }
  if (notes.length === 0 || !(o.width > 0)) return paths
  let low = Infinity
  let high = -Infinity
  for (const n of notes) {
    low = Math.min(low, n.midi)
    high = Math.max(high, n.midi)
  }
  high = Math.max(high, low + MIN_RANGE)
  const step = (o.height - o.thickness) / (high - low)
  const t = Math.max(Math.min(o.thickness, MIN_THICKNESS), Math.min(o.thickness, 2.7 * step))
  const shortest = Math.min(t, o.shortest)
  for (const n of notes) {
    const x = n.from * o.width
    const w = Math.min(Math.max(shortest, n.to * o.width - x - GAP), o.width - x)
    if (!(w > 0)) continue
    const y = ((high - n.midi) / (high - low)) * (o.height - t)
    paths[n.left ? 'left' : 'right'] += bar(x, y, w, t)
  }
  return paths
}

/**
 * The opening of a piece, small enough to keep beside its Library entry: bar lengths and notes in
 * 192nds of a whole note. A row shows as many of its bars as it has room for (`openingNotes`).
 */
export interface Opening {
  /** Where each bar ends. */
  readonly bars: readonly number[]
  /** Four numbers per note: onset, length, MIDI pitch, and 1 for the left hand. */
  readonly notes: readonly number[]
}

const UNIT = 192
const OPENING_BARS = 14
const OPENING_NOTES = 84

/** The opening bars, up to 14 bars or about 84 notes, one bar at least. */
export function openingOf(model: Pick<ScoreModel, 'notes' | 'occurrences'>): Opening {
  const sounded = attacks(model)
  const bars: number[] = []
  for (const o of model.occurrences.slice(0, OPENING_BARS)) {
    const end = toNumber(o.start) + toNumber(o.duration)
    if (bars.length > 0 && sounded.filter((n) => toNumber(n.onset) < end).length > OPENING_NOTES) break
    bars.push(Math.round(end * UNIT))
  }
  const last = bars.at(-1) ?? 0
  const notes: number[] = []
  for (const n of sounded) {
    const at = Math.round(toNumber(n.onset) * UNIT)
    if (at < last && notes.length < 4 * 4 * OPENING_NOTES)
      notes.push(at, Math.round(toNumber(n.soundingDuration) * UNIT), n.midi, n.hand === 'L' ? 1 : 0)
  }
  return { bars, notes }
}

/** The opening's notes over as many whole bars as `limit` notes allow (one bar at least). */
export function openingNotes(opening: Opening, limit: number): DrawnNote[] {
  const count = opening.notes.length / 4
  const before = (end: number): number => {
    let n = 0
    for (let i = 0; i < count; i++) if (opening.notes[4 * i]! < end) n++
    return n
  }
  let end = opening.bars[0] ?? 0
  for (const bar of opening.bars) if (bar > end && before(bar) <= limit) end = bar
  if (end <= 0) return []
  const drawn: DrawnNote[] = []
  for (let i = 0; i < count; i++) {
    const [at, length, midi, left] = opening.notes.slice(4 * i, 4 * i + 4) as [number, number, number, number]
    if (at < end) drawn.push({ from: at / end, to: Math.min(1, (at + length) / end), midi, left: left === 1 })
  }
  return drawn
}
