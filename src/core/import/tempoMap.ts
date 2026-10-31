/**
 * Tempo map from MusicXML (spec "MusicXML score import", "Results and timing"):
 *  - `<sound tempo>` is quarter notes per minute; a `<metronome>` mark has its own beat unit,
 *    possibly dotted (dotted quarter = 3/8). Both normalize to one map of quarter BPM segments
 *    that keep the displayed beat unit and BPM.
 *  - When a sound tempo and a metronome mark at the same position disagree, the conflict is
 *    reported and the metronome mark (what the reader sees, with its explicit beat unit) is used.
 *  - No numerical tempo anywhere → an empty map and a "tempo-missing" diagnostic; the user must
 *    supply a practice tempo (`withUserTempo`).
 *  - Tempo context is positional in the written score (see `positions.ts`): after a repeat jump
 *    the tempo is the one stated at or before the jump target.
 */
import { type Rational, ZERO, add, cmp, isZero, key, rat } from '../music/rational'
import {
  QUARTER,
  type TempoMapData,
  type TempoSegment,
  beatBpmFromQuarter,
  beatUnitGlyph,
  quarterBpmFromBeat,
} from '../music/tempo'
import type { MeasureOccurrence, SourceMeasure } from '../model/score'
import type { DiagnosticSink } from './diagnostics'
import { PosIndex, cmpPos } from './positions'
import type { RawTempo, SrcPos } from './read/types'

/** Tolerance (quarter BPM) below which a sound tempo and a metronome mark agree. */
const AGREE_BPM = 0.5

