import { describe, expect, it } from 'vitest'
import type { PreparedLayout } from '../types'
import { layoutReminders, remindersKey, type ReminderMark } from './reminders'

function miniLayout(): PreparedLayout {
  return {
    width: 400,
    height: 300,
    top: 0,
    staves: [
      { index: 0, top: 80, bottom: 120 },
      { index: 1, top: 180, bottom: 220 },
    ],
    notes: [
      // 0: top staff, x=100..112, y=95..105
      { index: 0, staff: 0, occ: 0, head: { x: 100, y: 95, w: 12, h: 10 } },
      // 1: bottom staff, x=100..112, y=195..205
      { index: 1, staff: 1, occ: 0, head: { x: 100, y: 195, w: 12, h: 10 } },
      // 2: top staff, a chord's upper note: x=108..120, y=68..78
      { index: 2, staff: 0, occ: 0, head: { x: 108, y: 68, w: 12, h: 10 } },
      // 3: top staff, x=220..232, y=95..105
      { index: 3, staff: 0, occ: 1, head: { x: 220, y: 95, w: 12, h: 10 } },
      // 4: bottom staff shifted right, x=230..242, y=195..205
      { index: 4, staff: 1, occ: 1, head: { x: 230, y: 195, w: 12, h: 10 } },
      // 5: top staff very close to note 3 (4 px away horizontally)
      { index: 5, staff: 0, occ: 1, head: { x: 224, y: 95, w: 12, h: 10 } },
    ],
    occurrences: [
      { occ: 0, x0: 80, x1: 180, label: '1', labelBox: { x: 80, y: 60, w: 12, h: 12 } },
      { occ: 1, x0: 180, x1: 280, label: '2', labelBox: { x: 180, y: 60, w: 12, h: 12 } },
    ],
    labels: [],
    ottavas: [],
    segments: [],
  } as unknown as PreparedLayout
}

describe('remindersKey', () => {
  it('returns empty string for empty marks and differs by level or notes', () => {
    expect(remindersKey([])).toBe('')
    const a: ReminderMark = { notes: [0], level: 'faint' }
    const b: ReminderMark = { notes: [0], level: 'firm' }
    const c: ReminderMark = { notes: [0, 1], level: 'faint' }
    expect(remindersKey([a])).toBe(remindersKey([{ notes: [0], level: 'faint' }]))
    expect(remindersKey([a])).not.toBe(remindersKey([b]))
    expect(remindersKey([a])).not.toBe(remindersKey([c]))
  })
})

describe('layoutReminders', () => {
  const inside = (
    p: { x0: number; y0: number; x1: number; y1: number },
    h: { x: number; y: number; w: number; h: number },
  ) => p.x0 < h.x && p.y0 < h.y && p.x1 > h.x + h.w && p.y1 > h.y + h.h

  it('draws one pass behind the notehead, centered on it, inside the element box', () => {
    const layout = miniLayout()
    const [shape] = layoutReminders(layout, [{ notes: [0], level: 'faint' }])
    expect(shape!.cx).toBeCloseTo(106)
    expect(shape!.passes).toHaveLength(1)
    expect(shape!.second).toHaveLength(0)
    const pass = shape!.passes[0]!
    expect(inside(pass, layout.notes[0]!.head)).toBe(true)
    expect((pass.x0 + pass.x1) / 2).toBeCloseTo(106)
    expect(shape!.x0).toBeLessThan(pass.x0)
    expect(shape!.y1).toBeGreaterThan(pass.y1)
  })

  it('draws a two-staff chord as one mark with a pass on each staff, top first', () => {
    const layout = miniLayout()
    const shapes = layoutReminders(layout, [{ notes: [4, 3], level: 'faint' }])
    expect(shapes).toHaveLength(1)
    // Union of x=220..232 and x=230..242 is 220..242 -> center 231.
    expect(shapes[0]!.cx).toBeCloseTo(231)
    const [top, bottom] = shapes[0]!.passes
    expect(inside(top!, layout.notes[3]!.head)).toBe(true)
    expect(inside(bottom!, layout.notes[4]!.head)).toBe(true)
  })

  it('covers every notehead of a chord on one staff with a single pass', () => {
    const layout = miniLayout()
    const [shape] = layoutReminders(layout, [{ notes: [0, 2], level: 'faint' }])
    expect(shape!.passes).toHaveLength(1)
    expect(inside(shape!.passes[0]!, layout.notes[0]!.head)).toBe(true)
    expect(inside(shape!.passes[0]!, layout.notes[2]!.head)).toBe(true)
  })

  it('gives a firm mark a second pass over each staff that still covers the notes', () => {
    const layout = miniLayout()
    const [shape] = layoutReminders(layout, [{ notes: [3, 4], level: 'firm' }])
    expect(shape!.second).toHaveLength(2)
    shape!.second.forEach((p, i) => {
      expect(inside(p, layout.notes[3 + i]!.head)).toBe(true)
      expect(p).not.toEqual(shape!.passes[i])
    })
  })

  it('produces nothing for marks whose notes are not in the layout', () => {
    const layout = miniLayout()
    expect(
      layoutReminders(layout, [
        { notes: [999], level: 'faint' },
        { notes: [], level: 'firm' },
      ]),
    ).toEqual([])
  })

  it('orders marks left to right', () => {
    const layout = miniLayout()
    const shapes = layoutReminders(layout, [
      { notes: [3], level: 'faint' },
      { notes: [0], level: 'firm' },
    ])
    expect(shapes.map((s) => s.mark.notes[0])).toEqual([0, 3])
  })
})
