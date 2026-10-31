/**
 * Musical transport: one lookahead scheduler for Preview, accompaniment and the metronome
 * (spec "Listening and hand practice" and "Execution and rendering architecture").
 *
 * Musical time is a piecewise-linear map from clock milliseconds to seconds-at-1×
 * (`TempoIndex` converts those to positions). The speed multiplier scales the whole tempo map
 * and every reference offset.
 *
 * Learner gates (accompaniment): gate i is the position of learner onset group i. No attack,
 * pedal or click at or beyond the written position of an unreleased gate is handed out, even
 * inside the lookahead window: the automatic part at the learner's onset sounds with the
 * learner, not before. When musical time reaches a gate, `onGateReached(i)` is called and unless
 * the gate was already released the cursor holds there; notes already sounding still receive
 * their releases on schedule. Releasing a held gate re-anchors musical time at "now" at the gate
 * position, so the events written there (roll members with their offsets) are due at once and
 * go out in the same pass: no timer wait, no burst of later music, no replay. Releasing a gate
 * before musical time reaches it (an early press within the engine's grace) fast-forwards: the
 * gate position becomes "now", the music before it is handed out at once in order, the gate is
 * reached (reported once) and playback continues at tempo from there.
 *
 * Every event is handed to the backend at most once. Pause, stop and seek clear the queue
 * through the backend's cleanup; a live multiplier change takes effect after the events
 * already handed out, so attacks, releases and pedals stay in order.
 */
import { type Rational, cmp, gt, lt, toNumber } from '../music/rational'
import type { TempoMapData } from '../music/tempo'
import { isValidMultiplier } from '../music/tempo'
import { eventRank } from './performance'
import { TempoIndex } from './tempoIndex'
import {
  type ClickEvent,
  type Clock,
  type ControlEvent,
  type MetronomeSink,
  type NoteOffEvent,
  type NoteOnEvent,
  type OutputBackend,
  OutputLostError,
  type PerformanceEvent,
  type PerformanceRange,
  type TimerApi,
  browserTimers,
} from './types'

export type TransportState = 'stopped' | 'playing' | 'paused' | 'ended' | 'interrupted'

export type InterruptCause = 'disconnect' | 'error'

export interface MetronomeOptions {
  readonly sink: MetronomeSink
  readonly clicks: readonly ClickEvent[]
  /** Default true. */
  readonly enabled?: boolean
}

export interface TransportOptions {
  readonly clock: Clock
  readonly timers?: TimerApi
  readonly tempo: TempoMapData
  readonly multiplier: number
  readonly events: readonly PerformanceEvent[]
  /** Ascending learner onset positions (index = engine group index); null = no gates. */
  readonly gates: readonly Rational[] | null
  readonly range: PerformanceRange
  /** Null for a click-only transport (free-mode metronome). */
  readonly backend: OutputBackend | null
  /** How far ahead attacks, pedals and clicks are handed out. Default 100 ms. */
  readonly lookaheadMs?: number
  /** Overrides the backend's `offLookaheadMs`. */
  readonly offLookaheadMs?: number
  /** Longest sleep between scheduler wake-ups. Default 25 ms. */
  readonly tickMs?: number
  /** A wake-up later than this is a stall: musical time resumes where it stopped. Default 250 ms. */
  readonly stallMs?: number
  readonly metronome?: MetronomeOptions
  readonly onGateReached?: (gate: number) => void
  readonly onRangeEnd?: () => void
  /** Scheduling stopped because the backend failed; output cleanup could not be delivered. */
  readonly onInterrupted?: (cause: InterruptCause, error: unknown) => void
  /** Every event handed to the backend or metronome, with its scheduled time (highlights). */
  readonly onEmit?: (ev: NoteOnEvent | NoteOffEvent | ControlEvent | ClickEvent, time: number) => void
}

