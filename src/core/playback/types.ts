/**
 * Playback data and backend interfaces shared by the performance builder, the musical
 * transport and the output backends (spec "Listening and hand practice" and the scheduler
 * paragraph of "Execution and rendering architecture": one musical scheduler with separate
 * MIDI-output and browser-audio backends).
 *
 * Times handed to backends are milliseconds in the `performance.now()` timebase, the same
 * timebase as Web MIDI timestamps and MIDI input events.
 */
import type { Rational } from '../music/rational'
import type { Hand } from '../model/score'

/** Performance-position range [start, end) in whole notes from the unfolded performance start. */
export interface PerformanceRange {
  readonly start: Rational
  readonly end: Rational
}

interface EventBase {
  /** Written performance position (whole notes). Gates compare against this, never against offsets. */
  readonly position: Rational
  /**
   * Reference offset after `position`, in seconds at 1× (roll members, pedal re-press after a
   * change). Scaled by 1/multiplier at runtime; never moves the written position.
   */
  readonly offsetSec: number
}

export interface NoteOnEvent extends EventBase {
  readonly kind: 'on'
  readonly note: number
  /** 1..127, already scaled by the accompaniment level. */
  readonly velocity: number
  /** Pairs this attack with exactly one 'off' event; unique within one performance. */
  readonly voice: number
  readonly hand: Hand
  /** Performed note indices sounded by this attack (several after a unison merge). */
  readonly notes: readonly number[]
}

export interface NoteOffEvent extends EventBase {
  readonly kind: 'off'
  readonly note: number
  readonly voice: number
}

export interface ControlEvent extends EventBase {
  readonly kind: 'cc'
  readonly controller: number
  readonly value: number
}

export type PerformanceEvent = NoteOnEvent | NoteOffEvent | ControlEvent

/** Metronome click at a beat position (accent = first beat of a full bar). */
export interface ClickEvent extends EventBase {
  readonly kind: 'click'
  readonly accent: boolean
}

/**
 * Sound destination for app-generated playback. Implementations track app-owned notes and
 * pedals so cleanup releases exactly what the app started (spec "MIDI input, output, and
 * pedal controls": on Pause, Stop, seeking, mode changes or suspension, clear unsent output,
 * release tracked notes and app-owned pedals; Stop sound for stuck-note recovery).
 */
export interface OutputBackend {
  readonly kind: 'midi' | 'browser'
  /**
   * How far ahead of their due time note-offs may be handed over. MIDI uses 0 so the
   * human-held guard is evaluated when the release is due; browser audio accepts the full
   * lookahead. Omitted = 0.
   */
  readonly offLookaheadMs?: number
  noteOn(note: number, velocity: number, time: number): void
  noteOff(note: number, time: number): void
  controlChange(controller: number, value: number, time: number): void
  /** Cancel queued output, release app-owned notes and pedals (pause/stop/seek/mode change). */
  cleanup(now: number): void
  /** Stuck-note recovery: full cleanup of the app's own route. */
  stopSound(now: number): void
}

/** Metronome sound destination (Web Audio click), scheduled by the same transport. */
export interface MetronomeSink {
  click(time: number, accent: boolean): void
  /** Drop clicks scheduled after `now`. */
  cancel(now: number): void
}

/** Injectable timers (core logic never reads clocks or timers directly). */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Milliseconds in the performance.now() timebase. */
export type Clock = () => number

/** The destination disappeared (port disconnected, context closed); cleanup cannot be delivered. */
export class OutputLostError extends Error {
  override readonly name = 'OutputLostError'
  constructor(cause?: unknown) {
    super('The playback destination is no longer available', cause === undefined ? undefined : { cause })
  }
}

/** Global timers, for production wiring. */
export const browserTimers: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
}
