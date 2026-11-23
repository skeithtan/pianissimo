import { msg, decimal, plural } from '../../i18n/messages'
/** Display text for the scorecard, the history and Progress. Pure; locale-dependent only in `whenText`. */
import { formatSeconds, timeDifferenceSec, timingAccuracy } from '../../core/history'
import type { AttemptRecord, ComparisonContext, InterruptReason } from '../../core/model/practice'

export function whenText(ms: number, now: number = Date.now()): string {
  const date = new Date(ms)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return msg('Today, {0}', time)
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
  if (a.interruptReason !== undefined) return msg(REASON[a.interruptReason])
  return a.completion === 'abandoned' ? msg('Abandoned') : msg('Interrupted')
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
  if (rhythm !== null) return msg('{0} of {1} on time', rhythm.onTime, rhythm.groups)
  if (a.completionTimeSec === undefined) return '—'
  const base = formatSeconds(a.completionTimeSec)
  const diff = signedTime(a)
  return diff === null ? base : `${base} (${diff})`
}

/** A pass in a few words: "8.4 s (+0.4 s)", "38 of 42 on time · 2 wrong attacks", "Paused · 1 wrong attack". */
export function attemptText(a: AttemptRecord): string {
  const parts = [a.completion === 'completed' ? timeText(a) : incompleteReason(a)]
  if (a.completion !== 'completed' || a.wrongAttacks > 0) parts.push(plural(a.wrongAttacks, 'wrong attack'))
  return parts.join(' · ')
}

/** What ranks a clean pass: its completion time or, in Keep time, its average offset ("±30 ms"). */
export function cleanText(a: AttemptRecord): string {
  if (a.context.transport === 'strict') return `±${Math.round(timingAccuracy(a)?.meanAbsOffsetMs ?? 0)} ms`
  return a.completionTimeSec === undefined ? '—' : formatSeconds(a.completionTimeSec)
}

export function speedText(multiplier: number): string {
  return `${decimal(Number(multiplier.toFixed(2)))}×`
}

const HANDS = { both: 'Both hands', right: 'Right hand', left: 'Left hand', none: 'Listen' } as const

/** The tolerance of a strict context, from its matching rules (`strict-v1-tol-150ms`). */
export function strictToleranceMs(c: ComparisonContext): number | null {
  const m = /^strict-v1-tol-(\d+)ms$/.exec(c.matchingRules)
  return m ? Number(m[1]) : null
}

/** "Keep time · ±150 ms" for a rhythm mode context. */
function rhythmText(c: ComparisonContext): string {
  const tol = strictToleranceMs(c)
  const label = tol === null ? msg('Keep time') : msg('Keep time · ±{0} ms', tol)
  return c.scorePlayback ? msg('{0} · Playback', label) : label
}

/** "Wait", or "Keep time · ±150 ms · Playback". */
export function modeText(c: ComparisonContext): string {
  return c.transport === 'strict' ? rhythmText(c) : msg('Wait')
}

/** "Right hand at 0.75×" */
export function handsAndSpeed(c: ComparisonContext): string {
  return msg('{0} at {1}', msg(HANDS[c.hands]), speedText(c.multiplier))
}
