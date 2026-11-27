import { describe, expect, it } from 'vitest'
import { ladderAfterAttempt, sameLadder, startLadder } from './ladder'

const settings = { goal: 1, step: 0.05 }

describe('speed ladder rules', () => {
  it('starts at the current speed, done when already at the goal', () => {
    expect(startLadder(settings, 0.6)).toEqual({ goal: 1, step: 0.05, done: false })
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

  it('holds the current speed on a failed pass', () => {
    const ladder = startLadder(settings, 0.5)
    expect(ladderAfterAttempt(ladder, 0.6, false, 0, 3)).toEqual({ ladder })
  })

  it('compares settings by value', () => {
    expect(sameLadder(null, null)).toBe(true)
    expect(sameLadder(settings, { goal: 1, step: 0.05 })).toBe(true)
    expect(sameLadder(settings, null)).toBe(false)
    expect(sameLadder(settings, { goal: 1, step: 0.1 })).toBe(false)
  })

  it('holds on a passed, non-fluent pass even at the target streak', () => {
    const l = startLadder(settings, 0.6)
    const step = ladderAfterAttempt(l, 0.6, true, 3, 3, false)
    expect(step).toEqual({ ladder: l, note: { held: true } })
    expect(step.ladder).toBe(l)
    expect(step.next).toBeUndefined()
  })

  it('a failed pass ignores fluent: nothing changes', () => {
    const l = startLadder(settings, 0.5)
    expect(ladderAfterAttempt(l, 0.6, false, 0, 3, false)).toEqual({ ladder: l })
  })

  it('a done ladder returns no note even on a non-fluent pass', () => {
    const done = startLadder(settings, 1)
    expect(done.done).toBe(true)
    const step = ladderAfterAttempt(done, 1, true, 3, 3, false)
    expect(step).toEqual({ ladder: done })
    expect(step.ladder).toBe(done)
    expect(step.note).toBeUndefined()
  })

  it('a non-fluent pass at the goal holds instead of finishing the climb', () => {
    const atGoal = { ...startLadder(settings, 0.95), done: false }
    const held = ladderAfterAttempt(atGoal, 1, true, 3, 3, false)
    expect(held).toEqual({ ladder: atGoal, note: { held: true } })
    expect(held.ladder.done).toBe(false)
  })
})