export interface Transport {
  readonly state: TransportState
  /** Gate the transport is holding at, or null. */
  readonly holdingGate: number | null
  readonly multiplier: number
  /** Start or resume. `at` (≤ now, e.g. the first key press timestamp) anchors musical time. */
  play(at?: number): void
  pause(): void
  /** Pause and return to the range start. */
  stop(): void
  /** Jump to a position (clamped to the range); gates before it count as passed. */
  seek(position: Rational): void
  setMultiplier(multiplier: number): void
  releaseGate(gate: number): void
  /** Float performance position for the cursor (never past an unreleased gate or the end). */
  positionNow(): number
  /**
   * Real milliseconds from `atTime` (performance.now() timebase, may lie slightly in the past)
   * until musical time reaches gate `gate` at the current tempo map × multiplier. 0 once the
   * transport has arrived at, is holding at, or has passed the gate; null when it cannot be
   * known: not playing, or an earlier unreleased gate will hold the transport first.
   * Read-only; O(log n) in the tempo map plus the few early-released gates before it.
   */
  msUntilGate(gate: number, atTime: number): number | null
  /**
   * Same for any performance position: 0 when musical time is already there; null when not
   * playing, beyond the range end, or behind an unreleased gate before `position`.
   */
  msUntilPosition(position: Rational, atTime: number): number | null
  setMetronomeEnabled(enabled: boolean): void
  /** Stop scheduling without output cleanup (destination lost); play() resumes later. */
  interrupt(): void
  /** Pause and run the backend's stuck-note recovery. */
  stopSound(): void
  dispose(): void
}

const EPS = 1e-9
const MIN_NOTE_MS = 1
const REACHED = 1
const RELEASED = 2

interface Attack {
  readonly ev: NoteOnEvent | ControlEvent | ClickEvent
  readonly s: number
  readonly rank: number
}

interface PendingOff {
  readonly ev: NoteOffEvent
  readonly s: number
  readonly onTime: number
}

/** One linear piece of the clock → musical-seconds map. */
interface Piece {
  readonly ms: number
  readonly sec: number
  readonly m: number
}

export function createTransport(options: TransportOptions): Transport {
  return new MusicalTransport(options)
}

class MusicalTransport implements Transport {
  private readonly clock: Clock
  private readonly timers: TimerApi
  private readonly index: TempoIndex
  private readonly backend: OutputBackend | null
  private readonly metronome: MetronomeOptions | undefined
  private readonly lookahead: number
  private readonly offLookahead: number
  private readonly tickMs: number
  private readonly stallMs: number
  private readonly opts: TransportOptions

  private readonly att: Attack[]
  private readonly attTime: Float64Array
  private readonly offByVoice = new Map<number, { ev: NoteOffEvent; s: number }>()
  private readonly gatePos: readonly Rational[]
  private readonly gateSec: Float64Array
  private readonly gateFlags: Uint8Array
  private readonly rangeStart: Rational
  private readonly rangeEnd: Rational
  private readonly sStart: number
  private readonly sEnd: number

  private ptr = 0
  private pending: PendingOff[] = []
  private nextGate = 0
  private holding: number | null = null
  private floor: Rational
  private pieces: Piece[] = []
  private m: number
  private pausedSec: number
  private stateValue: TransportState = 'stopped'
  private generation = 0
  private timer: unknown = null
  private expectedWake: number | null = null
  private inTick = false
  private again = false
  private clicksOn: boolean
  private disposed = false

