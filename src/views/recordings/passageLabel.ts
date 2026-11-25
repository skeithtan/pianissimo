import { describePassage, type PassageWords } from '../../core/model/passage'
import type { PassageRange } from '../../core/model/practice'
import type { RecordingInfo } from '../../core/recording/records'
import { msg } from '../../i18n/messages'

/**
 * What a take stores about its passage: the range, from which the label is rebuilt in whatever
 * language is current when it is shown, and the label of the moment as a fallback.
 */
export function passageFields(
  model: PassageWords,
  range: PassageRange | null,
  hands: RecordingInfo['hands'],
): Pick<RecordingInfo, 'passage' | 'passageRange'> {
  return { passage: describePassage(model, range, hands), passageRange: range }
}

function contextField(info: Pick<RecordingInfo, 'context'>, index: number): string | undefined {
  try {
    const context: unknown = JSON.parse(info.context)
    return Array.isArray(context) && typeof context[index] === 'string' ? context[index] : undefined
  } catch {
    return undefined
  }
}

/** The score version a take was recorded from: the second field of its comparison context. */
export const takeScoreVersion = (info: Pick<RecordingInfo, 'context'>) => contextField(info, 1)

/** The `passageKey` of a take's bars: the last field of its comparison context. */
export const takePassageKey = (info: Pick<RecordingInfo, 'context'>) => contextField(info, 4)

/**
 * A take's passage label in the current interface language, rebuilt from its stored range with
 * the score `model` of the take's version. A take saved before ranges were stored, or whose
 * score is no longer on this device, shows the label it was saved with.
 */
export function takePassageLabel(info: RecordingInfo, model: PassageWords | undefined): string {
  const range = info.passageRange
  if (range === null) return msg('Whole piece')
  if (range !== undefined && model) {
    try {
      return describePassage(model, range, info.hands)
    } catch {
      // The score of this version no longer has these bars: keep the stored label.
    }
  }
  return msg(info.passage)
}
