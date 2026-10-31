/**
 * Live key and pedal test model (spec "MIDI input, output, and pedal controls": live key and
 * pedal input tests; "Record pedal and velocity information"). Framework-free.
 *
 * The input handler does O(1) work per event — a ring-buffer write, a few array updates and at
 * most one frame request — and never renders (spec "Execution and rendering architecture":
 * batch only visual changes with requestAnimationFrame). The view re-renders from `onFrame`.
 */
import type { MidiInputEvent } from '../../core/midi/types'

export interface ControllerMeter {
  readonly channel: number
  readonly controller: number
  /** Latest value 0..127. */
  readonly value: number
  readonly min: number
  readonly max: number
  /** Number of distinct values seen: 2 suggests an on/off switch, more a continuous pedal. */
  readonly distinct: number
  readonly messages: number
}

export interface LiveCounts {
  readonly noteOn: number
  readonly noteOff: number
  readonly cc: number
}

export type FrameScheduler = (cb: () => void) => () => void

export interface LiveMonitorOptions {
  /** Subscribe to decoded input events (the adapter's `subscribe`). */
  readonly subscribe: (fn: (ev: MidiInputEvent) => void) => () => void
  /** Called at most once per animation frame after new events. */
  readonly onFrame: () => void
  readonly scheduleFrame?: FrameScheduler
  /** Events kept for the "last events" list. Default 12. */
  readonly maxEvents?: number
}

/** Controllers that are never pedals: bank select and the channel-mode messages (120–127). */
export function isPedalLikeController(controller: number): boolean {
  return controller !== 0 && controller !== 32 && controller < 120
}

/** requestAnimationFrame when available (setTimeout fallback), returning a cancel function. */
export const animationFrame: FrameScheduler = (cb) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb())
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(cb, 16)
  return () => clearTimeout(id)
}

interface MutableMeter {
  channel: number
  controller: number
  value: number
  min: number
  max: number
  distinct: number
  messages: number
  readonly seen: Uint8Array
}

export class LiveMonitor {
  /** Velocity of the latest Note On per key (meaningful while the key is held). */
  readonly velocity = new Uint8Array(128)
  private readonly ring: (MidiInputEvent | null)[]
  private head = 0
  private size = 0
  private readonly meters = new Map<number, MutableMeter>()
  private readonly fresh: number[] = []
  private noteOn = 0
  private noteOff = 0
  private cc = 0
  private last: Extract<MidiInputEvent, { kind: 'noteon' }> | null = null
  private cancelFrame: (() => void) | null = null
  private unsubscribe: (() => void) | null = null
  private readonly opts: LiveMonitorOptions
  private readonly schedule: FrameScheduler

  constructor(opts: LiveMonitorOptions) {
    this.opts = opts
    this.schedule = opts.scheduleFrame ?? animationFrame
    this.ring = new Array<MidiInputEvent | null>(Math.max(1, opts.maxEvents ?? 12)).fill(null)
  }

  start(): void {
    this.unsubscribe ??= this.opts.subscribe(this.handle)
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.cancelFrame?.()
    this.cancelFrame = null
  }

  /** The input handler: O(1), no rendering. */
  readonly handle = (ev: MidiInputEvent): void => {
    this.ring[this.head] = ev
    this.head = (this.head + 1) % this.ring.length
    if (this.size < this.ring.length) this.size++
    if (ev.kind === 'noteon') {
      this.noteOn++
      this.velocity[ev.note] = ev.velocity
      this.last = ev
    } else if (ev.kind === 'noteoff') {
      this.noteOff++
    } else {
      this.cc++
      this.meter(ev)
    }
    this.cancelFrame ??= this.schedule(this.frame)
  }

  private readonly frame = (): void => {
    this.cancelFrame = null
    this.opts.onFrame()
  }

  private meter(ev: Extract<MidiInputEvent, { kind: 'cc' }>): void {
    const key = ev.channel * 128 + ev.controller
    let m = this.meters.get(key)
    if (!m) {
      m = {
        channel: ev.channel,
        controller: ev.controller,
        value: ev.value,
        min: ev.value,
        max: ev.value,
        distinct: 0,
        messages: 0,
        seen: new Uint8Array(128),
      }
      this.meters.set(key, m)
      if (isPedalLikeController(ev.controller) && !this.fresh.includes(ev.controller)) this.fresh.push(ev.controller)
    }
    m.value = ev.value
    if (ev.value < m.min) m.min = ev.value
    if (ev.value > m.max) m.max = ev.value
    if (!m.seen[ev.value]) {
      m.seen[ev.value] = 1
      m.distinct++
    }
    m.messages++
  }

  /** Latest events, newest first. */
  events(): MidiInputEvent[] {
    const out: MidiInputEvent[] = []
    for (let i = 1; i <= this.size; i++) {
      const ev = this.ring[(this.head - i + this.ring.length) % this.ring.length]
      if (ev) out.push(ev)
    }
    return out
  }

  /** Every controller seen (per channel), by controller number then channel. */
  controllers(): ControllerMeter[] {
    return [...this.meters.values()]
      .map(({ seen: _seen, ...m }) => m)
      .sort((a, b) => a.controller - b.controller || a.channel - b.channel)
  }

  counts(): LiveCounts {
    return { noteOn: this.noteOn, noteOff: this.noteOff, cc: this.cc }
  }

  lastNote(): Extract<MidiInputEvent, { kind: 'noteon' }> | null {
    return this.last
  }

  /** Pedal-like controllers first seen since the last call (to record in settings). */
  takeNewControllers(): number[] {
    return this.fresh.splice(0)
  }

  /** Clear counters, events and meters (start a fresh fidelity check). */
  reset(): void {
    this.ring.fill(null)
    this.head = 0
    this.size = 0
    this.meters.clear()
    this.noteOn = 0
    this.noteOff = 0
    this.cc = 0
    this.last = null
    this.opts.onFrame()
  }
}
