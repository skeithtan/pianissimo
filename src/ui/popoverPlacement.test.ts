import { describe, expect, it } from 'vitest'
import { placePopover, POPOVER_GAP, POPOVER_MARGIN } from './popoverPlacement'

const size = { width: 336, height: 420 }
const viewport = { width: 360, height: 740 }

/** The panel's edges in viewport coordinates for an anchor and a placement. */
function edges(
  anchor: { left: number; top: number; width: number; height: number },
  preferred: 'down' | 'up',
  vp = viewport,
  panel = size,
) {
  const p = placePopover({ anchor, size: panel, viewport: vp, preferred })
  const height = p.maxHeight ?? panel.height
  const top = p.side === 'down' ? anchor.top + anchor.height + POPOVER_GAP : anchor.top - POPOVER_GAP - height
  return { ...p, left: anchor.left + p.left, right: anchor.left + p.left + panel.width, top, bottom: top + height }
}

describe('placePopover', () => {
  it('centers the panel on the anchor when it fits', () => {
    const anchor = { left: 400, top: 10, width: 200, height: 48 }
    const p = placePopover({
      anchor,
      size: { width: 340, height: 300 },
      viewport: { width: 1180, height: 820 },
      preferred: 'down',
    })
    expect(p).toEqual({ side: 'down', left: 100 - 170, maxHeight: null })
  })

  it('shifts the panel inside the right edge (tempo control at the right of a 360 px header)', () => {
    const e = edges({ left: 140, top: 120, width: 208, height: 56 }, 'down')
    expect(e.right).toBeLessThanOrEqual(viewport.width - POPOVER_MARGIN)
    expect(e.left).toBeGreaterThanOrEqual(POPOVER_MARGIN)
  })

  it('shifts the panel inside the left edge', () => {
    const e = edges({ left: 0, top: 120, width: 60, height: 48 }, 'down', { width: 1180, height: 820 })
    expect(e.left).toBe(POPOVER_MARGIN)
  })

  it('flips up when there is no room below, and down when there is no room above', () => {
    expect(edges({ left: 100, top: 600, width: 200, height: 48 }, 'down').side).toBe('up')
    expect(edges({ left: 100, top: 40, width: 200, height: 48 }, 'up').side).toBe('down')
  })

  it('keeps the preferred side when it is the taller one, capping the height so the panel scrolls', () => {
    const vp = { width: 1180, height: 500 }
    const e = edges({ left: 100, top: 80, width: 200, height: 56 }, 'down', vp)
    expect(e.side).toBe('down')
    expect(e.maxHeight).toBe(500 - 136 - POPOVER_GAP - POPOVER_MARGIN)
    expect(e.bottom).toBeLessThanOrEqual(vp.height - POPOVER_MARGIN)
  })

  it('always ends fully on screen for anchors anywhere in a phone and an iPad viewport', () => {
    for (const vp of [viewport, { width: 820, height: 1180 }, { width: 1180, height: 820 }]) {
      for (let x = 0; x <= vp.width - 200; x += 37) {
        for (let y = 0; y <= vp.height - 56; y += 53) {
          for (const preferred of ['down', 'up'] as const) {
            const e = edges({ left: x, top: y, width: 200, height: 56 }, preferred, vp)
            expect(e.left).toBeGreaterThanOrEqual(POPOVER_MARGIN - 1e-6)
            expect(e.right).toBeLessThanOrEqual(vp.width - POPOVER_MARGIN + 1e-6)
            expect(e.top).toBeGreaterThanOrEqual(POPOVER_MARGIN - 1)
            expect(e.bottom).toBeLessThanOrEqual(vp.height - POPOVER_MARGIN + 1)
          }
        }
      }
    }
  })
})
