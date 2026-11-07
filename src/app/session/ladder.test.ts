import { describe, expect, it } from 'vitest'
import { ladderAfterAttempt, ladderAfterManualSpeed, retargetLadder, sameLadder, startLadder } from './ladder'

const settings = { goal: 1, step: 0.05 }

describe('speed ladder rules', () => {
  it('starts at the current speed, done when already at the goal', () => {
    expect(startLadder(settings, 0.6)).toEqual({ goal: 1, step: 0.05, start: 0.6, failures: 0, done: false })
    expect(startLadder(settings, 1).done).toBe(true)
    expect(startLadder(settings, 1.25).done).toBe(true)
  })

  it('climbs one step once the target is met, not before', () => {
    const l = startLadder(settings, 0.6)
    expect(ladderAfterAttempt(l, 0.6, true, 2, 3)).toEqual({ ladder: l })
    expect(ladderAfterAttempt(l, 0.6, true, 3, 3)).toEqual({ ladder: l, next: 0.65, note: { climbedTo: 0.65 } })
  })

  it('never climbs past the goal and is done when the target is met at the goal', () => {
    const l = startLadder({ goal: 0.62, step: 0.05 }, 0.6)
    expect(ladderAfterAttempt(l, 0.6, true, 3, 3).next).toBe(0.62)
    const top = ladderAfterAttempt(l, 0.62, true, 3, 3)
    expect(top.ladder.done).toBe(true)
    expect(top.note).toEqual({ done: true })
    expect(top.next).toBeUndefined()
    // Done: nothing more happens, passes or failures.
    expect(ladderAfterAttempt(top.ladder, 0.62, false, 0, 3)).toEqual({ ladder: top.ladder })
    expect(ladderAfterAttempt(top.ladder, 0.62, true, 6, 3)).toEqual({ ladder: top.ladder })
  })

  it('drops one step after two failures in a row; a pass in between starts the count over', () => {
    const l = { ...startLadder(settings, 0.5), start: 0.5 }
    const one = ladderAfterAttempt(l, 0.6, false, 0, 3)
    expect(one).toEqual({ ladder: { ...l, failures: 1 } })
    expect(ladderAfterAttempt(one.ladder, 0.6, true, 1, 3).ladder.failures).toBe(0)
    const two = ladderAfterAttempt(one.ladder, 0.6, false, 0, 3)
    expect(two).toEqual({ ladder: { ...l, failures: 0 }, next: 0.55, note: { droppedTo: 0.55 } })
  })

  it('never drops below the start; a drop at the floor is a no-op', () => {
    const l = { ...startLadder(settings, 0.58), failures: 1 }
    expect(ladderAfterAttempt(l, 0.6, false, 0, 3).next).toBe(0.58)
    const floor = ladderAfterAttempt(l, 0.58, false, 0, 3)
    expect(floor).toEqual({ ladder: { ...l, failures: 0 } })
  })

  it('a manual speed resets failures, lowers the floor and sets done at the goal', () => {
    const l = { ...startLadder(settings, 0.6), failures: 1 }
    expect(ladderAfterManualSpeed(l, 0.5)).toMatchObject({ start: 0.5, failures: 0, done: false })
    expect(ladderAfterManualSpeed(l, 0.8)).toMatchObject({ start: 0.6, failures: 0, done: false })
    expect(ladderAfterManualSpeed(l, 1)).toMatchObject({ done: true })
    expect(ladderAfterManualSpeed({ ...l, done: true }, 0.9).done).toBe(false)
  })

  it('new settings keep the start and failures', () => {
    const l = { ...startLadder(settings, 0.6), failures: 1 }
    expect(retargetLadder(l, { goal: 0.75, step: 0.1 }, 0.7)).toEqual({ ...l, goal: 0.75, step: 0.1, done: false })
    expect(retargetLadder(l, { goal: 0.5, step: 0.05 }, 0.7).done).toBe(true)
  })

  it('compares settings by value', () => {
    expect(sameLadder(null, null)).toBe(true)
    expect(sameLadder(settings, { goal: 1, step: 0.05 })).toBe(true)
    expect(sameLadder(settings, null)).toBe(false)
    expect(sameLadder(settings, { goal: 1, step: 0.1 })).toBe(false)
  })
})
