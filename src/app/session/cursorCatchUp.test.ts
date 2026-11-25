import { describe, expect, it } from 'vitest'
import { CATCH_UP_MOST, CursorCatchUp } from './cursorCatchUp'

const FRAME = 1000 / 60

describe('CursorCatchUp', () => {
  it('starts where the cursor was drawn, closes without a step and arrives', () => {
    const c = new CursorCatchUp()
    c.jump(0.25, 0)
    expect(c.behind(0)).toBe(0.25)
    let last = 0.25
    for (let t = FRAME; t < 1000; t += FRAME) {
      const now = c.behind(t)
      expect(now).toBeLessThanOrEqual(last)
      expect(last - now).toBeLessThan(0.25 * 0.1)
      last = now
    }
    expect(c.behind(280)).toBeLessThan(0.025)
    expect(c.behind(1000)).toBe(0)
  })

  it('jumps during the glide add to it: no step back, none forward, no overshoot', () => {
    const c = new CursorCatchUp()
    let drawn = 0
    let at = 0
    let step = 0
    for (let i = 1; i <= 120; i++) {
      const now = i * FRAME
      if (i % 6 === 1 && i < 60) {
        at += 0.125
        c.jump(0.125, now)
      }
      const next = at - c.behind(now)
      expect(next).toBeGreaterThanOrEqual(drawn - 1e-12)
      expect(next).toBeLessThanOrEqual(at)
      step = Math.max(step, next - drawn)
      drawn = next
    }
    expect(step).toBeLessThan(0.03)
    expect(drawn).toBe(at)
  })

  it('a far jump glides its last part only; a seek ends the glide', () => {
    const c = new CursorCatchUp()
    c.jump(40, 0)
    expect(c.behind(0)).toBe(CATCH_UP_MOST)
    c.reset()
    expect(c.behind(0)).toBe(0)
    c.jump(0, 10)
    expect(c.behind(10)).toBe(0)
  })
})
