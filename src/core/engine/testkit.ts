/**
 * Builders for engine tests: valid `ScoreModel`s from compact note lists, and sequenced MIDI
 * input. Not imported by application code (the importer produces real models).
 *
 * Positions and durations are given in quarter notes (`1` = a quarter, `1.5` = dotted
 * quarter) or as exact `Rational` whole notes for odd tuplets.
 */
import type { MidiInputEvent } from '../midi/types'
import type { AttemptRecord } from '../model/practice'
import { PracticeEngine } from './engine'
import type { Timeline } from './timeline'
import type { EngineConfig, EngineEvent, EngineState } from './types'
import { type Rational, ZERO, add, cmp, eq, ge, lt, rat, sub } from '../music/rational'
import { type Spelling, type Step, shiftOctaves } from '../music/pitch'
import { QUARTER, type TempoMapData, type TempoSegment, quarterBpmFromBeat } from '../music/tempo'
import {
  IMPORTER_VERSION,
  ROLL_POLICY_VERSION,
  SCORE_PACKAGE_FORMAT,
  type ArpeggioGroup,
  type Hand,
  type MeasureOccurrence,
  type OttavaSpan,
  type PedalMark,
  type PerformedNote,
  type ScoreModel,
  type SourceMeasure,
  type SourceNote,
  type TimingIssue,
  type UnsupportedRegion,
  type VoiceDef,
} from '../model/score'

export type Pos = number | Rational

export interface NoteSpec {
  /** Performance onset (quarters or whole-note Rational). */
  readonly at: Pos
  /** Default: one quarter. */
  readonly dur?: Pos
  /** Sounding MIDI pitch (ottava already resolved, DECISIONS M1). */
  readonly midi: number
  /** Default: staff 0 → 'R', staff 1 → 'L'. */
  readonly hand?: Hand
  /** 0 = treble staff, 1 = bass staff. Default from the hand (R → 0, L → 1). */
  readonly staff?: number
  /** Default: '1' on staff 0, '5' on staff 1. */
  readonly voice?: string
  /** Continues a tie from the note of the same pitch and voice that ends at `at`. */
  readonly cont?: boolean
  /** Notes sharing a roll key form one marked arpeggio (may span both staves). */
  readonly roll?: number
  /** Reference attack offset in seconds at 1× (roll realization). */
  readonly offset?: number
  readonly grace?: boolean
  readonly cue?: boolean
}

export interface OttavaSpec {
  readonly staff: number
  readonly start: Pos
  readonly end: Pos
  /** Octaves sounding minus written: 1 = 8va, 2 = 15ma, −1 = 8vb, −2 = 15mb. */
  readonly shift: 1 | 2 | -1 | -2
}

export interface TempoSpec {
  readonly bpm: number
  /** Beat unit in whole notes (default quarter). */
  readonly unit?: Rational
}

export interface ScoreSpec {
  readonly notes: readonly NoteSpec[]
  /** Default 4/4. */
  readonly meter?: readonly [beats: number, beatType: number]
  /** Number of bars (default: enough for every note), or explicit bar durations (pickups). */
  readonly bars?: number | readonly Pos[]
  /** Default quarter = 60. `null` = no numerical tempo. */
  readonly tempo?: TempoSpec | readonly TempoSegment[] | null
  readonly ottavas?: readonly OttavaSpec[]
  /** Pedal marks (kind default 'sustain'). */
  readonly pedals?: readonly (Omit<PedalMark, 'at' | 'occ' | 'kind'> & {
    readonly at: Pos
    readonly kind?: PedalMark['kind']
  })[]
  /** Printed number and pass per occurrence (repeat labels), by occurrence index. */
  readonly passes?: readonly { readonly number: string; readonly pass: number }[]
  readonly unsupported?: readonly UnsupportedRegion[]
  readonly timingIssues?: readonly (Omit<TimingIssue, 'at'> & { readonly at: Pos })[]
  readonly ambiguousVoices?: readonly string[]
  readonly handsConfirmed?: boolean
  readonly scoreVersionId?: string
}

/** Quarters (or an exact Rational) → whole notes. */
export function pos(x: Pos): Rational {
  if (typeof x !== 'number') return x
  const n = x * 48
  if (!Number.isInteger(Math.round(n * 1e6) / 1e6)) throw new RangeError(`Use a Rational for ${x} quarters`)
  return rat(Math.round(n), 192)
}

const NAMES: readonly (readonly [Step, number])[] = [
  ['C', 0],
  ['C', 1],
  ['D', 0],
  ['D', 1],
  ['E', 0],
  ['F', 0],
  ['F', 1],
  ['G', 0],
  ['G', 1],
  ['A', 0],
  ['A', 1],
  ['B', 0],
]

