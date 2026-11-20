import { msg, messageLanguage } from '../../i18n/messages'
/**
 * Small display helpers for the Library (pure, tested in `format.test.ts`).
 */
import { formatSpeedPercent } from '../../ui/speed'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "just now", "5 minutes ago", "today at 14:05"-free wording: "today", "yesterday", "3 days ago", "12 Oct 2026". */
export function formatRelativeTime(at: number, now: number): string {
  const diff = now - at
  if (diff < MINUTE) return msg('just now')
  const relative = (n: number, unit: Intl.RelativeTimeFormatUnit) =>
    new Intl.RelativeTimeFormat(messageLanguage()).format(-n, unit)
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE)
    return relative(m, 'minute')
  }
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)
  if (days <= 0) {
    const h = Math.floor(diff / HOUR)
    return relative(h, 'hour')
  }
  if (days === 1) return msg('yesterday')
  if (days < 7) return relative(days, 'day')
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "75% speed" (the Practice view shows speed as a percentage, DECISIONS U7). */
export function formatLastSpeed(multiplier: number): string {
  return msg('{0} speed', formatSpeedPercent(multiplier))
}

/** "1.2 MB", "820 kB", "3 bytes". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return msg('{0} bytes', bytes)
  const units = messageLanguage().startsWith('fr') ? ['ko', 'Mo', 'Go', 'To'] : ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${new Intl.NumberFormat(messageLanguage(), { maximumFractionDigits: value >= 100 ? 0 : 1 }).format(value)} ${units[unit]}`
}

/** "1 piece" / "3 pieces". */
export { plural } from '../../i18n/messages'
