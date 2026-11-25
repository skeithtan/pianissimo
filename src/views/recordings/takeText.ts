import type { RecordingInfo } from '../../core/recording/records'
import { dateText } from '../../i18n/dates'
import { msg } from '../../i18n/messages'

export function handName(hands: RecordingInfo['hands']) {
  return hands === 'both' ? msg('Both hands') : hands === 'left' ? msg('Left hand') : msg('Right hand')
}

/** How long a take is. With its units: beside a time of day, 1:32 would read as another one. */
export function lengthText(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? msg('{0} s', seconds) : msg('{0} min {1} s', Math.floor(seconds / 60), seconds % 60)
}

export function dayText(at: number, weekday: 'long' | 'short' = 'long'): string {
  return dateText(at, { weekday, day: 'numeric', month: weekday, year: 'numeric' })
}
