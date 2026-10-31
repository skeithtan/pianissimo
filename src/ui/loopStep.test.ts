import { describe, expect, it } from 'vitest'
import { loopStepAvailability, stepLoop, type LoopRange } from './loopStep'

const LAST = 58 // the 59-occurrence reference piece

describe('loopStepAvailability', () => {
  it('with no loop mid-piece only the outward buttons are enabled', () => {
    expect(loopStepAvailability(null, 10, LAST)).toEqual({
      startEarlier: true,
      startLater: false,
      endEarlier: false,
      endLater: true,
    })
  })

  it('with no loop at the first bar, "start earlier" is also disabled', () => {
    expect(loopStepAvailability(null, 0, LAST)).toEqual({
      startEarlier: false,
      startLater: false,
      endEarlier: false,
      endLater: true,
    })
  })

  it('with no loop at the last bar, "end later" is also disabled', () => {
    expect(loopStepAvailability(null, LAST, LAST)).toEqual({
      startEarlier: true,
      startLater: false,
      endEarlier: false,
      endLater: false,
    })
  })

  it('a one-bar piece offers nothing', () => {
    expect(loopStepAvailability(null, 0, 0)).toEqual({
      startEarlier: false,
      startLater: false,
      endEarlier: false,
      endLater: false,
    })
  })

  it('a loop of several bars can move either edge either way', () => {
    expect(loopStepAvailability({ fromOcc: 5, toOcc: 9 }, 7, LAST)).toEqual({
      startEarlier: true,
      startLater: true,
      endEarlier: true,
      endLater: true,
    })
  })

  it('a one-bar loop cannot shrink: start later and end earlier are disabled', () => {
    expect(loopStepAvailability({ fromOcc: 7, toOcc: 7 }, 7, LAST)).toEqual({
      startEarlier: true,
      startLater: false,
      endEarlier: false,
      endLater: true,
    })
  })

  it('a loop touching the first bar cannot extend earlier', () => {
    const a = loopStepAvailability({ fromOcc: 0, toOcc: 3 }, 1, LAST)
    expect(a.startEarlier).toBe(false)
    expect(a.startLater).toBe(true)
  })

  it('a loop touching the last bar cannot extend later', () => {
    const a = loopStepAvailability({ fromOcc: 50, toOcc: LAST }, 55, LAST)
    expect(a.endLater).toBe(false)
    expect(a.endEarlier).toBe(true)
  })

  it('the whole piece as a loop can only shrink', () => {
    expect(loopStepAvailability({ fromOcc: 0, toOcc: LAST }, 3, LAST)).toEqual({
      startEarlier: false,
      startLater: true,
      endEarlier: true,
      endLater: false,
    })
  })
})

describe('stepLoop', () => {
  it('"start earlier" with no loop makes the bar before the current bar plus the current bar', () => {
    expect(stepLoop(null, 'start', -1, 10, LAST)).toEqual({ fromOcc: 9, toOcc: 10 })
  })

  it('"end later" with no loop makes the current bar plus the next', () => {
    expect(stepLoop(null, 'end', 1, 10, LAST)).toEqual({ fromOcc: 10, toOcc: 11 })
  })

  it('refuses the inward buttons when there is no loop', () => {
    expect(stepLoop(null, 'start', 1, 10, LAST)).toBeNull()
    expect(stepLoop(null, 'end', -1, 10, LAST)).toBeNull()
  })

  it('refuses to create a loop off either end of the piece', () => {
    expect(stepLoop(null, 'start', -1, 0, LAST)).toBeNull()
    expect(stepLoop(null, 'end', 1, LAST, LAST)).toBeNull()
    expect(stepLoop(null, 'start', -1, LAST, LAST)).toEqual({ fromOcc: LAST - 1, toOcc: LAST })
    expect(stepLoop(null, 'end', 1, 0, LAST)).toEqual({ fromOcc: 0, toOcc: 1 })
  })

  it('moves exactly one edge by exactly one bar', () => {
    const loop: LoopRange = { fromOcc: 5, toOcc: 9 }
    expect(stepLoop(loop, 'start', -1, 7, LAST)).toEqual({ fromOcc: 4, toOcc: 9 })
    expect(stepLoop(loop, 'start', 1, 7, LAST)).toEqual({ fromOcc: 6, toOcc: 9 })
    expect(stepLoop(loop, 'end', -1, 7, LAST)).toEqual({ fromOcc: 5, toOcc: 8 })
    expect(stepLoop(loop, 'end', 1, 7, LAST)).toEqual({ fromOcc: 5, toOcc: 10 })
  })

  it('never lets the start pass the end or leave the piece', () => {
    expect(stepLoop({ fromOcc: 7, toOcc: 7 }, 'start', 1, 7, LAST)).toBeNull()
    expect(stepLoop({ fromOcc: 7, toOcc: 7 }, 'end', -1, 7, LAST)).toBeNull()
    expect(stepLoop({ fromOcc: 0, toOcc: 3 }, 'start', -1, 1, LAST)).toBeNull()
    expect(stepLoop({ fromOcc: 50, toOcc: LAST }, 'end', 1, 55, LAST)).toBeNull()
  })

  it('the loop ignores the current bar once it exists', () => {
    expect(stepLoop({ fromOcc: 5, toOcc: 9 }, 'end', 1, 40, LAST)).toEqual({ fromOcc: 5, toOcc: 10 })
  })

  it('clamps an out-of-range current bar', () => {
    expect(stepLoop(null, 'end', 1, 999, LAST)).toBeNull()
    expect(stepLoop(null, 'start', -1, 999, LAST)).toEqual({ fromOcc: LAST - 1, toOcc: LAST })
    expect(stepLoop(null, 'start', -1, -4, LAST)).toBeNull()
  })
})