  constructor(o: TransportOptions) {
    if (!isValidMultiplier(o.multiplier)) throw new RangeError(`Invalid speed multiplier ${o.multiplier}`)
    if (!lt(o.range.start, o.range.end)) throw new RangeError('Empty transport range')
    this.opts = o
    this.clock = o.clock
    this.timers = o.timers ?? browserTimers
    this.index = new TempoIndex(o.tempo)
    this.backend = o.backend
    this.metronome = o.metronome
    this.clicksOn = o.metronome?.enabled ?? true
    this.lookahead = o.lookaheadMs ?? 100
    this.offLookahead = Math.min(this.lookahead, o.offLookaheadMs ?? o.backend?.offLookaheadMs ?? 0)
    this.tickMs = o.tickMs ?? 25
    this.stallMs = o.stallMs ?? 250
    this.m = o.multiplier
    this.rangeStart = o.range.start
    this.rangeEnd = o.range.end
    this.floor = o.range.start
    this.sStart = this.index.sec(o.range.start)
    this.sEnd = this.index.sec(o.range.end)
    this.pausedSec = this.sStart

    const sOf = (ev: PerformanceEvent | ClickEvent): number => this.index.sec(ev.position) + ev.offsetSec
    const ons = new Set<number>()
    const attacks: Attack[] = []
    for (const ev of o.events) {
      if (ev.kind === 'off') {
        if (this.offByVoice.has(ev.voice)) throw new Error(`Duplicate note-off for voice ${ev.voice}`)
        this.offByVoice.set(ev.voice, { ev, s: sOf(ev) })
        continue
      }
      if (lt(ev.position, o.range.start)) continue
      const atEnd = !lt(ev.position, o.range.end)
      if (atEnd && (ev.kind === 'on' || gt(ev.position, o.range.end))) continue
      if (ev.kind === 'on') {
        if (ons.has(ev.voice)) throw new Error(`Duplicate note-on for voice ${ev.voice}`)
        ons.add(ev.voice)
      }
      attacks.push({ ev, s: sOf(ev), rank: eventRank(ev) })
    }
    for (const v of ons) if (!this.offByVoice.has(v)) throw new Error(`Note-on without note-off for voice ${v}`)
    for (const ev of o.metronome?.clicks ?? []) {
      if (lt(ev.position, o.range.start) || !lt(ev.position, o.range.end)) continue
      attacks.push({ ev, s: sOf(ev), rank: eventRank(ev) })
    }
    this.att = attacks.sort((a, b) => a.s - b.s || a.rank - b.rank)
    this.attTime = new Float64Array(this.att.length)

    const gates = o.gates ?? []
    for (let i = 0; i < gates.length; i++) {
      if (i > 0 && cmp(gates[i]!, gates[i - 1]!) <= 0) throw new RangeError('Gates must be strictly ascending')
      if (!lt(gates[i]!, o.range.end)) throw new RangeError('Gate at or beyond the range end')
    }
    this.gatePos = gates
    this.gateSec = Float64Array.from(gates, (g) => this.index.sec(g))
    this.gateFlags = new Uint8Array(gates.length)
    this.resetGates(o.range.start)
  }

  get state(): TransportState {
    return this.stateValue
  }

  get holdingGate(): number | null {
    return this.holding
  }

  get multiplier(): number {
    return this.m
  }

  play(at?: number): void {
    if (this.disposed || this.stateValue === 'playing') return
    if (this.stateValue === 'ended') this.moveTo(this.rangeStart)
    const now = this.clock()
    const t0 = at === undefined ? now : Math.min(now, Math.max(at, now - this.lookahead))
    this.pieces = [{ ms: t0, sec: this.pausedSec, m: this.m }]
    this.stateValue = 'playing'
    this.generation++
    this.tick()
  }

  pause(): void {
    if (this.stateValue !== 'playing') return
    const now = this.clock()
    this.pausedSec = this.clampedSec(now)
    this.halt()
    this.stateValue = 'paused'
    this.cleanupOutput(now)
  }

  stop(): void {
    if (this.disposed) return
    const wasPlaying = this.stateValue === 'playing'
    const now = this.clock()
    this.halt()
    const ok = !wasPlaying || this.cleanupOutput(now)
    this.moveTo(this.rangeStart)
    if (ok) this.stateValue = 'stopped'
  }

  seek(position: Rational): void {
    if (this.disposed) return
    const pos = lt(position, this.rangeStart) ? this.rangeStart : gt(position, this.rangeEnd) ? this.rangeEnd : position
    const wasPlaying = this.stateValue === 'playing'
    const now = this.clock()
    this.halt()
    const ok = !wasPlaying || this.cleanupOutput(now)
    this.moveTo(pos)
    if (wasPlaying && ok) {
      this.pieces = [{ ms: now, sec: this.pausedSec, m: this.m }]
      this.stateValue = 'playing'
      this.tick()
    } else if (this.stateValue !== 'interrupted') {
      this.stateValue = 'paused'
    }
  }

  setMultiplier(multiplier: number): void {
    if (!isValidMultiplier(multiplier)) throw new RangeError(`Invalid speed multiplier ${multiplier}`)
    if (multiplier === this.m) return
    this.m = multiplier
    if (this.stateValue !== 'playing') return
    const now = this.clock()
    // Already handed-out events keep their times; the new speed starts after the last of them.
    let from = now
    if (this.ptr > 0 && this.attTime[this.ptr - 1]! > now) from = this.attTime[this.ptr - 1]!
    const last = this.pieces[this.pieces.length - 1]!
    if (from <= last.ms) {
      this.pieces[this.pieces.length - 1] = { ms: last.ms, sec: last.sec, m: multiplier }
    } else {
      this.pieces.push({ ms: from, sec: this.secAt(from), m: multiplier })
    }
    if (!this.inTick) this.reschedule(now)
  }

