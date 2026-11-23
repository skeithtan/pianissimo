import { msg } from '../../i18n/messages'
/**
 * The four modes of the score screen in words (DECISIONS U141): the label and the one-line
 * description every place shows.
 */
import type { PracticeMode } from '../../core/model/practice'

const LABELS: Readonly<Record<PracticeMode, string>> = {
  listen: 'Listen',
  wait: 'Wait',
  time: 'Keep time',
  follow: 'Follow',
}

const DESCRIPTIONS: Readonly<Record<PracticeMode, string>> = {
  listen: 'The app plays it for you.',
  wait: 'The score waits until you play the right notes.',
  time: 'The score keeps going, whatever you play.',
  follow: 'The score follows your playing. Nothing is graded.',
}

/** In the order every control shows them. */
export const MODES: readonly PracticeMode[] = ['listen', 'wait', 'time', 'follow']

export function modeLabel(mode: PracticeMode): string {
  return msg(LABELS[mode])
}

export function modeDescription(mode: PracticeMode): string {
  return msg(DESCRIPTIONS[mode])
}
