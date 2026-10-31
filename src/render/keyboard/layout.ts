/** Inclusive first and last drawn key (MIDI). Both are white keys. */
export interface KeyRange {
  readonly low: number
  readonly high: number
}

const BLACK_PITCH_CLASSES: ReadonlySet<number> = new Set([1, 3, 6, 8, 10])

export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12)
}

export interface KeyGeometry {
  readonly midi: number
  readonly black: boolean
  readonly x: number
  readonly width: number
  /** Horizontal center: a white key's middle, or the boundary a black key straddles. */
  readonly cx: number
  readonly isC: boolean
}

export interface KeyboardLayout {
  readonly range: KeyRange
  readonly width: number
  readonly whiteWidth: number
  readonly blackWidth: number
  /** White keys then black keys (paint order). */
  readonly keys: readonly KeyGeometry[]
  /** Geometry of one key, or undefined when it is outside the range. */
  keyAt(midi: number): KeyGeometry | undefined
  /** Center x of a key, clamped to the drawing for pitches outside the range. */
  centerX(midi: number): number
}

export const BLACK_KEY_WIDTH_RATIO = 0.6

/** Number of white keys in a range: the unit the drawing width is divided by. */
export function countWhiteKeys(range: KeyRange): number {
  let count = 0
  for (let midi = range.low; midi <= range.high; midi++) if (!isBlackKey(midi)) count++
  return count
}

/**
 * Horizontal geometry of a keyboard window: white keys share `width` equally (key width shrinks
 * as the range grows, nothing is cropped) and black keys straddle the boundary after their
 * lower white neighbor.
 */
export function buildLayout(range: KeyRange, width: number): KeyboardLayout {
  const whites: number[] = []
  for (let midi = range.low; midi <= range.high; midi++) if (!isBlackKey(midi)) whites.push(midi)
  const whiteWidth = width / Math.max(1, whites.length)
  const blackWidth = whiteWidth * BLACK_KEY_WIDTH_RATIO
  const whiteIndex = new Map(whites.map((midi, i) => [midi, i]))

  const whiteKeys: KeyGeometry[] = whites.map((midi, i) => ({
    midi,
    black: false,
    x: i * whiteWidth,
    width: whiteWidth,
    cx: (i + 0.5) * whiteWidth,
    isC: midi % 12 === 0,
  }))
  const blackKeys: KeyGeometry[] = []
  for (let midi = range.low; midi <= range.high; midi++) {
    if (!isBlackKey(midi)) continue
    const below = whiteIndex.get(midi - 1)
    const cx = ((below ?? -1) + 1) * whiteWidth
    blackKeys.push({ midi, black: true, x: cx - blackWidth / 2, width: blackWidth, cx, isC: false })
  }
  const keys = [...whiteKeys, ...blackKeys]
  const byMidi = new Map(keys.map((k) => [k.midi, k]))

  return {
    range,
    width,
    whiteWidth,
    blackWidth,
    keys,
    keyAt: (midi) => byMidi.get(midi),
    centerX(midi) {
      const key = byMidi.get(midi)
      if (key) return key.cx
      return midi < range.low ? 0 : width
    },
  }
}

/** A label to place: its preferred left edge, its width and the x it points at. */
export interface LabelItem {
  readonly left: number
  readonly width: number
  readonly anchor: number
}

export interface LabelPlacement {
  readonly lane: number
  readonly left: number
}

/**
 * Lane assignment for the note-name labels above the keys: a label that would collide with one
 * already placed goes up a lane, and when every lane is taken at its preferred position (dense
 * clusters on narrow screens) it slides right in the lane where it moves least (ties: the lowest
 * lane), so nothing moves while a free lane exists. Lane 0 sits nearest the keys, so there a
 * label may only slide while it still covers its anchor (by `inset`); higher lanes draw a leader.
 * A label never leaves `[0, limit]`; only when no lane can take it does it overlap (in the lane
 * that ends earliest), so nothing is dropped. Results are in input order.
 */
export function placeLabels(
  items: readonly LabelItem[],
  maxLanes: number,
  limit: number,
  gap = 3,
  inset = 3,
): LabelPlacement[] {
  const placements = items.map((item) => ({ lane: 0, left: item.left }))
  const laneRight: number[] = []
  const order = items
    .map((_, i) => i)
    .sort((a, b) => (items[a]?.left ?? 0) - (items[b]?.left ?? 0) || (items[a]?.anchor ?? 0) - (items[b]?.anchor ?? 0))
  for (const i of order) {
    const item = items[i]
    if (!item) continue
    let best: LabelPlacement | null = null
    for (let lane = 0; lane < maxLanes; lane++) {
      const right = laneRight[lane]
      const left = right === undefined ? item.left : Math.max(item.left, right + gap)
      if (left + item.width > limit + 1e-6) continue
      if (lane === 0 && left > item.left && item.anchor < left + inset) continue
      if (!best || left - item.left < best.left - item.left - 1e-6) best = { lane, left }
    }
    if (!best) {
      const lane = laneRight.indexOf(Math.min(...laneRight))
      best = { lane: Math.max(0, lane), left: item.left }
    }
    laneRight[best.lane] = Math.max(laneRight[best.lane] ?? -Infinity, best.left + item.width)
    placements[i] = best
  }
  return placements
}
