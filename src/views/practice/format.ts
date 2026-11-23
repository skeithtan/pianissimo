import { msg } from '../../i18n/messages'
/** Plain-language text shared by the practice result summary and its details. */
import type { AttemptSummary, AttemptTiming } from '../../app/session'
import { formatSeconds } from '../../core/history'

/** "On time 38 of 42 · 3 late · 1 missed": a Keep time attempt's timing (zero counts left out). */
export function timingText(t: AttemptTiming): string {
  const parts = [msg('On time {0} of {1}', t.onTime, t.groups)]
  if (t.early > 0) parts.push(msg('{0} early', t.early))
  if (t.late > 0) parts.push(msg('{0} late', t.late))
  if (t.missed > 0) parts.push(missedText(t.missed))
  return parts.join(' · ')
}

/** "1 missed" / "3 missed": a separate singular, as French and Spanish agree it with the count. */
export function missedText(n: number): string {
  return n === 1 ? msg('1 missed') : msg('{0} missed', n)
}

export function wrongText(n: number): string {
  return n === 0 ? msg('No wrong notes') : n === 1 ? msg('1 wrong note') : msg('{0} wrong notes', n)
}

function passHelpText(result: AttemptSummary): string {
  if (result.assistance === 'keyboard') return msg('Help: the keyboard guide')
  if (result.assistance === 'names') return msg('Help: note names')
  return result.persistentLabels ? msg('Help: note names on the score') : msg('No help used')
}

/** The "This pass" lines in display order. The pill previews the beginning of this list. */
export function passFacts(result: AttemptSummary, goal: number | null): string[] {
  const facts: string[] = []
  if (result.groupsTotal > 0)
    facts.push(msg('Right the first time at {0} of {1} places', result.groupsFirstPass, result.groupsTotal))
  facts.push(passHelpText(result))

  if (result.timing) facts.push(timingText(result.timing))
  else if (result.completionTimeSec !== null) {
    const elapsed = msg('Took {0}', formatSeconds(result.completionTimeSec))
    const expected = result.expectedTimeSec
    if (expected !== null && expected > 0) {
      const diff = result.completionTimeSec - expected
      const sign = diff > 0.05 ? '+' : ''
      facts.push(
        msg(
          '{0}; the music lasts {1} at this speed ({2}{3})',
          elapsed,
          formatSeconds(expected),
          sign,
          formatSeconds(diff),
        ),
      )
    } else facts.push(elapsed)
  }

  if (goal !== null && goal > 1)
    facts.push(
      result.targetReached
        ? msg('Goal reached: {0} clean in a row', goal)
        : msg('{0} of {1} clean in a row toward the goal', result.streak, goal),
    )
  else if (result.streak > 1) facts.push(msg('{0} clean in a row', result.streak))
  return facts
}
