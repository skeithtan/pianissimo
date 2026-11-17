/**
 * Plain-language text for the practice screen (no framework). The result card no longer shows the
 * completion time, first-try share or help (U97): Results words those (`core/history/scorecard`).
 */
import type { AttemptTiming } from '../../app/session'

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
