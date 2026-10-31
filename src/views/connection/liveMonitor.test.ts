import { describe, expect, it } from 'vitest'
import type { MidiInputEvent } from '../../core/midi/types'
import { LiveMonitor, isPedalLikeController } from './liveMonitor'
import { mergeObserved } from './LivePanel'

let seq = 0
const on = (note: number, velocity: number): MidiInputEvent => ({
  kind: 'noteon',
  seq: ++seq,
  channel: 0,
  note,
  velocity,
  time: seq,
  portId: 'p',
})
const off = (note: number): MidiInputEvent => ({
  kind: 'noteoff',
  seq: ++seq,
  channel: 0,
  note,
  velocity: 64,
  time: seq,
  portId: 'p',
})
const cc = (controller: number, value: number, channel = 0): MidiInputEvent => ({
  kind: 'cc',
  seq: ++seq,
  channel,
  controller,
  value,
  time: seq,
  portId: 'p',
})

function rig(maxEvents = 4) {
  let listener: ((ev: MidiInputEvent) => void) | null = null
  const frames: (() => void)[] = []
  let rendered = 0
  const monitor = new LiveMonitor({
    subscribe: (fn) => {
      listener = fn
      return () => {
        listener = null
      }
    },
    onFrame: () => rendered++,
    scheduleFrame: (cb) => {
      frames.push(cb)
      return () => frames.splice(frames.indexOf(cb), 1)
    },
    maxEvents,
  })
  monitor.start()
  return {
    monitor,
    send: (ev: MidiInputEvent) => listener?.(ev),
    frame: () => frames.splice(0).forEach((f) => f()),
    get frames() {
      return frames.length
    },
    get rendered() {
      return rendered
    },
    get subscribed() {
      return listener !== null
    },
  }
}

describe('LiveMonitor (spec: batch visual changes with requestAnimationFrame)', () => {
  it('requests one frame for a burst of events and renders only from the frame', () => {
    const r = rig()
    r.send(on(60, 90))
    r.send(on(64, 70))
    r.send(off(60))
    expect(r.frames).toBe(1)
    expect(r.rendered).toBe(0)
    r.frame()
    expect(r.rendered).toBe(1)
    r.send(on(67, 50))
    expect(r.frames).toBe(1)
  })

  it('keeps the newest events first in a bounded ring, and counts every event once', () => {
    const r = rig(3)
    for (const ev of [on(60, 90), off(60), on(62, 80), off(62), cc(64, 127)]) r.send(ev)
    expect(r.monitor.events().map((e) => e.kind)).toEqual(['cc', 'noteoff', 'noteon'])
    expect(r.monitor.counts()).toEqual({ noteOn: 2, noteOff: 2, cc: 1 })
    expect(r.monitor.velocity[62]).toBe(80)
    expect(r.monitor.lastNote()?.note).toBe(62)
  })

  it('meters each controller per channel with range and distinct values', () => {
    const r = rig()
    for (const v of [0, 30, 90, 127, 0]) r.send(cc(64, v))
    r.send(cc(67, 0))
    r.send(cc(67, 127))
    r.send(cc(64, 5, 1))
    const meters = r.monitor.controllers()
    expect(meters.map((m) => [m.controller, m.channel, m.value, m.min, m.max, m.distinct])).toEqual([
      [64, 0, 0, 0, 127, 4],
      [64, 1, 5, 5, 5, 1],
      [67, 0, 127, 0, 127, 2],
    ])
  })

  it('hands out newly seen pedal controllers once, never bank select or mode messages', () => {
    const r = rig()
    r.send(cc(64, 127))
    r.send(cc(0, 1))
    r.send(cc(123, 0))
    r.send(cc(64, 0))
    expect(r.monitor.takeNewControllers()).toEqual([64])
    expect(r.monitor.takeNewControllers()).toEqual([])
    r.send(cc(66, 127))
    expect(r.monitor.takeNewControllers()).toEqual([66])
    expect([0, 32, 120, 127].map(isPedalLikeController)).toEqual([false, false, false, false])
  })

  it('reset clears counters and stop unsubscribes and cancels the frame', () => {
    const r = rig()
    r.send(on(60, 90))
    r.monitor.reset()
    expect(r.monitor.counts()).toEqual({ noteOn: 0, noteOff: 0, cc: 0 })
    expect(r.monitor.events()).toEqual([])
    r.monitor.stop()
    expect(r.subscribed).toBe(false)
    expect(r.frames).toBe(0)
  })
})

describe('mergeObserved', () => {
  it('returns the stored list itself when nothing is new', () => {
    const stored = [64, 67]
    expect(mergeObserved(stored, [67])).toBe(stored)
    expect(mergeObserved(stored, [66, 64])).toEqual([64, 66, 67])
  })
})
