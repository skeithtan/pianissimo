import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { describeGuide } from './describe'
import { keyName } from './landmarks'
import { buildLayout } from './layout'
import { placeGuideLabels } from './labels'
import {
  CHIP_HEIGHT,
  KEYS_TOP,
  LABELS_HEIGHT,
  MAX_KEYS_HEIGHT,
  MAX_LANES,
  MIN_KEYS_HEIGHT,
  PIANO,
  checkPath,
  chipTop,
  crossPath,
  handAttr,
  keysHeight,
} from './metrics'

describe('geometry', () => {
  it('covers the 88 keys and stacks label lanes upward from the keys inside the drawing', () => {
    expect(PIANO).toEqual({ low: 21, high: 108 })
    expect(chipTop(0) + CHIP_HEIGHT).toBeLessThanOrEqual(LABELS_HEIGHT)
    for (let lane = 1; lane < MAX_LANES; lane++)
      expect(chipTop(lane) + CHIP_HEIGHT).toBeLessThanOrEqual(chipTop(lane - 1))
    expect(chipTop(MAX_LANES - 1)).toBeGreaterThanOrEqual(0)
    expect(KEYS_TOP).toBeGreaterThan(LABELS_HEIGHT)
  })

  it('scales key height with the key width, within bounds', () => {
    expect(keysHeight(4)).toBe(MIN_KEYS_HEIGHT)
    expect(keysHeight(15)).toBeGreaterThan(MIN_KEYS_HEIGHT)
    expect(keysHeight(60)).toBe(MAX_KEYS_HEIGHT)
  })

  it('uses the hand letter, or N for a neutral key', () => {
    expect(handAttr('L')).toBe('L')
    expect(handAttr(null)).toBe('N')
  })

  it('draws the tick and the cross inside their radius', () => {
    for (const d of [checkPath(10), crossPath(10)]) {
      const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
      expect(Math.max(...numbers.map(Math.abs))).toBeLessThanOrEqual(10)
    }
  })
})

describe('placeGuideLabels', () => {
  it('centers labels over their keys and points keys beyond the piano at the edge', () => {
    const layout = buildLayout(PIANO, 1040)
    const placed = placeGuideLabels(
      [
        { midi: 60, state: 'target', hand: 'R', label: 'C4', held: false },
        { midi: 12, state: 'target', hand: 'L', label: 'C0', held: false },
      ],
      layout,
    )
    expect(placed.map((p) => p.key.midi)).toEqual([12, 60])
    expect(placed[0]).toMatchObject({ edge: 'left', anchor: 0, left: 0 })
    const c4 = placed[1]!
    expect(c4.edge).toBeNull()
    expect(c4.left + c4.width / 2).toBeCloseTo(layout.centerX(60))
  })
})

describe('describeGuide and keyName', () => {
  it('says what to play and when nothing is required', () => {
    expect(describeGuide([], undefined)).toBe('Keyboard guide. No keys to play.')
    expect(describeGuide([{ midi: 48, state: 'sounding', hand: 'L', label: 'C3', held: false }], 'up')).toBe(
      'Keyboard guide. Sounding: C3. No keys to play. Roll upward, low to high.',
    )
  })

  it('always includes the octave in landmarks and follows fixed do', () => {
    const naming = DEFAULT_SETTINGS.naming
    expect(keyName(60, { ...naming, showOctave: false })).toBe('C4')
    expect(keyName(21, naming)).toBe('A0')
    expect(keyName(71, { ...naming, system: 'fixed-do', seventh: 'ti' })).toBe('ti4')
  })
})
