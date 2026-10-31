/**
 * Performed notes: every source note in every measure occurrence, sorted by (onset, staff,
 * midi), with tie chains and arpeggiation groups resolved in performance order.
 *
 * - Ties link a `tieStart` note to the next note of the same part and sounding pitch that begins
 *   exactly where it ends and carries `tieStop` (same voice preferred, then same staff). The
 *   continuation needs no fresh attack; the head's `soundingDuration` is the whole chain.
 * - Arpeggiation groups: notes marked `<arpeggiate>` at the same onset in the same part with the
 *   same `number` form one gesture, across staves (one sweep). Without a number, each voice's
 *   chord is its own roll. Direction defaults to up when no member states one.
 */
import { type Rational, add, cmp, key } from '../music/rational'
import type { ArpeggioGroup, ClefKey, Hand, MeasureOccurrence, PerformedNote, SourceNote } from '../model/score'
import type { DiagnosticSink } from './diagnostics'

export type MutablePerformedNote = { -readonly [K in keyof PerformedNote]: PerformedNote[K] }
export type MutableArpeggio = { -readonly [K in keyof ArpeggioGroup]: ArpeggioGroup[K] }

export function performNotes(
  sourceNotes: readonly SourceNote[],
  extras: readonly { readonly clef: ClefKey; readonly velocity: number }[],
  occurrences: readonly MeasureOccurrence[],
  measureCount: number,
): MutablePerformedNote[] {
  const byMeasure: number[][] = Array.from({ length: measureCount }, () => [])
  for (const n of sourceNotes) byMeasure[n.measure]?.push(n.id)
  const out: MutablePerformedNote[] = []
  for (const o of occurrences) {
    for (const src of byMeasure[o.sourceMeasure] ?? []) {
      const s = sourceNotes[src]!
      const extra = extras[src]!
      const p: MutablePerformedNote = {
        index: -1,
        id: `${o.index}:${src}`,
        src,
        occ: o.index,
        onset: add(o.start, s.onsetInMeasure),
        duration: s.duration,
        soundingDuration: s.duration,
        staff: s.staff,
        staffNumber: s.staffNumber,
        partId: s.partId,
        voice: s.voice,
        hand: 'R',
        midi: s.midi,
        sounding: s.sounding,
        written: s.written,
        ottavaShift: s.ottavaShift,
        clef: extra.clef,
        tieContinuation: false,
        tieHead: -1,
        refOffsetSec: 0,
        velocity: extra.velocity,
        grace: s.grace,
        cue: s.cue,
        onsetInMeasure: s.onsetInMeasure,
        accidentalContext: s.accidentalContext,
      }
      if (s.fingering !== undefined) p.fingering = s.fingering
      out.push(p)
    }
  }
  out.sort(
    (a, b) =>
      cmp(a.onset, b.onset) ||
      a.staff - b.staff ||
      a.midi - b.midi ||
      (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0) ||
      a.src - b.src,
  )
  out.forEach((n, i) => {
    n.index = i
    n.tieHead = i
  })
  return out
}

