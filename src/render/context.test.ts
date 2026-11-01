// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { rat } from '../core/music/rational'
import { buildContexts, type ContextInput } from './context'

const NS = 'http://www.w3.org/2000/svg'
const G = { sign: 'G', line: 2, octaveChange: 0 } as const
const F = { sign: 'F', line: 4, octaveChange: 0 } as const

const clef = (x: number, id: string): Element => {
  const g = document.createElementNS(NS, 'g')
  g.setAttribute('class', `vf-clef c${id}`)
  g.setAttribute('data-x', String(x))
  return g
}

/** Four bars of one whole note (barlines 0, 400, 1000, 1600); onsets 40 px after the barline. */
function input(clefs: ContextInput['clefs'], bar2Clefs: Element[]): ContextInput {
  const g0 = clef(5, 'treble')
  const f0 = clef(5, 'bass')
  const empty = { clefs: [] as Element[] }
  const occX = [0, 400, 1000, 1600]
  return {
    staves: [
      { index: 0, top: 100, bottom: 140 },
      { index: 1, top: 200, bottom: 240 },
    ],
    glyphs: [
      [{ clef: g0, clefs: [g0] }, empty, empty, empty],
      [{ clef: f0, clefs: [f0] }, empty, { clefs: bar2Clefs }, empty],
    ],
    occX,
    occStart: [0, 1, 2, 3],
    xAt: (occ, offset) => occX[occ]! + 40 + offset * 600,
    clefs,
    keys: [],
    meters: [],
    bbox: (el) => ({ x: Number(el.getAttribute('data-x') ?? 0), y: 0, w: 20, h: 40 }),
  }
}

const opening: ContextInput['clefs'] = [
  { at: rat(0), occ: 0, staff: 0, clef: G, key: 'G2' },
  { at: rat(0), occ: 0, staff: 1, clef: F, key: 'F4' },
]

describe('buildContexts', () => {
  it('switches the sticky clef where a mid-bar change is drawn', () => {
    // Bar 3 (from x 1000), lower staff: treble clef from its second half (onset x 1340), drawn at 1310.
    const { changes, contexts } = buildContexts(
      input([...opening, { at: rat(5, 2), occ: 2, staff: 1, clef: G, key: 'G2' }], [clef(1310, 'mid')]),
    )
    expect(changes).toHaveLength(2)
    expect(changes[1]!.x).toBe(1310)
    expect(changes[1]!.glyphEnd).toBe(1330)
    // The lower staff now shows the full-size treble clef of the opening.
    expect(contexts[changes[1]!.context]!.staves[1]!.glyph.svg).toContain('ctreble')
  })

  it('switches at the onset when the change clef is not found', () => {
    const { changes } = buildContexts(input([...opening, { at: rat(5, 2), occ: 2, staff: 1, clef: G, key: 'G2' }], []))
    expect(changes[1]!.x).toBe(1340)
  })

  it('keeps a change at the bar start on the barline', () => {
    const { changes } = buildContexts(
      input([...opening, { at: rat(2), occ: 2, staff: 1, clef: G, key: 'G2' }], [clef(1002, 'start')]),
    )
    expect(changes[1]!.x).toBe(1000)
  })

  it('emits a bar-start change and a later mid-bar change in order', () => {
    const { changes } = buildContexts(
      input(
        [
          ...opening,
          { at: rat(2), occ: 2, staff: 1, clef: G, key: 'G2' },
          { at: rat(5, 2), occ: 2, staff: 1, clef: F, key: 'F4' },
        ],
        [clef(1002, 'start'), clef(1310, 'mid')],
      ),
    )
    expect(changes.map((c) => c.x)).toEqual([0, 1000, 1310])
    expect(changes[2]!.context).toBe(changes[0]!.context)
  })
})
