/**
 * Builders and fakes for playback tests: hand-made score models (the importer is not used),
 * a manual clock with injectable timers, and a recording output backend.
 * Not imported by application code.
 */
import { type Rational, ZERO, add, cmp, eq, mul, parseKey, rat, sub } from '../music/rational'
import { STEP_SEMITONES, type Spelling } from '../music/pitch'
import { type TempoMapData, QUARTER, userTempoMap } from '../music/tempo'
import {
  type Hand,
  type MeasureOccurrence,
  type PedalMark,
  type PerformedNote,
  type ScoreModel,
  type SourceMeasure,
  IMPORTER_VERSION,
  ROLL_POLICY_VERSION,
  SCORE_PACKAGE_FORMAT,
} from '../model/score'
import type { Clock, OutputBackend, TimerApi } from './types'

export type RationalLike = Rational | string

export const r = (x: RationalLike): Rational => (typeof x === 'string' ? parseKey(x) : x)

export interface NoteSpec {
  /** Performance onset, e.g. '1/4'. */
  readonly at: RationalLike
  readonly dur: RationalLike
  readonly midi: number
  readonly hand?: Hand
  readonly voice?: string
  readonly velocity?: number
  readonly refOffsetSec?: number
  /** Tie into the next note of the same pitch and voice that starts where this one ends. */
  readonly tieToNext?: boolean
  readonly grace?: boolean
  readonly cue?: boolean
}

export interface PedalSpec {
  readonly at: RationalLike
  readonly kind?: PedalMark['kind']
  readonly type: PedalMark['type']
  readonly value?: number
}

export interface ModelSpec {
  readonly notes: readonly NoteSpec[]
  /** Minimum number of bars (more are added to cover every note). */
  readonly measures?: number
  readonly beats?: number
  readonly beatType?: number
  /** Duration of a first, implicit (pickup) bar. */
  readonly pickup?: RationalLike
  /** Default: quarter = 60, so a quarter lasts 1 s and a 4/4 bar 4 s at 1×. */
  readonly tempo?: TempoMapData
  readonly pedals?: readonly PedalSpec[]
}

const PC_SPELL: ReadonlyArray<readonly [Spelling['step'], number]> = [
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

export function spell(midi: number): Spelling {
  const [step, alter] = PC_SPELL[((midi % 12) + 12) % 12]!
  const octave = Math.floor((midi - STEP_SEMITONES[step] - alter) / 12) - 1
  return { step, alter, octave }
}

/** Build a minimal but contract-complete ScoreModel from note specs (sorted and tie-linked). */
export function makeModel(spec: ModelSpec): ScoreModel {
  const beats = spec.beats ?? 4
  const beatType = spec.beatType ?? 4
  const bar = rat(beats, beatType)
  const pickup = spec.pickup !== undefined ? r(spec.pickup) : null

  let lastEnd = ZERO
  for (const n of spec.notes) {
    const end = add(r(n.at), r(n.dur))
    if (cmp(end, lastEnd) > 0) lastEnd = end
  }
  const sourceMeasures: SourceMeasure[] = []
  const occurrences: MeasureOccurrence[] = []
  let pos = ZERO
  const minBars = spec.measures ?? 1
  for (let i = 0; i < minBars || cmp(pos, lastEnd) < 0; i++) {
    const duration = i === 0 && pickup ? pickup : bar
    sourceMeasures.push({
      index: i,
      number: pickup ? `${i}` : `${i + 1}`,
      implicit: i === 0 && pickup !== null,
      nominalDuration: bar,
      duration,
    })
    occurrences.push({ index: i, sourceMeasure: i, number: sourceMeasures[i]!.number, pass: 1, start: pos, duration })
    pos = add(pos, duration)
  }
  const occAt = (p: Rational): number => {
    let k = 0
    for (const o of occurrences) if (cmp(o.start, p) <= 0) k = o.index
    return k
  }

  const sorted = spec.notes
    .map((n, src) => ({ n, src, at: r(n.at), dur: r(n.dur) }))
    .sort((a, b) => cmp(a.at, b.at) || a.n.midi - b.n.midi || a.src - b.src)

  const head = sorted.map((_, i) => i)
  const sounding = sorted.map((x) => x.dur)
  const continuation = sorted.map(() => false)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    if (!a.n.tieToNext) continue
    const end = add(a.at, a.dur)
    const j = sorted.findIndex(
      (b, k) => k > i && b.n.midi === a.n.midi && (b.n.voice ?? '1') === (a.n.voice ?? '1') && eq(b.at, end),
    )
    if (j < 0) throw new Error(`tieToNext without a continuation for note ${a.src}`)
    continuation[j] = true
    head[j] = head[i]!
    sounding[head[i]!] = add(sounding[head[i]!]!, sorted[j]!.dur)
  }

  const notes: PerformedNote[] = sorted.map((x, index) => {
    const occ = occAt(x.at)
    const sp = spell(x.n.midi)
    const hand = x.n.hand ?? 'R'
    return {
      index,
      id: `${occ}:${x.src}`,
      src: x.src,
      occ,
      onset: x.at,
      duration: x.dur,
      soundingDuration: continuation[index] ? x.dur : sounding[index]!,
      staff: hand === 'R' ? 0 : 1,
      staffNumber: hand === 'R' ? 1 : 2,
      partId: 'P1',
      voice: x.n.voice ?? (hand === 'R' ? '1' : '5'),
      hand,
      midi: x.n.midi,
      sounding: sp,
      written: sp,
      ottavaShift: 0,
      clef: hand === 'R' ? 'G2' : 'F4',
      tieContinuation: continuation[index]!,
      tieHead: head[index]!,
      refOffsetSec: x.n.refOffsetSec ?? 0,
      velocity: x.n.velocity ?? 80,
      grace: x.n.grace ?? false,
      cue: x.n.cue ?? false,
      onsetInMeasure: sub(x.at, occurrences[occ]!.start),
      accidentalContext: { keyFifths: 0, carried: [] },
    }
  })

  const pedals: PedalMark[] = (spec.pedals ?? []).map((p) => ({
    at: r(p.at),
    occ: occAt(r(p.at)),
    kind: p.kind ?? 'sustain',
    type: p.type,
    ...(p.value !== undefined ? { value: p.value } : {}),
  }))

  return {
    format: SCORE_PACKAGE_FORMAT,
    scoreVersionId: 'test',
    meta: {
      title: 'Test',
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
    voices: [],
    hands: { byVoice: {}, ambiguousVoices: [], confirmed: true },
    sourceMeasures,
    sourceNotes: [],
    occurrences,
    notes,
    tempo: spec.tempo ?? userTempoMap(60, QUARTER),
    keys: [{ at: ZERO, occ: 0, fifths: 0 }],
    meters: [{ at: ZERO, occ: 0, beats, beatType, beatsText: `${beats}` }],
    clefs: [],
    ottavas: [],
    pedals,
    dynamics: [],
    arpeggios: [],
    unsupported: [],
    timingIssues: [],
    diagnostics: [],
    totalDuration: pos,
  }
}

/** n quarter notes as a Rational ('q(3)' = 3/4). */
export const q = (n: number): Rational => mul(rat(n), QUARTER)

/** Manual clock + timers: `advance` fires due timers in time order, each at its own due time. */
export class ManualClock implements TimerApi {
  now = 0
  private nextId = 1
  private readonly timers: Array<{ id: number; at: number; fn: () => void }> = []

  readonly clock: Clock = () => this.now

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.timers.push({ id, at: this.now + Math.max(0, ms), fn })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    const i = this.timers.findIndex((t) => t.id === handle)
    if (i >= 0) this.timers.splice(i, 1)
  }

  get pendingTimers(): number {
    return this.timers.length
  }

  advanceTo(t: number): void {
    for (;;) {
      let best = -1
      for (let i = 0; i < this.timers.length; i++) {
        const c = this.timers[i]!
        if (c.at <= t && (best < 0 || c.at < this.timers[best]!.at)) best = i
      }
      if (best < 0) break
      const [timer] = this.timers.splice(best, 1)
      this.now = Math.max(this.now, timer!.at)
      timer!.fn()
    }
    this.now = Math.max(this.now, t)
  }

  advance(ms: number): void {
    this.advanceTo(this.now + ms)
  }
}

