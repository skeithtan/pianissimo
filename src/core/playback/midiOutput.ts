/**
 * MIDI output backend: app playback to the connected piano through `MIDIOutput.send` with
 * performance.now()-timebase timestamps (spec "MIDI input, output, and pedal controls").
 *
 * - Ownership: per (channel, note) counts, so overlapping same-pitch app notes never release
 *   early — a note-off is sent only when the last overlapping app note ends.
 * - Human-held guard: an app note-off for a pitch the human currently holds on the same
 *   channel is deferred until the human releases it, so app releases never cut a human-held
 *   note. Feed every human input event to `humanInput`. Disable the guard (`humanGuard: false`)
 *   on routes whose output echoes back to the input: echoed notes would look human-held.
 * - Cleanup (pause/stop/seek/mode change): `clear()` when the output supports it, explicit
 *   note-offs for app-owned notes, release of app-owned pedals — on the app channel only.
 *   Never All Sound Off, never other channels, never Local Control or program changes.
 *   Without `clear()`, releases are timestamped after the last queued attack of that pitch so
 *   an already queued attack cannot outlive them.
 * - `stopSound`: forced cleanup plus All Notes Off (CC 123) on the app channel only.
 * - Disconnect: sends throw `OutputLostError` (the transport interrupts); `reconnect` releases
 *   whatever the app still owned when the link dropped.
 */
import { CC_ALL_NOTES_OFF, type MidiInputEvent } from '../midi/types'
import { ccBytes, noteOffBytes, noteOnBytes } from '../midi/decode'
import { type MidiOutputLike, canClear } from '../midi/webmidi'
import { type Clock, type OutputBackend, OutputLostError } from './types'

export interface MidiOutputBackendOptions {
  readonly output: MidiOutputLike
  /** 0-based app channel (the route's tested receive channel). */
  readonly channel: number
  readonly clock: Clock
  /** Defer app note-offs while the human holds the same pitch on the same channel. Default true. */
  readonly humanGuard?: boolean
  /** Note-off release velocity. Default 64 (MIDI's "no release velocity" value). */
  readonly releaseVelocity?: number
}

interface PedalOwnership {
  value: number
  time: number
  /** The app has pressed this pedal since the last cleanup. */
  touched: boolean
}

export class MidiOutputBackend implements OutputBackend {
  readonly kind = 'midi' as const
  readonly offLookaheadMs = 0
  readonly channel: number

  private output: MidiOutputLike
  private readonly clock: Clock
  private readonly guard: boolean
  private readonly releaseVelocity: number
  private readonly count = new Uint16Array(128)
  private readonly lastOn = new Float64Array(128).fill(Number.NEGATIVE_INFINITY)
  private readonly lastOff = new Float64Array(128).fill(Number.NEGATIVE_INFINITY)
  private readonly deferred = new Uint8Array(128)
  /** Bitmask of channels on which the human holds each key. */
  private readonly human = new Uint16Array(128)
  private readonly pedals = new Map<number, PedalOwnership>()
  private lost = false

  constructor(o: MidiOutputBackendOptions) {
    if (!Number.isInteger(o.channel) || o.channel < 0 || o.channel > 15) {
      throw new RangeError(`Invalid MIDI channel ${o.channel}`)
    }
    this.output = o.output
    this.channel = o.channel
    this.clock = o.clock
    this.guard = o.humanGuard ?? true
    this.releaseVelocity = o.releaseVelocity ?? 64
  }

  /** False after a send failed or `disconnected()`; true again after `reconnect`. */
  get available(): boolean {
    return !this.lost
  }

  noteOn(note: number, velocity: number, time: number): void {
    const v = Math.max(1, Math.min(127, Math.round(velocity)))
    this.send(noteOnBytes(this.channel, note, v), time)
    this.count[note]!++
    if (time > this.lastOn[note]!) this.lastOn[note] = time
    this.deferred[note] = 0
  }

  noteOff(note: number, time: number): void {
    if (this.count[note] === 0) return
    if (this.count[note] === 1 && this.guard && this.humanHolds(note)) {
      this.count[note] = 0
      this.deferred[note] = 1
      return
    }
    if (this.count[note] === 1) this.sendOff(note, time)
    this.count[note]!--
  }

  controlChange(controller: number, value: number, time: number): void {
    this.send(ccBytes(this.channel, controller, value), time)
    const p = this.pedals.get(controller) ?? { value: 0, time, touched: false }
    p.value = value
    p.time = Math.max(p.time, time)
    if (value > 0) p.touched = true
    this.pedals.set(controller, p)
  }

