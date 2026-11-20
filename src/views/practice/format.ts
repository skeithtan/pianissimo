/** Plain-language text shared by the practice result summary and its details. */
import type { AttemptSummary, AttemptTiming } from '../../app/session'
import { formatSeconds } from '../../core/history'

/** "On time 38 of 42 · 3 late · 1 missed": a Keep time attempt's timing (zero counts left out). */
export function timingText(t: AttemptTiming): string {
  const parts = [`On time ${t.onTime} of ${t.groups}`]
  if (t.early > 0) parts.push(`${t.early} early`)
  if (t.late > 0) parts.push(`${t.late} late`)
  if (t.missed > 0) parts.push(`${t.missed} missed`)
  return parts.join(' · ')
}

export function wrongText(n: number): string {
  return n === 0 ? 'No wrong notes' : n === 1 ? '1 wrong note' : `${n} wrong notes`
}

function passHelpText(result: AttemptSummary): string {
  if (result.assistance === 'keyboard') return 'Help: the keyboard guide'
  if (result.assistance === 'names') return 'Help: note names'
  return result.persistentLabels ? 'Help: note names on the score' : 'No help used'
}

/** The "This pass" lines in display order. The pill previews the beginning of this list. */
export function passFacts(result: AttemptSummary, goal: number | null): string[] {
  const facts: string[] = []
  if (result.groupsTotal > 0)
    facts.push(`Right the first time at ${result.groupsFirstPass} of ${result.groupsTotal} places`)
  facts.push(passHelpText(result))

  if (result.timing) facts.push(timingText(result.timing))
  else if (result.completionTimeSec !== null) {
    const elapsed = `Took ${formatSeconds(result.completionTimeSec)}`
    const expected = result.expectedTimeSec
    if (expected !== null && expected > 0) {
      const diff = result.completionTimeSec - expected
      const sign = diff > 0.05 ? '+' : ''
      facts.push(`${elapsed}; the music lasts ${formatSeconds(expected)} at this speed (${sign}${formatSeconds(diff)})`)
    } else facts.push(elapsed)
  }

  if (goal !== null && goal > 1)
    facts.push(
      result.targetReached
        ? `Goal reached: ${goal} clean in a row`
        : `${result.streak} of ${goal} clean in a row toward the goal`,
    )
  else if (result.streak > 1) facts.push(`${result.streak} clean in a row`)
  return facts
}