export type BackendCall =
  | { readonly op: 'on'; readonly note: number; readonly velocity: number; readonly time: number; readonly at: number }
  | { readonly op: 'off'; readonly note: number; readonly time: number; readonly at: number }
  | {
      readonly op: 'cc'
      readonly controller: number
      readonly value: number
      readonly time: number
      readonly at: number
    }
  | { readonly op: 'cleanup' | 'stopSound'; readonly time: number; readonly at: number }

/**
 * Records every backend call with the clock time it was made (`at`) and the scheduled time.
 * `failAfter` makes later calls throw, simulating a lost destination.
 */
export class RecordingBackend implements OutputBackend {
  readonly kind = 'midi' as const
  readonly calls: BackendCall[] = []
  failWith: Error | null = null

  constructor(
    private readonly clock: Clock,
    readonly offLookaheadMs = 0,
  ) {}

  noteOn(note: number, velocity: number, time: number): void {
    this.check()
    this.calls.push({ op: 'on', note, velocity, time, at: this.clock() })
  }
  noteOff(note: number, time: number): void {
    this.check()
    this.calls.push({ op: 'off', note, time, at: this.clock() })
  }
  controlChange(controller: number, value: number, time: number): void {
    this.check()
    this.calls.push({ op: 'cc', controller, value, time, at: this.clock() })
  }
  cleanup(now: number): void {
    this.calls.push({ op: 'cleanup', time: now, at: this.clock() })
  }
  stopSound(now: number): void {
    this.calls.push({ op: 'stopSound', time: now, at: this.clock() })
  }

  ons(): Array<Extract<BackendCall, { op: 'on' }>> {
    return this.calls.filter((c): c is Extract<BackendCall, { op: 'on' }> => c.op === 'on')
  }
  offs(): Array<Extract<BackendCall, { op: 'off' }>> {
    return this.calls.filter((c): c is Extract<BackendCall, { op: 'off' }> => c.op === 'off')
  }
  ccs(): Array<Extract<BackendCall, { op: 'cc' }>> {
    return this.calls.filter((c): c is Extract<BackendCall, { op: 'cc' }> => c.op === 'cc')
  }

  private check(): void {
    if (this.failWith) throw this.failWith
  }
}

/** Seconds → ms helper for readable expectations. */
export const ms = (sec: number): number => sec * 1000
