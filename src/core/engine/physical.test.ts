import { describe, expect, it } from 'vitest'
import { PhysicalState } from './physical'

describe('PhysicalState', () => {
  it('tracks held keys separately per note', () => {
    const p = new PhysicalState(64)
    p.keyDown(62, 0)
    p.keyDown(60, 0)
    expect(p.heldKeys()).toEqual([60, 62])
    expect(p.keyUp(60)).toBe(true)
    expect(p.keyUp(60)).toBe(false)
    expect(p.isHeld(62)).toBe(true)
    expect(p.anyKeyHeld).toBe(true)
  })

  it('tracks sustain and sostenuto against the learned threshold; soft pedal is ignored', () => {
    const p = new PhysicalState(40)
    expect(p.pedal(64, 39)).toBe(true)
    expect(p.pedalsDown).toBe(false)
    p.pedal(66, 40)
    expect(p.sostenutoDown).toBe(true)
    expect(p.pedalsDown).toBe(true)
    expect(p.pedal(67, 127)).toBe(false)
    p.pedal(66, 0)
    expect(p.pedalsDown).toBe(false)
  })

  it('All Notes Off releases the channel; reset forgets everything', () => {
    const p = new PhysicalState(64)
    p.keyDown(60, 0)
    p.keyDown(61, 1)
    expect(p.releaseChannel(0)).toEqual([60])
    expect(p.heldKeys()).toEqual([61])
    p.pedal(64, 127)
    p.reset()
    expect(p.anyKeyHeld).toBe(false)
    expect(p.pedalsDown).toBe(false)
  })
})