  releaseGate(gate: number): void {
    if (gate < 0 || gate >= this.gateFlags.length || this.disposed) return
    const early = this.stateValue === 'playing' && !(this.gateFlags[gate]! & REACHED) && this.blockingGate() === gate
    this.gateFlags[gate]! |= RELEASED
    if (early) {
      // Fast-forward: the gate position is now (the music before it goes out at once, in order).
      const now = this.clock()
      if (this.secAt(now) < this.gateSec[gate]! - EPS) this.pieces = [{ ms: now, sec: this.gateSec[gate]!, m: this.m }]
    } else if (this.holding === gate) {
      this.holding = null
      if (this.stateValue === 'playing') {
        this.pieces = [{ ms: this.clock(), sec: this.gateSec[gate]!, m: this.m }]
      } else {
        this.pausedSec = this.gateSec[gate]!
      }
    }
    if (this.stateValue === 'playing') this.tick()
  }

  positionNow(): number {
    if (this.stateValue !== 'playing') return this.index.pos(this.pausedSec)
    const now = this.clock()
    const b = this.blockingGate()
    const s = this.secAt(now)
    if (b >= 0 && s >= this.gateSec[b]! - EPS) return toNumber(this.gatePos[b]!)
    if (s >= this.sEnd) return toNumber(this.rangeEnd)
    return this.index.pos(s)
  }

  msUntilGate(gate: number, atTime: number): number | null {
    if (!Number.isInteger(gate) || gate < 0 || gate >= this.gateFlags.length) return null
    if (this.gateFlags[gate]! & REACHED) return 0
    if (this.stateValue !== 'playing') return null
    const b = this.blockingGate()
    if (b >= 0 && b < gate) return null
    return this.msUntilSec(this.gateSec[gate]!, atTime)
  }

  msUntilPosition(position: Rational, atTime: number): number | null {
    if (this.stateValue !== 'playing' || gt(position, this.rangeEnd)) return null
    const s = this.index.sec(position)
    if (s <= this.clampedSec(this.clock()) + EPS) return 0
    const b = this.blockingGate()
    if (b >= 0 && lt(this.gatePos[b]!, position)) return null
    return this.msUntilSec(s, atTime)
  }

  setMetronomeEnabled(enabled: boolean): void {
    this.clicksOn = enabled
    if (!enabled) this.metronome?.sink.cancel(this.clock())
  }

  interrupt(): void {
    if (this.stateValue !== 'playing' && this.stateValue !== 'paused') return
    if (this.stateValue === 'playing') this.pausedSec = this.clampedSec(this.clock())
    this.halt()
    this.unemit(this.clock())
    this.stateValue = 'interrupted'
  }

  stopSound(): void {
    if (this.disposed) return
    const now = this.clock()
    if (this.stateValue === 'playing') {
      this.pausedSec = this.clampedSec(now)
      this.halt()
      this.stateValue = 'paused'
      this.unemit(now)
    }
    this.metronome?.sink.cancel(now)
    this.guard(() => this.backend?.stopSound(now))
  }

  dispose(): void {
    if (this.disposed) return
    if (this.stateValue === 'playing') this.pause()
    this.halt()
    this.disposed = true
    this.stateValue = 'stopped'
  }

  // --- time mapping -------------------------------------------------------------------

  /** Musical seconds at 1× for clock time t (keeps running while holding at a gate). */
  private secAt(t: number): number {
    const ps = this.pieces
    let p = ps[0]!
    for (let i = 1; i < ps.length && ps[i]!.ms <= t; i++) p = ps[i]!
    return p.sec + ((t - p.ms) * p.m) / 1000
  }

  /** Clock time at which musical seconds s are reached. */
  private timeAt(s: number): number {
    const ps = this.pieces
    let p = ps[0]!
    for (let i = 1; i < ps.length && ps[i]!.sec <= s; i++) p = ps[i]!
    return p.ms + ((s - p.sec) * 1000) / p.m
  }

  private msUntilSec(s: number, atTime: number): number {
    if (this.secAt(this.clock()) >= s - EPS) return 0
    return Math.max(0, this.timeAt(s) - atTime)
  }

