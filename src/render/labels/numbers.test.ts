import { describe, expect, it } from 'vitest'
import { intersects } from '../geom'
import { placeMeasureNumbers } from './numbers'

const TOP = 100

describe('placeMeasureNumbers (R6)', () => {
  it('puts numbers right of the barline at the default height when nothing is in the way', () => {
    const boxes = placeMeasureNumbers(
      [
        { x0: 0, w: 15 },
        { x0: 200, w: 20 },
      ],
      [],
      TOP,
      13,
    )
    expect(boxes).toEqual([
      { x: 2, y: 81, w: 15, h: 13 },
      { x: 202, y: 81, w: 20, h: 13 },
    ])
  })

  it('moves a number up past engraved marks above the staff, never down into it', () => {
    const tempo = { x: 10, y: 78, w: 40, h: 14 }
    const [b] = placeMeasureNumbers([{ x0: 0, w: 15 }], [tempo], TOP, 13)
    expect(intersects(b!, tempo)).toBe(false)
    expect(b!.y).toBeLessThan(81)
    expect(b!.y + b!.h).toBeLessThanOrEqual(tempo.y)
  })

  it('ignores marks inside the staff and keeps long pass numbers from overlapping each other', () => {
    const staffMarks = [{ x: 0, y: TOP + 2, w: 400, h: 30 }]
    const boxes = placeMeasureNumbers(
      [
        { x0: 0, w: 61 },
        { x0: 40, w: 61 },
      ],
      staffMarks,
      TOP,
      13,
    )
    expect(boxes[0]!.y).toBe(81)
    expect(intersects(boxes[0]!, boxes[1]!)).toBe(false)
  })
})
