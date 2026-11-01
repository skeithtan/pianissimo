import { describe, expect, it } from 'vitest'
import { staffGap } from './cursorAction'

describe('staffGap', () => {
  it('is the gap between the two staves of a grand staff, none for one staff', () => {
    expect(staffGap([{ top: 100, bottom: 140 }])).toBeNull()
    expect(
      staffGap([
        { top: 100, bottom: 140 },
        { top: 200, bottom: 240 },
      ]),
    ).toEqual({ top: 140, bottom: 200 })
  })

  it('takes the gap nearest the middle of several staves', () => {
    const staves = [
      { top: 0, bottom: 40 },
      { top: 100, bottom: 140 },
      { top: 200, bottom: 240 },
      { top: 300, bottom: 340 },
    ]
    expect(staffGap(staves)).toEqual({ top: 140, bottom: 200 })
  })
})
