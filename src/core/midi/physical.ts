/**
 * Physical key and pedal state of the connected piano, from decoded input only.
 *
 * Spec: "Separate physically depressed keys from sustained sounding notes" and "require
 * clean physical key and pedal state before restarting". Used by the Connection view's live
 * key/pedal test and by the MIDI output backend's human-held guard. O(1) per event, no
 * allocation in `apply`.
 */
import { CC_ALL_NOTES_OFF, CC_SOSTENUTO, CC_SUSTAIN, type MidiInputEvent } from './types'

export type KeyReleaseListener = (note: number, time: number) => void
export type PhysicalChangeListener = (ev: MidiInputEvent) => void

/** Conventional controller on/off boundary (spec: learned per piano where it matters). */
export const PEDAL_DOWN_THRESHOLD = 64

export class PhysicalState {
  /** Bitmask of channels holding each key. */
  private readonly held = new Uint16Array(128)
  /** Keys released while sustain was down and not yet cleared by a pedal release. */
  private readonly sustained = new Uint8Array(128)
  private readonly ccValue = new Uint8Array(16 * 128)
  private readonly ccSeen = new Uint8Array(16 * 128)
  private heldTotal = 0
  private readonly releaseListeners: KeyReleaseListener[] = []
  private readonly changeListeners: PhysicalChangeListener[] = []

  /** Apply one decoded event. Call for every input event, in order. */
  apply(ev: MidiInputEvent): void {
    if (ev.kind === 'noteon') {
      const before = this.held[ev.note]!
      if (before === 0) this.heldTotal++
      this.held[ev.note] = before | (1 << ev.channel)
      this.sustained[ev.note] = 0
    } else if (ev.kind === 'noteoff') {
      const before = this.held[ev.note]!
      const after = before & ~(1 << ev.channel)
      this.held[ev.note] = after
      if (before !== 0 && after === 0) {
        this.heldTotal--
        if (this.sustainDown()) this.sustained[ev.note] = 1
        for (const fn of this.releaseListeners) fn(ev.note, ev.time)
      }
    } else if (ev.controller >= CC_ALL_NOTES_OFF) {
      // All Notes Off and the mode messages that imply it: no individual releases follow.
      this.releaseChannel(ev.channel, ev.time)
    } else {
      const k = ev.channel * 128 + ev.controller
      this.ccValue[k] = ev.value
      this.ccSeen[k] = 1
      if (ev.controller === CC_SUSTAIN && ev.value < PEDAL_DOWN_THRESHOLD) this.sustained.fill(0)
    }
    for (const fn of this.changeListeners) fn(ev)
  }

  isHeld(note: number): boolean {
    return (this.held[note] ?? 0) !== 0
  }

  /** Released keys still sounding because sustain is down (display only; never an attack). */
  isSustained(note: number): boolean {
    return (this.sustained[note] ?? 0) !== 0
  }

  get heldCount(): number {
    return this.heldTotal
  }

  heldNotes(): number[] {
    const out: number[] = []
    for (let n = 0; n < 128; n++) if (this.held[n] !== 0) out.push(n)
    return out
  }

  /** Latest value of a controller; `channel` omitted = maximum over channels. */
  controllerValue(controller: number, channel?: number): number {
    if (channel !== undefined) return this.ccValue[channel * 128 + controller] ?? 0
    let max = 0
    for (let c = 0; c < 16; c++) max = Math.max(max, this.ccValue[c * 128 + controller]!)
    return max
  }

  /** Value if the controller has been observed since the last reset (learning baseline). */
  observedValue(controller: number, channel: number): number | undefined {
    const k = channel * 128 + controller
    return this.ccSeen[k] ? this.ccValue[k] : undefined
  }

  sustainDown(): boolean {
    return this.controllerValue(CC_SUSTAIN) >= PEDAL_DOWN_THRESHOLD
  }

  /**
   * No keys held and no sound-retaining pedal down (spec "Immediate repeat readiness").
   * `soundRetaining` defaults to sustain and sostenuto; pass the learned threshold if known.
   */
  isClean(soundRetaining: readonly number[] = [CC_SUSTAIN, CC_SOSTENUTO], threshold = PEDAL_DOWN_THRESHOLD): boolean {
    if (this.heldTotal > 0) return false
    for (const cc of soundRetaining) if (this.controllerValue(cc) >= threshold) return false
    return true
  }

  private releaseChannel(channel: number, time: number): void {
    const bit = 1 << channel
    for (let n = 0; n < 128; n++) {
      const before = this.held[n]!
      if (!(before & bit)) continue
      this.held[n] = before & ~bit
      if (this.held[n] === 0) {
        this.heldTotal--
        if (this.sustainDown()) this.sustained[n] = 1
        for (const fn of this.releaseListeners) fn(n, time)
      }
    }
  }

  /** Forget everything (reconnection: physical state is unknown until new messages arrive). */
  reset(): void {
    this.held.fill(0)
    this.sustained.fill(0)
    this.ccValue.fill(0)
    this.ccSeen.fill(0)
    this.heldTotal = 0
  }

  /** Called when a key goes from held to released (all channels). */
  onKeyRelease(fn: KeyReleaseListener): () => void {
    return addListener(this.releaseListeners, fn)
  }

  /** Called after every applied event (live key/pedal test; batch rendering with rAF). */
  onChange(fn: PhysicalChangeListener): () => void {
    return addListener(this.changeListeners, fn)
  }
}

export function addListener<T>(list: T[], fn: T): () => void {
  list.push(fn)
  return () => {
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
}