export function spellingOf(midi: number): Spelling {
  const [step, alter] = NAMES[((midi % 12) + 12) % 12]!
  return { step, alter, octave: Math.floor(midi / 12) - 1 }
}

function tempoMap(spec: ScoreSpec['tempo']): TempoMapData {
  if (spec === null) return { segments: [] }
  if (spec === undefined) return tempoMap({ bpm: 60 })
  if ('bpm' in spec) {
    const beatUnit = spec.unit ?? QUARTER
    return {
      segments: [
        {
          start: ZERO,
          quarterBpm: quarterBpmFromBeat(spec.bpm, beatUnit),
          beatUnit,
          beatBpm: spec.bpm,
          source: 'sound',
        },
      ],
    }
  }
  return { segments: spec }
}

interface Draft {
  readonly spec: NoteSpec
  readonly onset: Rational
  readonly duration: Rational
  readonly staff: number
  readonly hand: Hand
  readonly voice: string
}

/** Build a valid single-part, two-staff `ScoreModel` from a compact description. */
export function buildScore(spec: ScoreSpec): ScoreModel {
  const [beats, beatType] = spec.meter ?? [4, 4]
  const barLen = rat(beats, beatType)
  const drafts: Draft[] = spec.notes.map((n) => {
    const staff = n.staff ?? (n.hand === 'L' ? 1 : 0)
    const hand = n.hand ?? (staff === 1 ? 'L' : 'R')
    return {
      spec: n,
      onset: pos(n.at),
      duration: n.grace ? ZERO : pos(n.dur ?? 1),
      staff,
      hand,
      voice: n.voice ?? (staff === 1 ? '5' : '1'),
    }
  })
  drafts.sort((a, b) => cmp(a.onset, b.onset) || a.staff - b.staff || a.spec.midi - b.spec.midi)

  let barDurations: Rational[]
  if (Array.isArray(spec.bars)) {
    barDurations = (spec.bars as readonly Pos[]).map(pos)
  } else {
    let count = typeof spec.bars === 'number' ? spec.bars : 1
    for (const d of drafts) {
      const endBar = Math.floor((d.onset.n * barLen.d) / (d.onset.d * barLen.n)) + 1
      if (typeof spec.bars !== 'number') count = Math.max(count, endBar)
    }
    barDurations = Array.from({ length: count }, () => barLen)
  }
  const occurrences: MeasureOccurrence[] = []
  const sourceMeasures: SourceMeasure[] = []
  let cursor = ZERO
  barDurations.forEach((duration, index) => {
    const label = spec.passes?.[index]
    const number = label?.number ?? `${index + 1}`
    occurrences.push({ index, sourceMeasure: index, number, pass: label?.pass ?? 1, start: cursor, duration })
    sourceMeasures.push({ index, number, implicit: false, nominalDuration: barLen, duration })
    cursor = add(cursor, duration)
  })
  const totalDuration = cursor
  const occAt = (p: Rational): number => {
    for (let i = occurrences.length - 1; i >= 0; i--) if (ge(p, occurrences[i]!.start)) return i
    return 0
  }

  const ottavas: OttavaSpan[] = (spec.ottavas ?? []).map((o, index) => {
    const start = pos(o.start)
    const end = pos(o.end)
    return {
      index,
      staff: o.staff,
      number: `${index + 1}`,
      size: Math.abs(o.shift) === 2 ? 15 : 8,
      sounds: o.shift > 0 ? 'up' : 'down',
      start,
      end,
      startOcc: occAt(start),
      endOcc: occAt(sub(end, rat(1, 1024))),
      notes: [],
    }
  })
  const ottavaNotes = ottavas.map(() => [] as number[])

  const notes: PerformedNote[] = []
  const tieHeads: number[] = []
  drafts.forEach((d, index) => {
    let tieHead = index
    if (d.spec.cont) {
      let found = -1
      for (let j = index - 1; j >= 0; j--) {
        const p = drafts[j]!
        if (p.spec.midi === d.spec.midi && p.voice === d.voice && eq(add(p.onset, p.duration), d.onset)) {
          found = j
          break
        }
      }
      if (found < 0) throw new RangeError(`No tie start for midi ${d.spec.midi} at ${d.onset.n}/${d.onset.d}`)
      tieHead = tieHeads[found]!
    }
    tieHeads.push(tieHead)
    const occ = occAt(d.onset)
    const o = occurrences[occ]!
    const spanIndex = (spec.ottavas ?? []).findIndex(
      (s) => s.staff === d.staff && ge(d.onset, pos(s.start)) && lt(d.onset, pos(s.end)),
    )
    const shift = spanIndex >= 0 ? spec.ottavas![spanIndex]!.shift : 0
    if (spanIndex >= 0) ottavaNotes[spanIndex]!.push(index)
    const sounding = spellingOf(d.spec.midi)
    notes.push({
      index,
      id: `${occ}:${index}`,
      src: index,
      occ,
      onset: d.onset,
      duration: d.duration,
      soundingDuration: d.duration,
      staff: d.staff,
      staffNumber: d.staff + 1,
      partId: 'P1',
      voice: d.voice,
      hand: d.hand,
      midi: d.spec.midi,
      sounding,
      written: shiftOctaves(sounding, -shift),
      ottavaShift: shift,
      ...(spanIndex >= 0 ? { ottava: spanIndex } : {}),
      clef: d.staff === 1 ? 'F4' : 'G2',
      tieContinuation: tieHead !== index,
      tieHead,
      refOffsetSec: d.spec.offset ?? 0,
      velocity: 80,
      grace: d.spec.grace ?? false,
      cue: d.spec.cue ?? false,
      onsetInMeasure: sub(d.onset, o.start),
      accidentalContext: { keyFifths: 0, carried: [] },
    })
  })
  // Tie-chain heads carry the total tied duration.
  const chainTotals = new Map<number, Rational>()
  for (const n of notes) chainTotals.set(n.tieHead, add(chainTotals.get(n.tieHead) ?? ZERO, n.duration))
  const finalNotes: PerformedNote[] = []
  const rolls = new Map<number, number[]>()
  for (const n of notes) {
    const rollKey = drafts[n.index]!.spec.roll
    let arpeggio: number | undefined
    if (rollKey !== undefined) {
      let list = rolls.get(rollKey)
      if (!list) rolls.set(rollKey, (list = []))
      list.push(n.index)
      arpeggio = [...rolls.keys()].indexOf(rollKey)
    }
    finalNotes.push({
      ...n,
      soundingDuration: n.tieContinuation ? n.duration : (chainTotals.get(n.index) ?? n.duration),
      ...(arpeggio !== undefined ? { arpeggio } : {}),
    })
  }
  const arpeggios: ArpeggioGroup[] = [...rolls.values()].map((members, index) => {
    const ms = members.map((i) => finalNotes[i]!)
    const offsets = ms.map((m) => m.refOffsetSec)
    const first = ms[0]!
    return {
      index,
      at: first.onset,
      occ: first.occ,
      notes: members,
      direction: 'up',
      directionDefaulted: true,
      crossStaff: new Set(ms.map((m) => m.staff)).size > 1,
      spreadSec: Math.max(...offsets) - Math.min(...offsets),
    }
  })

  const voiceMap = new Map<string, { partId: string; voice: string; perStaff: Record<number, number>; hand: Hand }>()
  for (const n of finalNotes) {
    const k = `${n.partId}:${n.voice}`
    let v = voiceMap.get(k)
    if (!v) voiceMap.set(k, (v = { partId: n.partId, voice: n.voice, perStaff: {}, hand: n.hand }))
    v.perStaff[n.staff] = (v.perStaff[n.staff] ?? 0) + 1
  }
  const voices: VoiceDef[] = [...voiceMap].map(([key, v]) => ({
    key,
    partId: v.partId,
    voice: v.voice,
    notesPerStaff: v.perStaff,
  }))
  const byVoice: Record<string, Hand> = {}
  for (const [key, v] of voiceMap) byVoice[key] = v.hand

  const sourceNotes: SourceNote[] = finalNotes.map((n) => ({
    id: n.src,
    measure: n.occ,
    partId: n.partId,
    staff: n.staff,
    staffNumber: n.staffNumber,
    voice: n.voice,
    onsetInMeasure: n.onsetInMeasure,
    duration: n.duration,
    sounding: n.sounding,
    written: n.written,
    midi: n.midi,
    ottavaShift: n.ottavaShift,
    chord: false,
    tieStart: finalNotes.some((m) => m.tieHead === n.tieHead && m.index > n.index),
    tieStop: n.tieContinuation,
    grace: n.grace,
    cue: n.cue,
    accidentalContext: n.accidentalContext,
  }))

  return {
    format: SCORE_PACKAGE_FORMAT,
    scoreVersionId: spec.scoreVersionId ?? 'test-score-v1',
    meta: {
      title: 'Test score',
      musicXmlVersion: '4.0',
      packaging: 'musicxml',
      sourceFileName: 'test.musicxml',
      importerVersion: IMPORTER_VERSION,
      rollPolicyVersion: ROLL_POLICY_VERSION,
      importedAt: 0,
    },
    parts: [{ id: 'P1', name: 'Piano', staffCount: 2 }],
    staves: [
      { index: 0, partId: 'P1', staffNumber: 1 },
      { index: 1, partId: 'P1', staffNumber: 2 },
    ],
    voices,
    hands: {
      byVoice,
      ambiguousVoices: spec.ambiguousVoices ?? [],
      confirmed: spec.handsConfirmed ?? (spec.ambiguousVoices ?? []).length === 0,
    },
    sourceMeasures,
    sourceNotes,
    occurrences,
    notes: finalNotes,
    tempo: tempoMap(spec.tempo),
    keys: [{ at: ZERO, occ: 0, fifths: 0 }],
    meters: [{ at: ZERO, occ: 0, beats, beatType, beatsText: `${beats}` }],
    clefs: [
      { at: ZERO, occ: 0, staff: 0, clef: { sign: 'G', line: 2, octaveChange: 0 }, key: 'G2' },
      { at: ZERO, occ: 0, staff: 1, clef: { sign: 'F', line: 4, octaveChange: 0 }, key: 'F4' },
    ],
    ottavas: ottavas.map((o, i) => ({ ...o, notes: ottavaNotes[i]! })),
    pedals: (spec.pedals ?? []).map((m) => ({ ...m, at: pos(m.at), occ: occAt(pos(m.at)), kind: m.kind ?? 'sustain' })),
    dynamics: [],
    arpeggios,
    unsupported: spec.unsupported ?? [],
    timingIssues: (spec.timingIssues ?? []).map((t) => ({ ...t, at: pos(t.at) })),
    diagnostics: [],
    totalDuration,
  }
}

