import type { GuideKey, GuideKeyState } from './types'

const GROUPS: ReadonlyArray<readonly [GuideKeyState, string]> = [
  ['target', 'Play'],
  ['accepted', 'Played'],
  ['sounding', 'Sounding'],
  ['held', 'Held'],
  ['wrong', 'Wrong keys held'],
]

/**
 * Text alternative for the diagram (accessible name): what to play, what is already played,
 * what the app is sounding, the keys held and any wrong key, low to high, plus the marked roll.
 */
export function describeGuide(keys: readonly GuideKey[], rollDirection: 'up' | 'down' | undefined): string {
  const parts = ['Keyboard guide.']
  const sorted = [...keys].sort((a, b) => a.midi - b.midi)
  for (const [state, title] of GROUPS) {
    const names = sorted.filter((k) => k.state === state).map((k) => k.label)
    if (names.length) parts.push(`${title}: ${names.join(', ')}.`)
  }
  if (!sorted.some((k) => k.state === 'target' || k.state === 'accepted')) parts.push('No keys to play.')
  if (rollDirection === 'up') parts.push('Roll upward, low to high.')
  if (rollDirection === 'down') parts.push('Roll downward, high to low.')
  return parts.join(' ')
}
