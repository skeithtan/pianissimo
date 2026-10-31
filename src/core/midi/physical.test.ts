import { describe, expect, it } from 'vitest'
import { PhysicalState } from './physical'
import type { MidiInputEvent } from './types'

let seq = 0
const on = (note: number, channel = 0): MidiInputEvent => ({
  kind: 'noteon',
  seq: ++seq,
  channel,
  note,
  velocity: 80,
  time: seq,
  portId: 'p',
})
const off = (note: number, channel = 0): MidiInputEvent => ({
  kind: 'noteoff',
  seq: ++seq,
  channel,
  note,
  velocity: 0,
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

describe('PhysicalState (spec: physically depressed keys vs sustained sound)', () => {
  it('tracks held keys separately from keys sounding only through sustain', () => {
    const p = new PhysicalState()
    p.apply(cc(64, 127))
    p.apply(on(60))
    expect(p.isHeld(60)).toBe(true)
    p.apply(off(60))
    expect(p.isHeld(60)).toBe(false)
    expect(p.isSustained(60)).toBe(true)
    p.apply(on(60))
    expect(p.isSustained(60)).toBe(false)
    p.apply(off(60))
    p.apply(cc(64, 0))
    expect(p.isSustained(60)).toBe(false)
  })

  it('counts a key held on two channels once and releases it when both let go', () => {
    const p = new PhysicalState()
    const released: number[] = []
    p.onKeyRelease((n) => released.push(n))
    p.apply(on(60, 0))
    p.apply(on(60, 1))
    expect(p.heldCount).toBe(1)
    p.apply(off(60, 0))
    expect(p.isHeld(60)).toBe(true)
    p.apply(off(60, 1))
    expect(released).toEqual([60])
    expect(p.heldNotes()).toEqual([])
  })

  it('ignores a release for a key that was not held', () => {
    const p = new PhysicalState()
    const released: number[] = []
    p.onKeyRelease((n) => released.push(n))
    p.apply(off(61))
    expect(released).toEqual([])
    expect(p.heldCount).toBe(0)
  })

  it('is clean only with no keys held and no sound-retaining pedal down', () => {
    const p = new PhysicalState()
    expect(p.isClean()).toBe(true)
    p.apply(on(60))
    expect(p.isClean()).toBe(false)
    p.apply(off(60))
    p.apply(cc(66, 100))
    expect(p.isClean()).toBe(false)
    p.apply(cc(66, 0))
    p.apply(cc(67, 127))
    expect(p.isClean()).toBe(true)
    p.apply(cc(64, 40))
    expect(p.isClean()).toBe(true)
    expect(p.isClean([64], 30)).toBe(false)
  })

  it('keeps continuous controller values and remembers which were observed', () => {
    const p = new PhysicalState()
    expect(p.observedValue(66, 0)).toBeUndefined()
    p.apply(cc(66, 37, 0))
    p.apply(cc(66, 90, 3))
    expect(p.observedValue(66, 0)).toBe(37)
    expect(p.controllerValue(66, 3)).toBe(90)
    expect(p.controllerValue(66)).toBe(90)
  })

  it('treats All Notes Off from the instrument as releasing that channel’s keys', () => {
    const p = new PhysicalState()
    const released: number[] = []
    p.onKeyRelease((n) => released.push(n))
    p.apply(on(60, 0))
    p.apply(on(62, 1))
    p.apply(cc(123, 0, 0))
    expect(released).toEqual([60])
    expect(p.heldNotes()).toEqual([62])
    expect(p.controllerValue(123, 0)).toBe(0)
  })

  it('reset forgets keys and pedals; listeners see every applied event', () => {
    const p = new PhysicalState()
    const kinds: string[] = []
    const stop = p.onChange((ev) => kinds.push(ev.kind))
    p.apply(on(60))
    p.apply(cc(64, 127))
    stop()
    p.apply(off(60))
    expect(kinds).toEqual(['noteon', 'cc'])
    p.apply(on(61))
    p.reset()
    expect(p.heldCount).toBe(0)
    expect(p.sustainDown()).toBe(false)
  })
})
