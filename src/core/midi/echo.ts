/**
 * Output echo test (spec "MIDI input, output, and pedal controls": keep keyboard input and
 * automatic output separate; if returned playback cannot be distinguished from human input,
 * disable graded accompaniment for that routing).
 *
 * The app plays a short, distinctive probe (three pitches with unusual velocities) on the
 * selected output channel while the user keeps their hands off the keys, and watches the
 * input for those notes coming back. The same probe is the Connection view's "Play test
 * notes": one tap confirms that the piano sounds and checks the route for echo (DECISIONS C11). The detector only observes: every input event still
 * reaches its other subscribers (the live key test), so genuine human presses are never
 * discarded. It classifies the route and is never used to filter live input — standard MIDI
 * carries no application-origin tag. A single returned pitch with a different velocity could be
 * a human press, so it yields 'inconclusive' (repeat the test) rather than a verdict.
 */
import { noteOffBytes, noteOnBytes } from './decode'
import type { MidiRouteSettings } from '../model/settings'
import type { MidiInputEvent } from './types'

export type EchoVerdict = 'none' | 'echo-detected' | 'inconclusive'

export interface EchoProbeNote {
  readonly note: number
  readonly velocity: number
  /** Delay after the test start. */
  readonly offsetMs: number
  readonly durationMs: number
}

/** C♯4 – F♯4 – A♯4 at velocities a player is unlikely to reproduce by accident. */
export const DEFAULT_PROBE: readonly EchoProbeNote[] = [
  { note: 61, velocity: 37, offsetMs: 0, durationMs: 160 },
  { note: 66, velocity: 83, offsetMs: 220, durationMs: 160 },
  { note: 70, velocity: 59, offsetMs: 440, durationMs: 160 },
]

export interface EchoTestOptions {
  /** 0-based output channel under test. */
  readonly channel: number
  readonly probe?: readonly EchoProbeNote[]
  /** How long after each probe attack a returning note is attributed to it. Default 1000 ms. */
  readonly windowMs?: number
}

export interface EchoTestResult {
  readonly verdict: EchoVerdict
  /** Probe notes that came back (by pitch, any channel). */
  readonly returned: number
  /** A returned note-on matched pitch, channel and velocity exactly (MIDI thru). */
  readonly exactMatch: boolean
  /** Probe send → first returned note, ms. */
  readonly latencyMs: number | null
  /** Other keys arrived during the test: ask the user to repeat it without touching the keys. */
  readonly otherInput: boolean
}

export interface ScheduledMessage {
  readonly data: number[]
  readonly time: number
}

/** Pure detector: call `begin`, send `messages`, feed every input event, then read `result`. */
export class EchoDetector {
  readonly channel: number
  readonly probe: readonly EchoProbeNote[]
  readonly windowMs: number
  private startedAt = Number.NaN
  private readonly returnedAt: Array<number | null>
  private exact = false
  private other = false

  constructor(opts: EchoTestOptions) {
    this.channel = opts.channel
    this.probe = opts.probe ?? DEFAULT_PROBE
    if (this.probe.length === 0) throw new RangeError('Echo probe needs at least one note')
    this.windowMs = opts.windowMs ?? 1000
    this.returnedAt = this.probe.map(() => null)
  }

  /** Total test duration after `begin` (last attack + window). */
  get durationMs(): number {
    return Math.max(...this.probe.map((p) => p.offsetMs + Math.max(p.durationMs, this.windowMs)))
  }

  /** Probe messages with performance.now()-timebase timestamps. */
  messages(now: number): ScheduledMessage[] {
    const out: ScheduledMessage[] = []
    for (const p of this.probe) {
      out.push({ data: noteOnBytes(this.channel, p.note, p.velocity), time: now + p.offsetMs })
      out.push({ data: noteOffBytes(this.channel, p.note), time: now + p.offsetMs + p.durationMs })
    }
    return out.sort((a, b) => a.time - b.time)
  }

  begin(now: number): void {
    this.startedAt = now
    this.returnedAt.fill(null)
    this.exact = false
    this.other = false
  }

  feed(ev: MidiInputEvent): void {
    if (Number.isNaN(this.startedAt) || ev.kind !== 'noteon') return
    const i = this.probe.findIndex((p) => p.note === ev.note)
    const p = this.probe[i]
    if (p) {
      const sent = this.startedAt + p.offsetMs
      if (ev.time >= sent - 5 && ev.time <= sent + this.windowMs && this.returnedAt[i] === null) {
        this.returnedAt[i] = Math.max(0, ev.time - sent)
        if (ev.channel === this.channel && ev.velocity === p.velocity) this.exact = true
        return
      }
    }
    if (ev.time >= this.startedAt - 5 && ev.time <= this.startedAt + this.durationMs) this.other = true
  }

  result(): EchoTestResult {
    const back = this.returnedAt.filter((x): x is number => x !== null)
    const returned = back.length
    const verdict: EchoVerdict =
      returned === 0 ? 'none' : returned >= 2 || this.exact ? 'echo-detected' : 'inconclusive'
    return {
      verdict,
      returned,
      exactMatch: this.exact,
      latencyMs: returned > 0 ? Math.min(...back) : null,
      otherInput: this.other,
    }
  }
}

/** Route setting for a verdict; null = keep the previous value (inconclusive). */
export function echoSetting(verdict: EchoVerdict): MidiRouteSettings['echo'] | null {
  return verdict === 'inconclusive' ? null : verdict
}

export interface EchoTestIo {
  send(data: number[], timestamp?: number): void
  subscribe(fn: (ev: MidiInputEvent) => void): () => void
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
}

/**
 * Run the echo test end to end: send the probe, watch the input, resolve after the window. The
 * probe doubles as the Connection view's audible test notes, so the promise rejects when the
 * output refuses a message (it may have just disconnected) and nothing was played.
 */
export function runEchoTest(io: EchoTestIo, opts: EchoTestOptions): Promise<EchoTestResult> {
  const det = new EchoDetector(opts)
  return new Promise((resolve, reject) => {
    const unsubscribe = io.subscribe((ev) => det.feed(ev))
    const now = io.now()
    det.begin(now)
    try {
      for (const m of det.messages(now)) io.send(m.data, m.time)
    } catch (error) {
      unsubscribe()
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    io.setTimeout(() => {
      unsubscribe()
      resolve(det.result())
    }, det.durationMs)
  })
}
