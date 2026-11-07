/** Display text for the Results view. Pure; locale-dependent only in `whenText`. */
import { formatSeconds, timeDifferenceSec, timingAccuracy } from '../../core/history'
import type { AttemptRecord, ComparisonContext, InterruptReason } from '../../core/model/practice'
import type { PersistentLabelMode } from '../../core/model/settings'

export function whenText(ms: number, now: number = Date.now()): string {
  const date = new Date(ms)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today, ${time}`
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  })
  return `${day}, ${time}`
}

const REASON: Readonly<Record<InterruptReason, string>> = {
  pause: 'Paused',
  seek: 'Position changed',
  disconnect: 'Piano disconnected',
  suspend: 'App in background',
  'setting-change': 'Settings changed',
  'layout-change': 'Layout changed',
  'tempo-change': 'Tempo changed',
  'hand-change': 'Hands changed',
  'range-change': 'Range changed',
  'mode-change': 'Mode changed',
  'user-stop': 'Stopped',
  'user-restart': 'Restarted',
}

/** "Paused", "Stopped"… for an incomplete attempt; "Interrupted" when the reason is unknown. */
export function incompleteReason(a: AttemptRecord): string {
  if (a.interruptReason !== undefined) return REASON[a.interruptReason]
  return a.completion === 'abandoned' ? 'Abandoned' : 'Interrupted'
}

export const LABEL_MODE_TEXT: Readonly<Record<PersistentLabelMode, string>> = {
  off: 'Off',
  all: 'All notes',
  conditional: 'Conditional',
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "+1.2 s" / "-0.4 s" for an attempt with scored timing, otherwise null. */
export function signedTime(a: AttemptRecord): string | null {
  if (a.context.transport === 'strict') return null
  const diff = timeDifferenceSec(a)
  if (diff === null) return null
  return `${diff >= 0 ? '+' : '-'}${formatSeconds(Math.abs(diff))}`
}

/** The compact timing text (rhythm mode: on-time groups) of a history row: "8.4 s (+0.4 s)", "8.4 s" (ungraded) or "—". */
export function timeText(a: AttemptRecord): string {
  const rhythm = timingAccuracy(a)
  if (rhythm !== null) return `${rhythm.onTime} of ${rhythm.groups} on time`
  if (a.completionTimeSec === undefined) return '—'
  const base = formatSeconds(a.completionTimeSec)
  const diff = signedTime(a)
  return diff === null ? base : `${base} (${diff})`
}

export function speedText(multiplier: number): string {
  return `${Number(multiplier.toFixed(2))}×`
}

const HANDS = { both: 'Both hands', right: 'Right hand', left: 'Left hand', none: 'Preview' } as const

/** The tolerance of a strict context, from its matching rules (`strict-v1-tol-150ms`). */
export function strictToleranceMs(c: ComparisonContext): number | null {
  const m = /^strict-v1-tol-(\d+)ms$/.exec(c.matchingRules)
  return m ? Number(m[1]) : null
}

/** "Keep time · ±150 ms" for a rhythm mode context. */
export function rhythmText(c: ComparisonContext): string {
  const tol = strictToleranceMs(c)
  return tol === null ? 'Keep time' : `Keep time · ±${tol} ms`
}

/** What the piano does for the other hand in this context. */
export function transportText(c: ComparisonContext): string | null {
  if (c.transport === 'strict') return rhythmText(c)
  if (c.transport !== 'accompaniment') return null
  return c.hands === 'right'
    ? 'Piano plays the left hand'
    : c.hands === 'left'
      ? 'Piano plays the right hand'
      : 'Piano accompanies'
}

/** "Right hand at 0.75×" */
export function handsAndSpeed(c: ComparisonContext): string {
  return `${HANDS[c.hands]} at ${speedText(c.multiplier)}`
}
