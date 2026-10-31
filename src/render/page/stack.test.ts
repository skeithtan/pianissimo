// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { isPreparedLayout, layoutKey } from '../cache'
import { isSafeSvgMarkup } from '../sanitize'
import { partitionPage } from '../partition'
import { nearestSystem, shiftLabel, shiftNote, stackSystems } from './stack'

describe('page stacking', () => {
  it('stacks system extents from y 0 with the gap, rounding outward', () => {
    const s = stackSystems(
      [
        [40.4, 200.2],
        [300.5, 480],
      ],
      36,
    )
    expect(s[0]).toEqual({ y0: 0, y1: 161, dy: -40 })
    expect(s[1]).toEqual({ y0: 197, y1: 377, dy: 197 - 300 })
  })

  it('moves notes and labels (leaders too) by their system shift', () => {
    const n = shiftNote(
      { index: 0, occ: 0, staff: 0, hand: 'R', head: { x: 1, y: 10, w: 5, h: 4 }, x: 3, label: 0, graphic: '' },
      100,
      2,
    )
    expect(n.head.y).toBe(110)
    expect(n.system).toBe(2)
    const l = shiftLabel(
      {
        id: 0,
        notes: [0],
        occ: 0,
        staff: 0,
        hand: 'R',
        box: { x: 0, y: 5, w: 10, h: 10 },
        tx: 1,
        ty: 12,
        anchor: 'start',
        leader: [0, 1, 2, 3],
        placement: 'stack',
      },
      -5,
    )
    expect([l.box.y, l.ty, l.leader]).toEqual([0, 7, [0, -4, 2, -2]])
  })

  it('finds the system nearest to an engraved y', () => {
    const systems = [{ staves: [{ index: 0, top: 0, bottom: 40 }] }, { staves: [{ index: 0, top: 200, bottom: 240 }] }]
    expect(nearestSystem(systems, 20)).toBe(0)
    expect(nearestSystem(systems, 150)).toBe(1)
    expect(nearestSystem(systems, 300)).toBe(1)
  })
})

describe('page segments and keys', () => {
  it('serializes one system per segment with a page viewBox and a translate group', () => {
    const doc = document
    const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', 'staffline')
    g.innerHTML = '<path d="M0 50h100"></path>'
    const segs = partitionPage(
      [{ occStart: 0, occEnd: 2, elements: [g], y0: 0, y1: 120, dy: -30, labelStart: 0, labelEnd: 4 }],
      600,
    )
    expect(segs[0]).toMatchObject({ index: 0, occStart: 0, occEnd: 2, x0: 0, x1: 600, y0: 0, y1: 120, system: 0 })
    expect(segs[0]!.svg).toContain('viewBox="-1 0 602 120"')
    expect(segs[0]!.svg).toContain('<g transform="translate(0 -30)"><g class="staffline">')
    expect(isSafeSvgMarkup(segs[0]!.svg)).toBe(true)
  })

  it('keys page layouts by mode and width, leaving the strip key unchanged', () => {
    const base = {
      scoreVersionId: 'v',
      renderer: { name: 'osmd', version: '1' },
      labelChars: 3,
      labelFontPx: 13.5,
      segmentWidth: 1600,
    }
    expect(layoutKey(base)).toBe('f1|v|osmd@1|l3x13.5|s1600')
    expect(layoutKey({ ...base, mode: 'strip', pageWidth: 700 })).toBe('f1|v|osmd@1|l3x13.5|s1600')
    expect(layoutKey({ ...base, mode: 'page', pageWidth: 700 })).toBe('f1|v|osmd@1|l3x13.5|s1600|page700')
  })

  it('accepts page layouts with systems and rejects a page layout without them', () => {
    const l = {
      format: 1,
      key: 'k',
      segments: [],
      contexts: [],
      notes: [],
      labels: [],
      occurrences: [],
      staves: [],
      width: 10,
    }
    expect(isPreparedLayout(l)).toBe(true)
    expect(isPreparedLayout({ ...l, mode: 'page', systems: [] })).toBe(true)
    expect(isPreparedLayout({ ...l, mode: 'page' })).toBe(false)
  })
})
