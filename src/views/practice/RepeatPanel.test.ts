import { describe, expect, it } from 'vitest'
import { ladderGoals, ladderLine } from './RepeatPanel'

describe('speed ladder controls', () => {
  it('offers the presets and 100% above the current speed', () => {
    expect(ladderGoals(0.6, null)).toEqual([75, 100, 125, 150, 200])
    expect(ladderGoals(0.5, null)).toEqual([75, 100, 125, 150, 200])
    expect(ladderGoals(1, null)).toEqual([125, 150, 200])
    expect(ladderGoals(2, null)).toEqual([])
  })

  it("keeps the ladder's own goal in the list", () => {
    expect(ladderGoals(1, 1)).toEqual([100, 125, 150, 200])
    expect(ladderGoals(0.6, 0.85)).toEqual([75, 85, 100, 125, 150, 200])
  })

  it('reads "Ladder 60% → 100%" while climbing and "Goal reached" at the goal', () => {
    const ladder = { goal: 1, step: 0.05, start: 0.6, failures: 0, done: false }
    expect(ladderLine(ladder, 0.65)).toBe('Ladder 65% → 100%')
    expect(ladderLine({ ...ladder, done: true }, 1)).toBe('Goal reached')
  })
})
