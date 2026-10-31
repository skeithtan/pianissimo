/**
 * Ottava (octave-shift) scope. DECISIONS M1: MusicXML `<pitch>` under an octave shift is the
 * sounding pitch; `type="down"` marks 8va/15ma (sounds higher than written), `type="up"` marks
 * 8vb/15mb. Written = sounding − shift. The displacement is applied exactly once, to derive the
 * engraved spelling; matching always uses the sounding pitch.
 *
 * Scope is per staff and per `number`, half-open in source positions: a note is displaced when
 * its onset lies in [start, stop) — a stop written at the start of the next bar (or at a bar's
 * end) does not displace the notes that begin there. Spans are then laid out in performance
 * order; a span is split where a repeat jumps (its pieces are separate `OttavaSpan`s with their
 * own brackets). `startOcc`/`endOcc` are the bars holding the first and last displaced positions.
 */
import { type Rational, ZERO, add, cmp, eq, lt } from '../music/rational'
import type { MeasureOccurrence, SourceMeasure } from '../model/score'
import type { DiagnosticSink } from './diagnostics'
import { cmpPos } from './positions'
import type { RawOttava, SrcPos } from './read/types'
import type { XmlElement } from './xml'

export interface SourceOttava {
  /** Global staff index. */
  readonly staff: number
  readonly partId: string
  readonly staffNumber: number
  readonly number: string
  readonly size: 8 | 15
  readonly sounds: 'up' | 'down'
  /** Octaves sounding minus written (+1 8va, +2 15ma, −1 8vb, −2 15mb). */
  readonly shift: number
  readonly start: SrcPos
  readonly stop: SrcPos
  readonly startEl: XmlElement
  /** Undefined when the file never closes the span (it runs to the end of the score). */
  readonly stopEl?: XmlElement
}

/** Pair octave-shift starts and stops of one part into source spans (diagnosing mismatches). */
export function sourceOttavaSpans(
  raws: readonly RawOttava[],
  part: { readonly id: string; readonly name: string; readonly staffOffset: number },
  measures: readonly SourceMeasure[],
  diag: DiagnosticSink,
): SourceOttava[] {
  const sorted = raws
    .map((r, i) => [r, i] as const)
    .sort((a, b) => cmpPos(a[0], b[0]) || a[1] - b[1])
    .map(([r]) => r)
  const open = new Map<string, RawOttava>()
  const spans: SourceOttava[] = []
  const bar = (m: number) => measures[m]?.number ?? String(m + 1)
  const close = (start: RawOttava, stop: SrcPos, stopEl: XmlElement | undefined) => {
    const octaves = start.size === 15 ? 2 : 1
    if (cmpPos(stop, start) <= 0) return
    const span: { -readonly [K in keyof SourceOttava]: SourceOttava[K] } = {
      staff: part.staffOffset + start.staff - 1,
      partId: part.id,
      staffNumber: start.staff,
      number: start.number,
      size: start.size === 15 ? 15 : 8,
      sounds: start.type === 'down' ? 'up' : 'down',
      shift: start.type === 'down' ? octaves : -octaves,
      start: { m: start.m, at: start.at },
      stop,
      startEl: start.el,
    }
    if (stopEl) span.stopEl = stopEl
    spans.push(span)
  }
  for (const r of sorted) {
    const key = `${r.staff}|${r.number}`
    if (r.type === 'continue') continue
    if (r.type === 'stop') {
      const s = open.get(key)
      if (s) {
        close(s, { m: r.m, at: r.at }, r.el)
        open.delete(key)
      } else {
        diag.warn(
          'ottava-stop-unmatched',
          `An octave-shift end in bar ${bar(r.m)} has no matching start; it was ignored.`,
          {
            measure: bar(r.m),
          },
        )
      }
      continue
    }
    if (r.size !== 8 && r.size !== 15) {
      diag.warn(
        'ottava-size',
        `An octave shift of size ${r.size} in bar ${bar(r.m)} is not supported; it was ignored.`,
        {
          measure: bar(r.m),
        },
      )
      continue
    }
    const prev = open.get(key)
    if (prev) {
      diag.warn(
        'ottava-unclosed',
        `An octave shift starting in bar ${bar(prev.m)} is restarted in bar ${bar(r.m)} without an end.`,
        {
          measure: bar(prev.m),
        },
      )
      close(prev, { m: r.m, at: r.at }, undefined)
    }
    open.set(key, r)
  }
  for (const s of open.values()) {
    const last = measures.length - 1
    diag.warn(
      'ottava-unclosed',
      `The octave shift starting in bar ${bar(s.m)} is never ended; it runs to the end of the score.`,
      {
        measure: bar(s.m),
      },
    )
    close(s, { m: last, at: measures[last]?.duration ?? s.at }, undefined)
  }
  return spans
}