  /** Position seconds at clock time t, clamped at the blocking gate and the range end. */
  private clampedSec(t: number): number {
    let s = this.secAt(t)
    const b = this.blockingGate()
    if (b >= 0) s = Math.min(s, this.gateSec[b]!)
    return Math.max(this.sStart, Math.min(s, this.sEnd))
  }

  // --- gates --------------------------------------------------------------------------

  /** The gate that currently blocks later written positions, or -1. */
  private blockingGate(): number {
    if (this.holding !== null) return this.holding
    for (let k = this.nextGate; k < this.gateFlags.length; k++) {
      if (!(this.gateFlags[k]! & RELEASED)) return k
    }
    return -1
  }

  private resetGates(pos: Rational): void {
    this.nextGate = this.gateFlags.length
    for (let i = 0; i < this.gateFlags.length; i++) {
      if (lt(this.gatePos[i]!, pos)) this.gateFlags[i] = REACHED | RELEASED
      else {
        this.gateFlags[i] = 0
        if (this.nextGate === this.gateFlags.length) this.nextGate = i
      }
    }
    this.holding = null
  }

  // --- scheduling ---------------------------------------------------------------------

  /** Reset queues and gates to a position (no output). */
  private moveTo(pos: Rational): void {
    const s = this.index.sec(pos)
    this.pausedSec = s
    this.floor = pos
    let lo = 0
    let hi = this.att.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.att[mid]!.s < s - EPS) lo = mid + 1
      else hi = mid
    }
    this.ptr = lo
    this.pending = []
    this.resetGates(pos)
  }

  private halt(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    this.expectedWake = null
    this.generation++
  }

  /** Forget events handed out for times after `now` (their output was canceled). */
  private unemit(now: number): void {
    while (this.ptr > 0 && this.attTime[this.ptr - 1]! > now) this.ptr--
    this.pending = []
  }

  private cleanupOutput(now: number): boolean {
    this.unemit(now)
    this.metronome?.sink.cancel(now)
    return this.guard(() => this.backend?.cleanup(now))
  }

  /** Run scheduler passes; re-entrant calls from callbacks request another pass. */
  private tick(fromTimer = false): void {
    if (this.inTick) {
      this.again = true
      return
    }
    this.inTick = true
    try {
      let timed = fromTimer
      do {
        this.again = false
        if (this.stateValue !== 'playing') break
        this.step(timed)
        timed = false
      } while (this.again)
    } finally {
      this.inTick = false
    }
  }

  private step(fromTimer: boolean): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    const now = this.clock()
    if (fromTimer && this.expectedWake !== null && now - this.expectedWake > this.stallMs) {
      const late = now - this.expectedWake
      this.pieces = this.pieces.map((p) => ({ ...p, ms: p.ms + late }))
    }
    this.expectedWake = null
    const gen = this.generation
    for (;;) {
      while (this.pieces.length > 1 && this.pieces[1]!.ms <= now) this.pieces.shift()
      if (!this.emitDue(now) || gen !== this.generation) return
      if (this.holding === null && this.nextGate < this.gateFlags.length) {
        const g = this.nextGate
        if (this.secAt(now) >= this.gateSec[g]! - EPS) {
          this.gateFlags[g]! |= REACHED
          this.nextGate++
          if (!(this.gateFlags[g]! & RELEASED)) this.holding = g
          this.opts.onGateReached?.(g)
          if (gen !== this.generation || this.stateValue !== 'playing') return
          continue
        }
      }
      if (this.holding === null && this.nextGate >= this.gateFlags.length && this.secAt(now) >= this.sEnd - EPS) {
        this.finish(now)
        return
      }
      break
    }
    this.reschedule(now)
  }

  /** Hand out every due attack and release in time order. False when the backend failed. */
  private emitDue(now: number): boolean {
    const attHorizon = now + this.lookahead
    const offHorizon = now + this.offLookahead
    const b = this.blockingGate()
    const block = b >= 0 ? this.gatePos[b]! : null
    for (;;) {
      // Attacks keep their order even when a fast-forward maps unsent ones before sent ones.
      const after = this.ptr > 0 ? this.attTime[this.ptr - 1]! : Number.NEGATIVE_INFINITY
      let a: Attack | null = null
      let at = Number.POSITIVE_INFINITY
      while (this.ptr < this.att.length) {
        const c = this.att[this.ptr]!
        if (lt(c.ev.position, this.floor)) {
          this.attTime[this.ptr] = Number.NEGATIVE_INFINITY
          this.ptr++
          continue
        }
        if (block && !lt(c.ev.position, block)) break
        const t = this.timeAt(c.s)
        if (t <= attHorizon) {
          a = c
          at = t
        }
        break
      }
      let oi = -1
      let ot = Number.POSITIVE_INFINITY
      for (let i = 0; i < this.pending.length; i++) {
        const p = this.pending[i]!
        const t = Math.max(this.timeAt(p.s), p.onTime + MIN_NOTE_MS)
        if (t <= offHorizon && t < ot) {
          ot = t
          oi = i
        }
      }
      if (a === null && oi < 0) return true
      const ok =
        oi >= 0 && ot <= at
          ? this.deliverOff(this.pending.splice(oi, 1)[0]!, Math.max(ot, now))
          : this.deliverAttack(a!, Math.max(at, now, after))
      if (!ok) return false
    }
  }

  private deliverAttack(a: Attack, time: number): boolean {
    const ev = a.ev
    const backend = this.backend
    let ok = true
    if (ev.kind === 'click') {
      const sink = this.clicksOn ? this.metronome?.sink : undefined
      if (sink) ok = this.guard(() => sink.click(time, ev.accent))
    } else if (backend) {
      ok =
        ev.kind === 'on'
          ? this.guard(() => backend.noteOn(ev.note, ev.velocity, time))
          : this.guard(() => backend.controlChange(ev.controller, ev.value, time))
    }
    if (!ok) return false
    this.attTime[this.ptr] = time
    this.ptr++
    if (ev.kind === 'on' && backend) {
      const off = this.offByVoice.get(ev.voice)!
      this.pending.push({ ev: off.ev, s: off.s, onTime: time })
    }
    if (ev.kind !== 'click' ? backend !== null : this.clicksOn && this.metronome !== undefined) {
      this.opts.onEmit?.(ev, time)
    }
    return true
  }

  private deliverOff(p: PendingOff, time: number): boolean {
    const backend = this.backend
    if (backend && !this.guard(() => backend.noteOff(p.ev.note, time))) return false
    this.opts.onEmit?.(p.ev, time)
    return true
  }

  private finish(now: number): void {
    const rest = this.pending
      .map((p) => ({ p, t: Math.max(this.timeAt(p.s), p.onTime + MIN_NOTE_MS, now) }))
      .sort((x, y) => x.t - y.t)
    this.pending = []
    for (const { p, t } of rest) if (!this.deliverOff(p, t)) return
    this.halt()
    this.pausedSec = this.sEnd
    this.stateValue = 'ended'
    this.opts.onRangeEnd?.()
  }

  private reschedule(now: number): void {
    if (this.stateValue !== 'playing') return
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    let wake = now + this.tickMs
    const b = this.blockingGate()
    const block = b >= 0 ? this.gatePos[b]! : null
    for (let i = this.ptr; i < this.att.length; i++) {
      const c = this.att[i]!
      if (lt(c.ev.position, this.floor)) continue
      if (!block || lt(c.ev.position, block)) wake = Math.min(wake, this.timeAt(c.s) - this.lookahead)
      break
    }
    for (const p of this.pending) {
      wake = Math.min(wake, Math.max(this.timeAt(p.s), p.onTime + MIN_NOTE_MS) - this.offLookahead)
    }
    if (this.holding === null && this.nextGate < this.gateFlags.length) {
      wake = Math.min(wake, this.timeAt(this.gateSec[this.nextGate]!))
    } else if (this.holding === null) {
      wake = Math.min(wake, this.timeAt(this.sEnd))
    }
    const delay = Math.max(1, Math.ceil(wake - now))
    this.expectedWake = now + delay
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.tick(true)
    }, delay)
  }

  /** Run a backend call; on failure stop scheduling and report. */
  private guard(fn: () => void): boolean {
    try {
      fn()
      return true
    } catch (error) {
      const cause: InterruptCause = error instanceof OutputLostError ? 'disconnect' : 'error'
      const now = this.clock()
      if (this.stateValue === 'playing') this.pausedSec = this.clampedSec(now)
      this.halt()
      this.unemit(now)
      this.stateValue = 'interrupted'
      this.opts.onInterrupted?.(cause, error)
      return false
    }
  }
}