/** `n` quarters as whole notes (shorthand for expectations). */
export const quarters = (n: number): Rational => pos(n)

/** Sequenced human MIDI input, like the adapter's decoder (one monotonically increasing `seq`). */
export class MidiScript {
  #seq = 0
  readonly portId: string

  constructor(portId = 'test-in') {
    this.portId = portId
  }

  on(note: number, time: number, velocity = 80, channel = 0): MidiInputEvent {
    return { kind: 'noteon', seq: ++this.#seq, channel, note, velocity, time, portId: this.portId }
  }

  off(note: number, time: number, channel = 0): MidiInputEvent {
    return { kind: 'noteoff', seq: ++this.#seq, channel, note, velocity: 0, time, portId: this.portId }
  }

  cc(controller: number, value: number, time: number, channel = 0): MidiInputEvent {
    return { kind: 'cc', seq: ++this.#seq, channel, controller, value, time, portId: this.portId }
  }
}

/**
 * A minimal once-per-press pedal detector with the same shape as core/midi's
 * `HintPedalTrigger` (matches + feed), for engine tests.
 */
export function pedalDetector(
  controller: number,
  threshold = 64,
): { matches(ev: MidiInputEvent): boolean; feed(ev: MidiInputEvent): boolean } {
  let down = false
  return {
    matches: (ev) => ev.kind === 'cc' && ev.controller === controller,
    feed(ev) {
      if (ev.kind !== 'cc' || ev.controller !== controller) return false
      const pressed = ev.value >= threshold
      const fired = pressed && !down
      down = pressed
      return fired
    },
  }
}

/**
 * Drives a `PracticeEngine` with sequenced input on a manual clock and records every
 * drained event, for readable scenario tests.
 */
export class EngineDriver {
  readonly engine: PracticeEngine
  readonly midi = new MidiScript()
  readonly log: EngineEvent[] = []
  now: number
  #taken = 0

  constructor(timeline: Timeline, config: EngineConfig, now = 1000) {
    this.now = now
    this.engine = new PracticeEngine(timeline, config, now)
    this.flush()
  }

  get state(): EngineState {
    return this.engine.state
  }

  flush(): EngineEvent[] {
    const evs = this.engine.drainEvents()
    this.log.push(...evs)
    return evs
  }

  /** Events since the previous `take()` (or construction). */
  take(): EngineEvent[] {
    this.flush()
    const out = this.log.slice(this.#taken)
    this.#taken = this.log.length
    return out
  }

  /** Move the clock forward and let time-driven changes happen. */
  wait(ms: number): this {
    this.now += ms
    this.engine.tick(this.now)
    this.flush()
    return this
  }

  down(...notes: number[]): this {
    for (const n of notes) this.engine.input(this.midi.on(n, this.now))
    this.flush()
    return this
  }

  up(...notes: number[]): this {
    for (const n of notes) this.engine.input(this.midi.off(n, this.now))
    this.flush()
    return this
  }

  /** Press and release each note in turn. */
  tap(...notes: number[]): this {
    for (const n of notes) this.down(n).up(n)
    return this
  }

  cc(controller: number, value: number): this {
    this.engine.input(this.midi.cc(controller, value, this.now))
    this.flush()
    return this
  }

  of<T extends EngineEvent['type']>(type: T): Extract<EngineEvent, { type: T }>[] {
    this.flush()
    return this.log.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type)
  }

  records(): AttemptRecord[] {
    return this.of('attempt-ended').map((e) => e.record)
  }
}