/** Resolve tie chains (see module doc); diagnoses ties that never pair in any occurrence. */
export function linkTies(
  notes: MutablePerformedNote[],
  sourceNotes: readonly SourceNote[],
  barOf: (m: number) => string,
  diag: DiagnosticSink,
): void {
  const stops = new Map<string, number[]>()
  for (const n of notes) {
    const s = sourceNotes[n.src]!
    if (!s.tieStop || s.grace) continue
    const k = `${n.partId}|${n.midi}|${key(n.onset)}`
    let list = stops.get(k)
    if (!list) stops.set(k, (list = []))
    list.push(n.index)
  }
  const next = new Map<number, number>()
  const claimed = new Set<number>()
  const matchedStart = new Set<number>()
  const matchedStop = new Set<number>()
  for (const n of notes) {
    const s = sourceNotes[n.src]!
    if (!s.tieStart || s.grace) continue
    const candidates = (stops.get(`${n.partId}|${n.midi}|${key(add(n.onset, n.duration))}`) ?? []).filter(
      (c) => !claimed.has(c),
    )
    const pick =
      candidates.find((c) => notes[c]!.voice === n.voice) ??
      candidates.find((c) => notes[c]!.staff === n.staff) ??
      candidates[0]
    if (pick === undefined) continue
    claimed.add(pick)
    next.set(n.index, pick)
    matchedStart.add(n.src)
    matchedStop.add(notes[pick]!.src)
    notes[pick]!.tieContinuation = true
  }
  const prev = new Map<number, number>()
  for (const [a, b] of next) prev.set(b, a)
  for (const n of notes) {
    const p = prev.get(n.index)
    n.tieHead = p === undefined ? n.index : notes[p]!.tieHead
  }
  for (const n of notes) {
    if (n.tieContinuation) continue
    let total: Rational = n.duration
    let cur = next.get(n.index)
    const seen = new Set<number>()
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      total = add(total, notes[cur]!.duration)
      cur = next.get(cur)
    }
    n.soundingDuration = total
  }
  let unmatchedStarts = 0
  let unmatchedStops = 0
  for (const s of sourceNotes) {
    if (s.grace) continue
    if (s.tieStart && !matchedStart.has(s.id)) {
      if (unmatchedStarts++ < 10) {
        diag.warn(
          'tie-unmatched',
          `A tie from ${s.sounding.step}${s.sounding.octave} in bar ${barOf(s.measure)} has no matching note; the next note is attacked again.`,
          {
            measure: barOf(s.measure),
          },
        )
      }
    }
    if (s.tieStop && !matchedStop.has(s.id)) {
      if (unmatchedStops++ < 10) {
        diag.warn(
          'tie-unmatched',
          `A tie ending on ${s.sounding.step}${s.sounding.octave} in bar ${barOf(s.measure)} has no start; the note is attacked.`,
          {
            measure: barOf(s.measure),
          },
        )
      }
    }
  }
}

/** Group marked rolls (see module doc). Returns groups sorted by onset, then staff. */
export function groupArpeggios(
  notes: MutablePerformedNote[],
  sourceNotes: readonly SourceNote[],
  barOf: (m: number) => string,
  diag: DiagnosticSink,
): MutableArpeggio[] {
  const byKey = new Map<string, number[]>()
  for (const n of notes) {
    const a = sourceNotes[n.src]!.arpeggiate
    if (!a) continue
    const g = a.number !== undefined ? `n${a.number}` : `v${n.voice}`
    const k = `${n.occ}|${key(n.onset)}|${n.partId}|${g}`
    let list = byKey.get(k)
    if (!list) byKey.set(k, (list = []))
    list.push(n.index)
  }
  const groups: MutableArpeggio[] = []
  for (const members of byKey.values()) {
    const first = notes[members[0]!]!
    const directions = new Set<'up' | 'down'>()
    let number: string | undefined
    for (const i of members) {
      const a = sourceNotes[notes[i]!.src]!.arpeggiate
      if (a?.direction) directions.add(a.direction)
      if (a?.number !== undefined) number = a.number
    }
    if (directions.size > 1) {
      diag.warn(
        'arpeggio-direction-conflict',
        `A rolled chord in bar ${barOf(sourceNotes[first.src]!.measure)} has conflicting arrows; the first is used.`,
        {
          measure: barOf(sourceNotes[first.src]!.measure),
          occ: first.occ,
        },
      )
    }
    const direction = [...directions][0] ?? 'up'
    const sorted = [...members].sort((x, y) => notes[x]!.midi - notes[y]!.midi || x - y)
    const g: MutableArpeggio = {
      index: -1,
      at: first.onset,
      occ: first.occ,
      notes: sorted,
      direction,
      directionDefaulted: directions.size === 0,
      crossStaff: new Set(members.map((i) => notes[i]!.staff)).size > 1,
      spreadSec: 0,
    }
    if (number !== undefined) g.number = number
    groups.push(g)
  }
  groups.sort((a, b) => cmp(a.at, b.at) || notes[a.notes[0]!]!.staff - notes[b.notes[0]!]!.staff)
  groups.forEach((g, i) => {
    g.index = i
    for (const n of g.notes) notes[n]!.arpeggio = i
  })
  return groups
}

/** Hand of a global staff index in the M2 proposal: the top staff is the right hand. */
export function staffHand(staff: number): Hand {
  return staff === 0 ? 'R' : 'L'
}
