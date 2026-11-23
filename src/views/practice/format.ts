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

/** What a pass without anything to correct says first, or null. */
export function cleanText(r: AttemptSummary): string | null {
  const clean =
    r.wrongAttacks === 0 && r.groupsFirstPass === r.groupsTotal && (!r.timing || r.timing.onTime === r.timing.groups)
  if (!clean) return null
  return r.passed ? msg('No mistakes in this pass.') : msg('No wrong keys or timing marks in this pass.')
}

/** The "This pass" lines in display order. The pill of a pass without mistakes peeks at them. */
export function passFacts(result: AttemptSummary, goal: number | null): string[] {
  const facts: string[] = []
  if (result.groupsTotal > 0)
    facts.push(msg('Right the first time at {0} of {1} places', result.groupsFirstPass, result.groupsTotal))

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

/** "Clean pass: no wrong notes." or why not, in one plain sentence. */
export function verdict(r: AttemptSummary): string {
  if (r.passed) return msg('Clean pass: no wrong notes.')
  if (r.wrongAttacks === 1) return msg('Not clean: 1 wrong note.')
  if (r.wrongAttacks > 0) return msg('Not clean: {0} wrong notes.', r.wrongAttacks)
  if (r.timing && r.timing.onTime < r.timing.groups) return msg('Not clean: the timing slipped.')
  return msg('Completed, but not counted as clean.')
}