  /**
   * Feed every decoded human input event (in order). Tracks held keys per channel and sends a
   * deferred app release once the human lets go of that key.
   */
  humanInput(ev: MidiInputEvent): void {
    if (ev.kind === 'noteon') {
      this.human[ev.note]! |= 1 << ev.channel
    } else if (ev.kind === 'noteoff') {
      this.human[ev.note]! &= ~(1 << ev.channel)
      if (ev.channel === this.channel) this.flushDeferred(ev.note)
    } else if (ev.controller === CC_ALL_NOTES_OFF) {
      const bit = 1 << ev.channel
      for (let n = 0; n < 128; n++) {
        if (this.human[n]! & bit) {
          this.human[n]! &= ~bit
          if (ev.channel === this.channel) this.flushDeferred(n)
        }
      }
    }
  }

  /** Forget human key state (input reconnected: state unknown until new messages arrive). */
  resetHuman(): void {
    this.human.fill(0)
    for (let n = 0; n < 128; n++) this.flushDeferred(n)
  }

  cleanup(now: number): void {
    if (this.lost) return
    const cleared = this.tryClear()
    for (let n = 0; n < 128; n++) {
      const queuedOff = cleared && this.lastOff[n]! > now
      if (this.count[n] === 0 && !queuedOff) continue
      this.count[n] = 0
      if (this.guard && this.humanHolds(n)) {
        this.deferred[n] = 1
        continue
      }
      this.sendOff(n, cleared ? now : Math.max(now, this.lastOn[n]! + 1))
    }
    this.releasePedals(now, cleared)
  }

  stopSound(now: number): void {
    if (this.lost) return
    const cleared = this.tryClear()
    for (let n = 0; n < 128; n++) {
      if (this.count[n] === 0 && this.deferred[n] === 0 && !(cleared && this.lastOff[n]! > now)) continue
      this.count[n] = 0
      this.deferred[n] = 0
      this.sendOff(n, cleared ? now : Math.max(now, this.lastOn[n]! + 1))
    }
    this.releasePedals(now, cleared)
    let last = now
    if (!cleared) for (let n = 0; n < 128; n++) last = Math.max(last, this.lastOn[n]! + 1)
    this.send(ccBytes(this.channel, CC_ALL_NOTES_OFF, 0), last)
  }

  /** The output port disappeared: stop sending; ownership is kept for `reconnect`. */
  disconnected(): void {
    this.lost = true
  }

  /**
   * The route came back (possibly as a new port object). Releases notes and pedals the app
   * still owned when the link dropped, then resumes normal operation.
   */
  reconnect(output: MidiOutputLike, now: number): void {
    this.output = output
    this.lost = false
    for (let n = 0; n < 128; n++) {
      if (this.count[n] === 0 && this.deferred[n] === 0) continue
      this.count[n] = 0
      this.deferred[n] = 0
      this.sendOff(n, now)
    }
    for (const [controller, p] of this.pedals) {
      if (p.touched || p.value > 0) this.send(ccBytes(this.channel, controller, 0), now)
    }
    this.pedals.clear()
    this.lastOn.fill(Number.NEGATIVE_INFINITY)
    this.lastOff.fill(Number.NEGATIVE_INFINITY)
  }

  /** App-owned sounding notes (diagnostics and tests). */
  ownedNotes(): number[] {
    const out: number[] = []
    for (let n = 0; n < 128; n++) if (this.count[n]! > 0) out.push(n)
    return out
  }

  /** App releases waiting for the human to let go of the key. */
  deferredNotes(): number[] {
    const out: number[] = []
    for (let n = 0; n < 128; n++) if (this.deferred[n]) out.push(n)
    return out
  }

  private humanHolds(note: number): boolean {
    return (this.human[note]! & (1 << this.channel)) !== 0
  }

  private flushDeferred(note: number): void {
    if (!this.deferred[note] || this.count[note]! > 0 || this.humanHolds(note)) return
    this.deferred[note] = 0
    if (this.lost) return
    this.sendOff(note, this.clock())
  }

  private sendOff(note: number, time: number): void {
    this.send(noteOffBytes(this.channel, note, this.releaseVelocity), time)
    if (time > this.lastOff[note]!) this.lastOff[note] = time
  }

  private releasePedals(now: number, cleared: boolean): void {
    for (const [controller, p] of this.pedals) {
      const queued = cleared && p.time > now
      if (p.touched || p.value > 0 || queued) {
        this.send(ccBytes(this.channel, controller, 0), cleared ? now : Math.max(now, p.time + 1))
      }
    }
    this.pedals.clear()
  }

  private tryClear(): boolean {
    const out = this.output
    if (!canClear(out)) return false
    try {
      out.clear()
      return true
    } catch {
      return false
    }
  }

  private send(data: number[], time: number): void {
    if (this.lost) throw new OutputLostError()
    try {
      this.output.send(data, time)
    } catch (error) {
      this.lost = true
      throw new OutputLostError(error)
    }
  }
}
