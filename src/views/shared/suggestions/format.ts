import { msg, decimal } from '../../../i18n/messages'
/** Pure text helpers for the suggestion list (no DOM, no Preact). */
import type { Suggestion, SuggestionBar } from '../../../core/history'
import type { HandSelection } from '../../../core/model/score'

const HANDS: Readonly<Record<HandSelection, string>> = {
  both: 'Both hands',
  right: 'Right hand',
  left: 'Left hand',
  none: 'Listen',
}

export function handsText(hands: HandSelection): string {
  return msg(HANDS[hands])
}

/** "0.75×" (at most two decimals, no trailing zeros). */
export function speedText(multiplier: number): string {
  return `${decimal(Number(multiplier.toFixed(2)))}×`
}

/** "Bar 13" or "Bars 12–14" for a list of consecutive bars; labels carry "(pass 2)" where needed. */
export function barsTitle(bars: readonly SuggestionBar[]): string {
  const first = bars[0]
  const last = bars[bars.length - 1]
  if (first === undefined || last === undefined) return msg('Passage')
  return first.occ === last.occ ? msg('Bar {0}', first.label) : msg('Bars {0}–{1}', first.label, last.label)
}

/** The title of the difficult bars only (what the evidence is about), e.g. "Bar 13". */
export function difficultTitle(bars: readonly SuggestionBar[]): string {
  return barsTitle(bars.filter((b) => b.role === 'difficult'))
}

export function kindText(kind: Suggestion['kind']): string | null {
  return kind === 'restart' ? msg('Repeated restarts') : null
}

/** What a screen reader says for one bar chip. */
export function barSpeech(bar: SuggestionBar): string {
  return msg('Bar {0}, {1}', bar.label, bar.role === 'difficult' ? msg('difficult bar') : msg('context bar'))
}