/** Index of source spans by global staff, for per-note lookups. */
export class OttavaLookup {
  private readonly byStaff = new Map<number, SourceOttava[]>()

  constructor(spans: readonly SourceOttava[]) {
    for (const s of spans) {
      let list = this.byStaff.get(s.staff)
      if (!list) this.byStaff.set(s.staff, (list = []))
      list.push(s)
    }
  }

  /** The span displacing a note on `staff` at `pos` (latest-starting when several overlap). */
  find(staff: number, pos: SrcPos): SourceOttava | undefined {
    let found: SourceOttava | undefined
    for (const s of this.byStaff.get(staff) ?? []) {
      if (cmpPos(s.start, pos) <= 0 && cmpPos(pos, s.stop) < 0) {
        if (!found || cmpPos(s.start, found.start) > 0) found = s
      }
    }
    return found
  }

  /** Spans of one staff overlapping another span (diagnostics). */
  overlaps(): Array<[SourceOttava, SourceOttava]> {
    const out: Array<[SourceOttava, SourceOttava]> = []
    for (const list of this.byStaff.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!
          const b = list[j]!
          if (cmpPos(a.start, b.stop) < 0 && cmpPos(b.start, a.stop) < 0) out.push([a, b])
        }
      }
    }
    return out
  }
}

/** One performance-order span (an `OttavaSpan` before its notes are attached). */
export interface PerformedOttava {
  readonly source: SourceOttava
  readonly start: Rational
  readonly end: Rational
  readonly startOcc: number
  readonly endOcc: number
}

/** Lay source spans out over the performance (see module doc). */
export function performOttavas(
  spans: readonly SourceOttava[],
  occurrences: readonly MeasureOccurrence[],
  measures: readonly SourceMeasure[],
): PerformedOttava[] {
  const out: PerformedOttava[] = []
  for (const s of spans) {
    let cur: { start: Rational; end: Rational; startOcc: number; lastOcc: number } | null = null
    const finish = () => {
      if (!cur) return
      out.push({
        source: s,
        start: cur.start,
        end: cur.end,
        startOcc: cur.startOcc,
        endOcc: cur.lastOcc,
      })
      cur = null
    }
    for (const o of occurrences) {
      const m = o.sourceMeasure
      const dur = measures[m]?.duration ?? o.duration
      const a = m === s.start.m ? s.start.at : ZERO
      const b = m === s.stop.m ? s.stop.at : dur
      if (m < s.start.m || m > s.stop.m || !lt(a, b)) {
        finish()
        continue
      }
      const from = add(o.start, a)
      const prev = occurrences[o.index - 1]
      const continues =
        cur !== null &&
        prev !== undefined &&
        cur.lastOcc === prev.index &&
        prev.sourceMeasure + 1 === m &&
        eq(cur.end, from)
      if (!continues) {
        finish()
        cur = { start: from, end: from, startOcc: o.index, lastOcc: o.index }
      }
      if (cur) {
        cur.end = add(o.start, b)
        cur.lastOcc = o.index
      }
      if (m === s.stop.m) finish()
    }
    finish()
  }
  return out.sort((x, y) => cmp(x.start, y.start) || x.source.staff - y.source.staff)
}
