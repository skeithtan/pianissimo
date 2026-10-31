/**
 * Key, meter and clef maps plus pedal and dynamics marks in performance order. Context events
 * are emitted wherever the context *changes in performance order* — including at a repeat jump
 * whose target bar has a different key, meter or clef than the bar before the jump.
 */
import { type Rational, ZERO, add, cmp, isZero } from '../music/rational'
import type { ClefEvent, DynamicMark, KeyEvent, MeasureOccurrence, MeterEvent, PedalMark } from '../model/score'
import { PosIndex } from './positions'
import type { RawClef, RawKey, RawTime } from './read/types'
import type { Skeleton } from './skeleton'
import { clefKeyOf } from './sourceNotes'

function eachChange<T extends { readonly m: number; readonly at: Rational }>(
  index: PosIndex<T>,
  occurrences: readonly MeasureOccurrence[],
  emit: (item: T, at: Rational, occ: number) => void,
): void {
  for (const o of occurrences) {
    const start = index.at(o.sourceMeasure, ZERO)
    if (start) emit(start, o.start, o.index)
    for (const it of index.inMeasure(o.sourceMeasure)) {
      if (!isZero(it.at)) emit(it, add(o.start, it.at), o.index)
    }
  }
}

export function keyEvents(skeleton: Skeleton, occurrences: readonly MeasureOccurrence[]): KeyEvent[] {
  const first = skeleton.parts[0]
  const index = new PosIndex<RawKey>(first ? first.data.keys : [])
  const out: KeyEvent[] = []
  eachChange(index, occurrences, (k, at, occ) => {
    const last = out[out.length - 1]
    if (last && last.fifths === k.fifths && last.mode === k.mode) return
    const e: { -readonly [K in keyof KeyEvent]: KeyEvent[K] } = { at, occ, fifths: k.fifths }
    if (k.mode !== undefined) e.mode = k.mode
    out.push(e)
  })
  if ((out.length === 0 || !isZero(out[0]!.at)) && occurrences.length > 0) out.unshift({ at: ZERO, occ: 0, fifths: 0 })
  return out
}

export function meterEvents(skeleton: Skeleton, occurrences: readonly MeasureOccurrence[]): MeterEvent[] {
  const out: MeterEvent[] = []
  let lastSenza = false
  eachChange<RawTime>(skeleton.times, occurrences, (t, at, occ) => {
    if (t.senzaMisura) {
      lastSenza = true
      return
    }
    const last = out[out.length - 1]
    if (
      !lastSenza &&
      last &&
      last.beatsText === t.beatsText &&
      last.beatType === t.beatType &&
      last.symbol === t.symbol
    )
      return
    lastSenza = false
    const e: { -readonly [K in keyof MeterEvent]: MeterEvent[K] } = {
      at,
      occ,
      beats: t.beats,
      beatType: t.beatType,
      beatsText: t.beatsText,
    }
    if (t.symbol !== undefined) e.symbol = t.symbol
    out.push(e)
  })
  if (out.length === 0 && skeleton.times.items.length === 0 && occurrences.length > 0) {
    out.push({ at: ZERO, occ: 0, beats: 4, beatType: 4, beatsText: '4' })
  }
  return out
}

export function clefEvents(
  clefsByStaff: ReadonlyMap<number, PosIndex<RawClef>>,
  occurrences: readonly MeasureOccurrence[],
): ClefEvent[] {
  const out: ClefEvent[] = []
  for (const [staff, index] of [...clefsByStaff].sort((a, b) => a[0] - b[0])) {
    let lastKey: string | undefined
    eachChange(index, occurrences, (c, at, occ) => {
      const k = clefKeyOf(c.clef)
      if (k === lastKey) return
      lastKey = k
      out.push({ at, occ, staff, clef: c.clef, key: k })
    })
  }
  return out.sort((a, b) => cmp(a.at, b.at) || a.staff - b.staff)
}

export function pedalMarks(skeleton: Skeleton, occurrences: readonly MeasureOccurrence[]): PedalMark[] {
  const out: PedalMark[] = []
  for (const part of skeleton.parts) {
    const index = new PosIndex(part.data.pedals)
    for (const o of occurrences) {
      for (const p of index.inMeasure(o.sourceMeasure)) {
        const mark: { -readonly [K in keyof PedalMark]: PedalMark[K] } = {
          at: add(o.start, p.at),
          occ: o.index,
          kind: p.kind,
          type: p.type,
        }
        if (p.value !== undefined) mark.value = p.value
        if (p.staff !== undefined) mark.staff = part.staffOffset + p.staff - 1
        out.push(mark)
      }
    }
  }
  return out.sort((a, b) => cmp(a.at, b.at))
}

export function dynamicMarks(skeleton: Skeleton, occurrences: readonly MeasureOccurrence[]): DynamicMark[] {
  const out: DynamicMark[] = []
  for (const part of skeleton.parts) {
    const index = new PosIndex(part.data.dynamics)
    for (const o of occurrences) {
      for (const d of index.inMeasure(o.sourceMeasure)) {
        const mark: { -readonly [K in keyof DynamicMark]: DynamicMark[K] } = {
          at: add(o.start, d.at),
          occ: o.index,
          velocity: d.velocity,
        }
        if (d.staff !== undefined) mark.staff = part.staffOffset + d.staff - 1
        if (d.text !== undefined) mark.text = d.text
        out.push(mark)
      }
    }
  }
  return out.sort((a, b) => cmp(a.at, b.at))
}
