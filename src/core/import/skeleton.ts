/**
 * The written-score skeleton for the selected parts: global staves (top to bottom), source
 * measures with their nominal and filled durations, and merged barline/repeat information.
 */
import { type Rational, ZERO, gt, isZero, lt, rat } from '../music/rational'
import type { SourceMeasure, StaffDef } from '../model/score'
import type { DiagnosticSink } from './diagnostics'
import { PosIndex } from './positions'
import type { PartData, RawBarlines, RawTime } from './read/types'
import type { XmlElement } from './xml'

export interface SelectedPart {
  readonly id: string
  readonly name: string
  readonly el: XmlElement
  readonly data: PartData
  /** Global staff index of this part's staff 1. */
  readonly staffOffset: number
  readonly staffCount: number
}

export interface Skeleton {
  readonly parts: readonly SelectedPart[]
  readonly staves: readonly StaffDef[]
  readonly measures: readonly SourceMeasure[]
  readonly barlines: readonly RawBarlines[]
  /** Meter changes of the first selected part (meters are score-wide in piano music). */
  readonly times: PosIndex<RawTime>
}

const DEFAULT_TIME_NOMINAL: Rational = rat(1)

function mergeBarlines(list: readonly (RawBarlines | undefined)[]): RawBarlines {
  const out: { -readonly [K in keyof RawBarlines]: RawBarlines[K] } = { forwardRepeat: false, endingStop: false }
  for (const b of list) {
    if (!b) continue
    if (b.forwardRepeat) out.forwardRepeat = true
    if (b.backwardRepeat && !out.backwardRepeat) out.backwardRepeat = b.backwardRepeat
    if (b.endingStart && !out.endingStart) out.endingStart = b.endingStart
    if (b.endingStop) out.endingStop = true
    if (b.fermata && !out.fermata) out.fermata = b.fermata
  }
  return out
}

export function buildSkeleton(
  parts: readonly { readonly id: string; readonly name: string; readonly el: XmlElement; readonly data: PartData }[],
  diag: DiagnosticSink,
): Skeleton {
  const selected: SelectedPart[] = []
  const staves: StaffDef[] = []
  for (const p of parts) {
    let staffCount = Math.max(1, p.data.staves)
    let maxNoteStaff = 0
    for (const n of p.data.notes) maxNoteStaff = Math.max(maxNoteStaff, n.staff)
    if (maxNoteStaff > staffCount) {
      diag.warn(
        'staff-count',
        `Part “${p.name}” places notes on staff ${maxNoteStaff} but declares ${staffCount} staves.`,
      )
      staffCount = maxNoteStaff
    }
    const staffOffset = staves.length
    for (let s = 1; s <= staffCount; s++) staves.push({ index: staves.length, partId: p.id, staffNumber: s })
    selected.push({ ...p, staffOffset, staffCount })
  }

  const first = selected[0]
  const count = Math.max(0, ...selected.map((p) => p.data.measures.length))
  for (const p of selected) {
    if (p.data.measures.length !== count) {
      diag.warn(
        'part-measure-mismatch',
        `Part “${p.name}” has ${p.data.measures.length} bars but the selection has ${count}. Missing bars are treated as empty.`,
      )
    }
  }
  const times = new PosIndex(first ? first.data.times : [])
  if (count > 0 && times.items.length === 0) {
    diag.warn('meter-missing', 'The score has no time signature. 4/4 is assumed for bar lengths.')
  }

  const measures: SourceMeasure[] = []
  const barlines: RawBarlines[] = []
  const shortVoices: string[] = []
  for (let m = 0; m < count; m++) {
    const raw = selected.map((p) => p.data.measures[m])
    const ref = raw.find((r) => r !== undefined)
    const number = ref?.number ?? String(m + 1)
    let filled: Rational = ZERO
    for (const r of raw) if (r && gt(r.filled, filled)) filled = r.filled
    const time = times.at(m, ZERO)
    const nominal = time ? (time.senzaMisura ? filled : time.nominal) : DEFAULT_TIME_NOMINAL
    const duration = isZero(filled) ? nominal : filled
    const implicit = raw.some((r) => r?.implicit === true)
    if (!implicit && !time?.senzaMisura && !isZero(filled) && !isZero(nominal)) {
      if (lt(filled, nominal) && m !== 0 && m !== count - 1) {
        diag.warn('measure-underfull', `Bar ${number} is shorter than its time signature.`, { measure: number })
      } else if (gt(filled, nominal)) {
        diag.warn('measure-overfull', `Bar ${number} is longer than its time signature.`, { measure: number })
      }
    }
    if (raw.some((r) => r !== undefined && r.number !== number)) {
      diag.info('measure-number-mismatch', `Parts number bar ${m + 1} differently. “${number}” is shown.`, {
        measure: number,
      })
    }
    measures.push({ index: m, number, implicit, nominalDuration: nominal, duration })
    barlines.push(mergeBarlines(raw.map((r) => r?.barlines)))
    for (const r of raw) {
      if (!r) continue
      for (const [voice, end] of r.voiceEnds) {
        if (gt(end, duration)) {
          diag.warn('voice-overfull', `Voice ${voice} in bar ${number} extends past the end of the bar.`, {
            measure: number,
          })
        } else if (lt(end, duration) && m !== count - 1) {
          shortVoices.push(number)
        }
      }
    }
  }
  if (shortVoices.length > 0) {
    const bars = [...new Set(shortVoices)]
    diag.info(
      'voice-underfull',
      `In ${bars.length === 1 ? 'bar' : 'bars'} ${bars.slice(0, 8).join(', ')}${bars.length > 8 ? ', …' : ''}, ${shortVoices.length === 1 ? 'a voice ends' : `${shortVoices.length} voices end`} before the bar does. The rest of the bar is silent in ${shortVoices.length === 1 ? 'that voice' : 'those voices'}.`,
    )
  }
  return { parts: selected, staves, measures, barlines, times }
}