export interface ResolvedTempo extends SrcPos {
  readonly quarterBpm: number
  readonly beatUnit: Rational
  readonly beatBpm: number
  readonly source: TempoSegment['source']
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function markText(beatUnit: Rational, bpm: number): string {
  return `${beatUnitGlyph(beatUnit)} = ${fmt(bpm)}`
}

/** Resolve one tempo statement (one direction or `<sound>`), reporting a sound/metronome mismatch. */
function resolveStatement(
  t: RawTempo,
  lastUnit: Rational,
  measure: string,
  diag: DiagnosticSink,
): ResolvedTempo | undefined {
  const metro = t.metronome
  if (metro) {
    const mq = quarterBpmFromBeat(metro.perMinute, metro.beatUnit)
    let source: TempoSegment['source'] = 'metronome'
    if (t.sound !== undefined) {
      if (Math.abs(t.sound - mq) > AGREE_BPM) {
        diag.warn(
          'tempo-conflict',
          `Bar ${measure}: the metronome mark ${markText(metro.beatUnit, metro.perMinute)} (${fmt(mq)} quarter notes per minute) disagrees with the playback tempo of ${fmt(t.sound)} quarter notes per minute. The metronome mark is used; check the tempo before practicing.`,
          { measure },
        )
      } else {
        source = 'both'
      }
    }
    return { m: t.m, at: t.at, quarterBpm: mq, beatUnit: metro.beatUnit, beatBpm: metro.perMinute, source }
  }
  if (t.sound === undefined) return undefined
  return {
    m: t.m,
    at: t.at,
    quarterBpm: t.sound,
    beatUnit: lastUnit,
    beatBpm: beatBpmFromQuarter(t.sound, lastUnit),
    source: 'sound',
  }
}

/**
 * Resolve all tempo statements (from every part, unselected ones included) by source position.
 * Several statements at one position: the last in document order wins, as in MusicXML playback.
 * Two different *printed* marks there are a conflict (warning); a hidden statement that differs
 * from a printed one is the file's own playback realization (info).
 */
export function resolveTempos(
  raw: readonly RawTempo[],
  measures: readonly SourceMeasure[],
  diag: DiagnosticSink,
): ResolvedTempo[] {
  const byPos = new Map<string, RawTempo[]>()
  const order: RawTempo[][] = []
  for (const t of [...raw].sort(cmpPos)) {
    const k = `${t.m}|${key(t.at)}`
    let list = byPos.get(k)
    if (!list) {
      byPos.set(k, (list = []))
      order.push(list)
    }
    list.push(t)
  }
  const out: ResolvedTempo[] = []
  let lastUnit: Rational = QUARTER
  for (const list of order) {
    const first = list[0]!
    const measure = measures[first.m]?.number ?? String(first.m + 1)
    const statements: { t: RawTempo; r: ResolvedTempo }[] = []
    for (const t of list) {
      const r = resolveStatement(t, lastUnit, measure, diag)
      if (r) statements.push({ t, r })
    }
    const winner = statements[statements.length - 1]
    if (!winner) continue
    const differing = statements.filter((s) => Math.abs(s.r.quarterBpm - winner.r.quarterBpm) > AGREE_BPM)
    if (differing.length > 0) {
      const printed = (s: { t: RawTempo }) => s.t.metronome?.printed === true
      const shown = differing.find(printed) ?? differing[0]!
      const a = markText(shown.r.beatUnit, shown.r.beatBpm)
      const b = markText(winner.r.beatUnit, winner.r.beatBpm)
      if (printed(shown) && printed(winner)) {
        diag.warn(
          'tempo-conflict',
          `Bar ${measure} has two different tempo marks at one point (${a} and ${b}); ${b} is used.`,
          { measure },
        )
      } else {
        diag.info(
          'tempo-realized',
          `Bar ${measure}: the score shows ${a} but its playback tempo there is ${b}; ${b} is used.`,
          { measure },
        )
      }
    }
    if (winner.t.metronome) lastUnit = winner.t.metronome.beatUnit
    out.push(winner.r)
  }
  return out
}

function sameTempo(a: TempoSegment, b: Omit<TempoSegment, 'start'>): boolean {
  return (
    Math.abs(a.quarterBpm - b.quarterBpm) < 1e-9 &&
    cmp(a.beatUnit, b.beatUnit) === 0 &&
    Math.abs(a.beatBpm - b.beatBpm) < 1e-9
  )
}

/** Performance-order tempo map (see module doc). */
export function buildTempoMap(
  resolved: readonly ResolvedTempo[],
  occurrences: readonly MeasureOccurrence[],
  measures: readonly SourceMeasure[],
  diag: DiagnosticSink,
): TempoMapData {
  if (resolved.length === 0) {
    diag.warn('tempo-missing', 'The score has no numerical tempo. Choose a practice tempo before timing or playback.')
    return { segments: [] }
  }
  const index = new PosIndex(resolved)
  const firstTempo = index.first!
  if (firstTempo.m !== 0 || !isZero(firstTempo.at)) {
    const bar = measures[firstTempo.m]?.number ?? String(firstTempo.m + 1)
    diag.info(
      'tempo-late-start',
      `The first numerical tempo appears in bar ${bar}; it is also used for the music before it (${markText(firstTempo.beatUnit, firstTempo.beatBpm)}).`,
      { measure: bar },
    )
  }
  const segments: TempoSegment[] = []
  const push = (start: Rational, t: ResolvedTempo) => {
    const value = { quarterBpm: t.quarterBpm, beatUnit: t.beatUnit, beatBpm: t.beatBpm, source: t.source }
    const last = segments[segments.length - 1]
    if (last && sameTempo(last, value)) return
    if (last && cmp(last.start, start) === 0) segments.pop()
    const prev = segments[segments.length - 1]
    if (prev && sameTempo(prev, value)) return
    segments.push({ start, ...value })
  }
  for (const o of occurrences) {
    const atStart = index.at(o.sourceMeasure, ZERO) ?? firstTempo
    push(o.start, atStart)
    for (const t of index.inMeasure(o.sourceMeasure)) {
      if (isZero(t.at)) continue
      push(add(o.start, t.at), t)
    }
  }
  if (segments.length === 0) segments.push({ start: ZERO, ...firstTempo, source: firstTempo.source })
  const first = segments[0]
  if (first && !isZero(first.start)) segments[0] = { ...first, start: rat(0) }
  return {
    segments: segments.map((s) => ({
      start: s.start,
      quarterBpm: s.quarterBpm,
      beatUnit: s.beatUnit,
      beatBpm: s.beatBpm,
      source: s.source,
    })),
  }
}
