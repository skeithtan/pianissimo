import type { Hand } from '../../core/model/score'
import { MIDI_MAX_PIANO, MIDI_MIN_PIANO } from '../../core/music/pitch'
import type { KeyRange } from './layout'

/** The whole 88-key piano, A0–C8 (DECISIONS U15): the guide never shows a sub-range. */
export const PIANO: KeyRange = { low: MIDI_MIN_PIANO, high: MIDI_MAX_PIANO }

/** Note-name labels stack in up to this many lanes above the keys; the area is always reserved. */
export const MAX_LANES = 3
export const CHIP_HEIGHT = 16
export const LANE_STEP = 18
/** Room between the lowest label lane and the keys, where the roll arrow runs. */
export const ROLL_GAP = 12
export const LABELS_HEIGHT = MAX_LANES * LANE_STEP + 2
export const KEYS_TOP = LABELS_HEIGHT + ROLL_GAP

/** Keys scale with the white-key width, within bounds, so the panel stays compact. */
export const MIN_KEYS_HEIGHT = 52
export const MAX_KEYS_HEIGHT = 96
export const BLACK_KEY_RATIO = 0.62

/** White keys narrower than this show only middle C as a landmark (C1…C8 would collide). */
export const ALL_LANDMARKS_MIN_WHITE = 14

/** Fixed per width: the panel never changes height while playing. */
export function keysHeight(whiteWidth: number): number {
  return Math.round(Math.min(MAX_KEYS_HEIGHT, Math.max(MIN_KEYS_HEIGHT, whiteWidth * 4.4)))
}

export function boardHeight(whiteWidth: number): number {
  return KEYS_TOP + keysHeight(whiteWidth) + 1
}

/** Top edge of a label chip in a lane (lane 0 sits nearest the keys). */
export function chipTop(lane: number): number {
  return LABELS_HEIGHT - (lane + 1) * LANE_STEP + (LANE_STEP - CHIP_HEIGHT) / 2
}

export type HandAttr = 'L' | 'R' | 'N'

/** Value of `data-hand`: a hand letter, or `N` for a neutral key (no hand or a unison). */
export function handAttr(hand: Hand | null): HandAttr {
  return hand ?? 'N'
}

/** SVG path data, centered on the origin, for the played tick. */
export function checkPath(r: number): string {
  return `M${-0.52 * r} ${0.04 * r}L${-0.12 * r} ${0.46 * r}L${0.56 * r} ${-0.42 * r}`
}

/** SVG path data, centered on the origin, for the wrong-key cross. */
export function crossPath(r: number): string {
  return `M${-0.42 * r} ${-0.42 * r}L${0.42 * r} ${0.42 * r}M${0.42 * r} ${-0.42 * r}L${-0.42 * r} ${0.42 * r}`
}
