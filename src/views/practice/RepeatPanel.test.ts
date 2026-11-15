import { describe, expect, it } from 'vitest'
import { defaultLadderGoal, goalWords, ladderGoals, ladderLine, targetLine } from './RepeatPanel'

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

  it('reads "60% → 100%" while climbing and "Goal reached" at the goal', () => {
    const ladder = { goal: 1, step: 0.05, start: 0.6, failures: 0, done: false }
    expect(ladderLine(ladder, 0.65)).toBe('65% → 100%')
    expect(ladderLine({ ...ladder, done: true }, 1)).toBe('Goal reached')
  })

  it('switches a ladder on at 100% when that is above the speed, else at the next goal', () => {
    expect(defaultLadderGoal(0.6)).toBe(100)
    expect(defaultLadderGoal(1)).toBe(125)
    expect(defaultLadderGoal(2)).toBeNull()
  })

  it('sums the goal up for the goal button and the options button', () => {
    expect(targetLine(null)).toBe('No limit')
    expect(targetLine(3)).toBe('Until 3 clean')
    const ladder = { goal: 1, step: 0.05, start: 0.6, failures: 0, done: false }
    expect(goalWords(3, ladder, 0.6)).toBe('until 3 clean in a row; speed ladder 60% to 100%')
    expect(goalWords(null, null, 1)).toBe('repeat with no limit')
  })
})
