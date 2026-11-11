import { TRANSPORT_KINDS, measureContextKey } from '../model/practice'
import type { ComparisonContext, TransportKind } from '../model/practice'
import type { HandSelection } from '../model/score'
import type { MeasureContext } from './types'

const HANDS: readonly string[] = ['both', 'right', 'left', 'none']

/** The passage-free part of a comparison context. */
export function toMeasureContext(c: ComparisonContext | MeasureContext): MeasureContext {
  return {
    scoreVersionId: c.scoreVersionId,
    hands: c.hands,
    handsId: c.handsId,
    tempoMapId: c.tempoMapId,
    multiplier: c.multiplier,
    rollPolicy: c.rollPolicy,
    transport: c.transport,
    matchingRules: c.matchingRules,
  }
}

/**
 * Inverse of `measureContextKey`. Abandon events carry only the key, so suggestions built
 * from them recover hands and tempo here. Parses from the end so a score-version id may
 * contain `|`. Returns null when the key is not in the current format; the caller then
 * records the event but does not build a suggestion.
 */
export function parseMeasureContextKey(key: string): MeasureContext | null {
  const parts = key.split('|')
  if (parts.length < 8) return null
  const matchingRules = parts.pop()
  const transport = parts.pop()
  const rollPolicy = parts.pop()
  const multiplierText = parts.pop()
  const tempoMapId = parts.pop()
  const handsId = parts.pop()
  const hands = parts.pop()
  const scoreVersionId = parts.join('|')
  if (
    matchingRules === undefined ||
    rollPolicy === undefined ||
    tempoMapId === undefined ||
    handsId === undefined ||
    multiplierText === undefined ||
    hands === undefined ||
    scoreVersionId === ''
  ) {
    return null
  }
  if (!HANDS.includes(hands)) return null
  if (transport === undefined || !(TRANSPORT_KINDS as readonly string[]).includes(transport)) return null
  const multiplier = Number(multiplierText)
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null
  const context: MeasureContext = {
    scoreVersionId,
    hands: hands as HandSelection,
    handsId,
    tempoMapId,
    multiplier,
    rollPolicy,
    transport: transport as TransportKind,
    matchingRules,
  }
  return measureContextKey(context) === key ? context : null
}
