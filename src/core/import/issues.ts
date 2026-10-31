/**
 * Timing issues and unsupported regions.
 *
 * Spec: "A verbal tempo, fermata, or 'rit.' marking does not supply an exact duration by itself"
 * and "Unresolved fermatas, rubato, and annotation-only tempo changes remain timing-unscored".
 * A verbal change is *resolved* when the file realizes it numerically: a gradual change
 * (rit., accel., …) followed by a numeric tempo in the same or the next bar, or a tempo word
 * (a tempo, Allegro, …) stated together with a numeric tempo. Tempo words at the very start
 * are covered by the source or user tempo.
 *
 * DECISIONS M4: grace notes, ornaments needing realization, tremolo shorthand, microtones and
 * free time mark their bars as `UnsupportedRegion`s (viewable, excluded from scored practice,
 * never silently dropped). Unfollowed D.C./D.S./Coda jumps are `unsupported-repeat`.
 */
import { type Rational, add, cmp, isZero, key } from '../music/rational'
import type { MeasureOccurrence, TimingIssue, UnsupportedKind, UnsupportedRegion } from '../model/score'
import type { DiagnosticSink } from './diagnostics'
import { cmpPos } from './positions'
import type { RawWords, SrcPos } from './read/types'
import type { ResolvedTempo } from './tempoMap'

const GRADUAL =
  /\b(?:rit|ritard|ritardando|riten|ritenuto|rall|rallentando|accel|accelerando|stringendo|allarg|allargando|calando|smorzando|morendo|slowing|slower|faster)\b|poco\s+a\s+poco/i
const TEMPO_WORD =
  /\b(?:a\s+tempo|tempo\s+(?:i|primo|1)|meno\s+mosso|pi[uù]\s+mosso|l['’]istesso|grave|largo|larghetto|lento|adagio|adagietto|andante|andantino|moderato|allegretto|allegro|vivace|vivacissimo|presto|prestissimo)\b/i
const RUBATO = /\brubato\b/i

export interface TimingMark extends SrcPos {
  readonly kind: TimingIssue['kind']
  readonly text: string
}

/** Classify words into timing marks (unresolved verbal tempo, rubato, metric modulation). */
export function verbalTimingMarks(
  words: readonly RawWords[],
  tempos: readonly ResolvedTempo[],
  measureCount: number,
): TimingMark[] {
  const out: TimingMark[] = []
  const seen = new Set<string>()
  for (const w of words) {
    const id = `${w.m}|${key(w.at)}|${w.text}`
    if (seen.has(id)) continue
    seen.add(id)
    if (w.metricModulation) {
      out.push({ m: w.m, at: w.at, kind: 'other', text: 'metric modulation' })
      continue
    }
    if (RUBATO.test(w.text)) {
      out.push({ m: w.m, at: w.at, kind: 'rubato', text: w.text })
      continue
    }
    if (w.withTempo) continue
    if (GRADUAL.test(w.text)) {
      const lastBar = Math.min(measureCount - 1, w.m + 1)
      const realized = tempos.some((t) => cmpPos(t, w) >= 0 && t.m <= lastBar)
      if (!realized) out.push({ m: w.m, at: w.at, kind: 'verbal-tempo', text: w.text })
      continue
    }
    if (TEMPO_WORD.test(w.text)) {
      if (w.m === 0 && isZero(w.at)) continue
      const realized = tempos.some((t) => t.m === w.m && cmp(t.at, w.at) === 0)
      if (!realized) out.push({ m: w.m, at: w.at, kind: 'verbal-tempo', text: w.text })
    }
  }
  return out
}

/** Repeat a source-positioned mark in every occurrence of its bar; one issue per (occ, position, kind). */
export function timingIssuesFor(
  marks: readonly TimingMark[],
  byMeasure: readonly (readonly number[])[],
  occurrences: readonly MeasureOccurrence[],
): TimingIssue[] {
  const out: TimingIssue[] = []
  const seen = new Set<string>()
  for (const mark of marks) {
    for (const occ of byMeasure[mark.m] ?? []) {
      const o = occurrences[occ]
      if (!o) continue
      const at: Rational = add(o.start, mark.at)
      const id = `${occ}|${key(at)}|${mark.kind}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ kind: mark.kind, occ, at, text: mark.text })
    }
  }
  return out.sort((a, b) => cmp(a.at, b.at) || a.occ - b.occ)
}

export interface UnsupportedMark {
  readonly m: number
  readonly kind: UnsupportedKind
  readonly detail: string
}

const KIND_MESSAGE: Readonly<Record<UnsupportedKind, string>> = {
  grace: 'Grace notes',
  ornament: 'Ornaments that need a realization',
  tremolo: 'Tremolo shorthand',
  microtone: 'Microtonal pitches',
  'free-time': 'Free time (no meter)',
  'unsupported-repeat': 'Repeat instruction that is not followed',
  'non-piano': 'Unpitched or non-piano notation',
  other: 'Notation that cannot be interpreted',
}

/**
 * Merge per-bar marks into regions over consecutive occurrences, one kind at a time, and report
 * each region once as a warning.
 */
export function unsupportedRegions(
  marks: readonly UnsupportedMark[],
  occurrences: readonly MeasureOccurrence[],
  diag: DiagnosticSink,
): UnsupportedRegion[] {
  const kinds = new Map<UnsupportedKind, Map<number, Set<string>>>()
  for (const mk of marks) {
    let byM = kinds.get(mk.kind)
    if (!byM) kinds.set(mk.kind, (byM = new Map()))
    let details = byM.get(mk.m)
    if (!details) byM.set(mk.m, (details = new Set()))
    details.add(mk.detail)
  }
  const regions: UnsupportedRegion[] = []
  for (const [kind, byM] of kinds) {
    let from = -1
    let to = -1
    let details = new Set<string>()
    const flush = () => {
      if (from < 0) return
      const base = KIND_MESSAGE[kind]
      const extra = [...details].filter((d) => d !== '')
      const message = extra.length > 0 ? `${base} (${extra.slice(0, 4).join(', ')})` : base
      regions.push({ kind, fromOcc: from, toOcc: to, message })
      const a = occurrences[from]
      const b = occurrences[to]
      const bars = from === to ? `bar ${label(a)}` : `bars ${label(a)}–${label(b)}`
      const code = kind === 'unsupported-repeat' ? kind : `unsupported-${kind}`
      diag.warn(code, `${message} in ${bars}: viewable, but scored practice is disabled there.`, {
        measure: a?.number ?? '',
        occ: from,
      })
      from = -1
      details = new Set()
    }
    for (const o of occurrences) {
      const d = byM.get(o.sourceMeasure)
      if (!d) {
        flush()
        continue
      }
      if (from < 0) from = o.index
      to = o.index
      for (const x of d) details.add(x)
    }
    flush()
  }
  return regions.sort((a, b) => a.fromOcc - b.fromOcc || a.kind.localeCompare(b.kind))
}

/** Printed bar label for an occurrence: "12" or "12 (pass 2)" (DECISIONS M5). */
export function label(o: MeasureOccurrence | undefined): string {
  if (!o) return '?'
  return o.pass > 1 ? `${o.number} (pass ${o.pass})` : o.number
}
