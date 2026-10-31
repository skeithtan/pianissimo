import { placeLabels, type KeyboardLayout } from './layout'
import { MAX_LANES } from './metrics'
import type { GuideKey } from './types'

/** Approximate advance of the 11 px label font; labels are short ("C♯4", "sol♭3"). */
const CHAR_WIDTH = 6.6
const PAD_X = 5
/** Room for the tick / cross in front of a played or wrong key's name. */
export const ICON_WIDTH = 11

export interface PlacedLabel {
  readonly key: GuideKey
  /** The x the label points at: the key's center, or the edge for a key beyond A0–C8. */
  readonly anchor: number
  readonly left: number
  readonly width: number
  readonly lane: number
  /** Beyond the 88 keys: no bar, the label points at that edge. */
  readonly edge: 'left' | 'right' | null
}

export function hasIcon(key: GuideKey): boolean {
  return key.state === 'accepted' || key.state === 'wrong'
}

export function labelWidth(key: GuideKey): number {
  return Math.ceil(key.label.length * CHAR_WIDTH + 2 * PAD_X + (hasIcon(key) ? ICON_WIDTH : 0))
}

/**
 * One label per highlighted key, low to high, centered over its key and stacked into lanes (or
 * slid sideways) so labels never cover each other, however dense the chord or narrow the panel.
 */
export function placeGuideLabels(keys: readonly GuideKey[], layout: KeyboardLayout): PlacedLabel[] {
  const sorted = [...keys].sort((a, b) => a.midi - b.midi)
  const items = sorted.map((key) => {
    const anchor = layout.centerX(key.midi)
    const width = Math.min(labelWidth(key), layout.width)
    const left = Math.min(Math.max(0, anchor - width / 2), Math.max(0, layout.width - width))
    return { left, width, anchor }
  })
  const placed = placeLabels(items, MAX_LANES, layout.width)
  return sorted.map((key, i) => {
    const item = items[i]!
    const p = placed[i]!
    const edge = layout.keyAt(key.midi) ? null : key.midi < layout.range.low ? 'left' : 'right'
    return { key, anchor: item.anchor, left: p.left, width: item.width, lane: p.lane, edge }
  })
}
