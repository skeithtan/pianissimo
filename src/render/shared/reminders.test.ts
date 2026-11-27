import { describe, expect, it } from 'vitest'
import type { PreparedLayout } from '../types'
import { layoutReminders, REMINDER_TICK_H, remindersKey, type ReminderMark } from './reminders'

/** Parses the start, apex and end `[x, y]` points of a caret path (`M x0 y0 Q ... ax ay Q ... x1 y1`). */
function caretPoints(d: string): { start: [number, number]; apex: [number, number]; end: [number, number] } {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  // M x0 y0 Q c1x c1y ax ay Q c2x c2y x1 y1 => 10 numbers
  expect(nums).toHaveLength(10)
  return {
    start: [nums[0]!, nums[1]!],
    apex: [nums[4]!, nums[5]!],
    end: [nums[8]!, nums[9]!],
  }
}

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
      // 0: top staff, x=100..112, y=95..105 (stem clearance above: 95 - 36 = 59)
      { index: 0, staff: 0, occ: 0, head: { x: 100, y: 95, w: 12, h: 10 } },
      // 1: bottom staff, x=100..112, y=195..205 (stem clearance below: 205 + 36 = 241)
      { index: 1, staff: 1, occ: 0, head: { x: 100, y: 195, w: 12, h: 10 } },
      // 2: top staff high note nearby, x=108..120, y=68..78 (stem clearance above: 68 - 36 = 32)
      { index: 2, staff: 0, occ: 0, head: { x: 108, y: 68, w: 12, h: 10 } },
      // 3: top staff isolated note, x=220..232, y=95..105 (stem clearance above: 59)
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
  it('places a top-staff tick above the top staff and clear of a nearby notehead stem clearance', () => {
    const layout = miniLayout()
    const [shape] = layoutReminders(layout, [{ notes: [0], level: 'faint' }])
    expect(shape).toBeDefined()
    expect(shape!.side).toBe('above')
    expect(shape!.cx).toBeCloseTo(106)
    // Top staff top is 80; nearby note 2 has head.y = 68, so stem clearance is 68 - 36 = 32.
    expect(shape!.tickY1).toBeLessThanOrEqual(32)
    expect(shape!.tickY1).toBeLessThan(layout.staves[0]!.top)
    expect(REMINDER_TICK_H).toBeGreaterThanOrEqual(6)
    expect(REMINDER_TICK_H).toBeLessThanOrEqual(7)
    expect(shape!.tickY1 - shape!.tickY0).toBeCloseTo(REMINDER_TICK_H)
    expect(shape!.strokes).toHaveLength(1)
    // Symmetric "v" caret above the staff: both arms start at tickY0, apex at tickY1 (nearest the staff).
    const { start, apex, end } = caretPoints(shape!.strokes[0]!)
    expect(start[1]).toBeCloseTo(shape!.tickY0)
    expect(end[1]).toBeCloseTo(shape!.tickY0)
    expect(apex[1]).toBeCloseTo(shape!.tickY1)
    expect(apex[0]).toBeCloseTo(shape!.cx)
    expect(apex[0] - start[0]).toBeCloseTo(end[0] - apex[0])
    expect(end[0] - start[0]).toBeCloseTo(6)
  })

  it('places a bottom-staff-only mark below the bottom staff as a mirrored caret pointing up', () => {
    const layout = miniLayout()
    const [shape] = layoutReminders(layout, [{ notes: [1], level: 'faint' }])
    expect(shape).toBeDefined()
    expect(shape!.side).toBe('below')
    expect(shape!.cx).toBeCloseTo(106)
    // Bottom staff bottom is 220; note 1 head bottom is 205, stem clearance is 205 + 36 = 241.
    expect(shape!.tickY0).toBeGreaterThanOrEqual(241)
    expect(shape!.tickY0).toBeGreaterThan(layout.staves[1]!.bottom)
    expect(shape!.tickY1 - shape!.tickY0).toBeCloseTo(REMINDER_TICK_H)
    // Mirrored caret below the staff: apex at tickY0 (nearest the staff), both arms end at tickY1.
    const { start, apex, end } = caretPoints(shape!.strokes[0]!)
    expect(apex[1]).toBeCloseTo(shape!.tickY0)
    expect(start[1]).toBeCloseTo(shape!.tickY1)
    expect(end[1]).toBeCloseTo(shape!.tickY1)
    expect(apex[0]).toBeCloseTo(shape!.cx)
    expect(apex[0] - start[0]).toBeCloseTo(end[0] - apex[0])
    expect(end[0] - start[0]).toBeCloseTo(6)
  })

  it('places a two-staff chord as one tick above the top staff centered on the union of noteheads', () => {
    const layout = miniLayout()
    const shapes = layoutReminders(layout, [{ notes: [3, 4], level: 'faint' }])
    expect(shapes).toHaveLength(1)
    expect(shapes[0]!.side).toBe('above')
    // Union of x=220..232 and x=230..242 is 220..242 -> center 231.
    expect(shapes[0]!.cx).toBeCloseTo(231)
    expect(shapes[0]!.tickY1).toBeLessThan(layout.staves[0]!.top)
  })

  it('draws firm marks with two strokes at the same tick height', () => {
    const layout = miniLayout()
    const [faint, firm] = layoutReminders(layout, [
      { notes: [3], level: 'faint' },
      { notes: [4], level: 'firm' },
    ])
    expect(faint!.strokes).toHaveLength(1)
    expect(firm!.strokes).toHaveLength(2)
    expect(firm!.tickY1 - firm!.tickY0).toBeCloseTo(faint!.tickY1 - faint!.tickY0)
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

  it('keeps two horizontally close ticks on the same side without stacking rows', () => {
    const layout = miniLayout()
    const shapes = layoutReminders(layout, [
      { notes: [3], level: 'faint' },
      { notes: [5], level: 'faint' },
    ])
    expect(shapes).toHaveLength(2)
    expect(Math.abs(shapes[1]!.cx - shapes[0]!.cx)).toBeLessThan(6)
    expect(shapes[0]!.tickY0).toBeCloseTo(shapes[1]!.tickY0)
    expect(shapes[0]!.tickY1).toBeCloseTo(shapes[1]!.tickY1)
  })
})
