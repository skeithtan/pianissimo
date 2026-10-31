/** Plain-language text for the practice screen (no framework). */
import type { AttemptSummary } from '../../app/session'

export function seconds(s: number): string {
  return `${s < 10 ? s.toFixed(1) : Math.round(s * 10) / 10} s`
}

/** "12.4 s · expected 10.0 s (+2.4 s, +24%)"; null when the attempt has no time. */
export function timeLine(r: AttemptSummary): string | null {
  if (r.completionTimeSec === null) return null
  if (r.expectedTimeSec === null) return seconds(r.completionTimeSec)
  const diff = r.completionTimeSec - r.expectedTimeSec
  const sign = diff >= 0 ? '+' : '−'
  const pct = r.expectedTimeSec > 0 ? `, ${sign}${Math.abs(Math.round((diff / r.expectedTimeSec) * 100))}%` : ''
  return `${seconds(r.completionTimeSec)} · expected ${seconds(r.expectedTimeSec)} (${sign}${seconds(Math.abs(diff))}${pct})`
}

export function assistanceText(r: AttemptSummary): string {
  if (r.assistance === 'keyboard') return 'Keyboard guide used'
  if (r.assistance === 'names') return r.persistentLabels ? 'Note names on the score' : 'Note-name hints used'
  return 'No help'
}

export function wrongText(n: number): string {
  return n === 0 ? 'No wrong notes' : n === 1 ? '1 wrong note' : `${n} wrong notes`
}

export function firstPassText(r: AttemptSummary): string {
  if (r.groupsTotal === 0) return ''
  return `${Math.round((r.groupsFirstPass / r.groupsTotal) * 100)}% right first time`
}
