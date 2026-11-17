import { describe, expect, it } from 'vitest'
import { estimateMeasurer } from './labels/metrics'
import { EXCERPT_LIMIT, GHOSTS_PER_PLACE, excerptMarkup, ghostShapes, planExcerpts } from './excerpt'
import {
  PREPARED_LAYOUT_FORMAT,
  type NoteGeometry,
  type OccurrenceGeometry,
  type PreparedLayout,
  type SegmentData,
} from './types'

const BAR = 200
const STAVES = [
  { index: 0, top: 40, bottom: 80 },
  { index: 1, top: 140, bottom: 180 },
]

/**
 * A strip of `n` bars of 200 px, two notes per bar (one per staff, heads 12 × 10 with their
 * center on the middle staff line), one segment per two bars, a context glyph per staff.
 */
function stripLayout(n: number, mode: 'strip' | 'page' = 'strip'): PreparedLayout {
  const occurrences: OccurrenceGeometry[] = []
  const notes: NoteGeometry[] = []
  const segments: SegmentData[] = []
  for (let o = 0; o < n; o++) {
    const x0 = 60 + o * BAR
    occurrences.push({
      occ: o,
      x0,
      x1: x0 + BAR,
      start: o,
      duration: 1,
      anchors: [
        [0, x0 + 40],
        [1, x0 + BAR],
      ],
      label: String(o + 1),
      labelBox: { x: x0 + 2, y: 22, w: 10, h: 13 },
      ...(mode === 'page' ? { system: 0 } : {}),
    })
    for (const staff of [0, 1]) {
      const mid = (STAVES[staff]!.top + STAVES[staff]!.bottom) / 2
      notes.push({
        index: notes.length,
        occ: o,
        staff,
        hand: staff === 0 ? 'R' : 'L',
        head: { x: x0 + 34, y: mid - 5, w: 12, h: 10 },
        x: x0 + 40,
        label: notes.length,
        graphic: `g${notes.length}`,
        ...(mode === 'page' ? { system: 0 } : {}),
      })
    }
  }
  const head = (i: number) => notes[i]!.head
  const segOf = (s: number, e: number): SegmentData => {
    const x0 = s === 0 ? 0 : 60 + s * BAR
    const x1 = 60 + e * BAR
    let body = ''
    for (let i = s * 2; i < e * 2; i++)
      body += `<g data-n="${i}"><path d="M${head(i).x} ${head(i).y}h12v10h-12z"></path></g>`
    return {
      index: segments.length,
      occStart: s,
      occEnd: e,
      x0,
      x1,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" class="pn-music" viewBox="${x0} 0 ${x1 - x0} 220"><g>${body}</g></svg>`,
      labelStart: 0,
      labelEnd: 0,
      ...(mode === 'page' ? { system: 0, y0: 0, y1: 220 } : {}),
    }
  }
  if (mode === 'page') segments.push(segOf(0, n))
  else for (let s = 0; s < n; s += 2) segments.push(segOf(s, Math.min(n, s + 2)))
  return {
    format: PREPARED_LAYOUT_FORMAT,
    key: 'k',
    scoreVersionId: 'v',
    renderer: { name: 'test', version: '1' },
    params: {
      labelChars: 3,
      labelFontPx: 12,
      labelW: 25,
      labelH: 14,
      segmentWidth: 400,
      spacing: { voiceSpacingMultiplier: 1.4, voiceSpacingAddend: 3 },
      iterations: 1,
    },
    width: 60 + n * BAR,
    top: 0,
    height: 220,
    staves: STAVES,
    occurrences,
    notes,
    labels: [],
    ottavas: [],
    contexts:
      mode === 'page'
        ? []
        : [
            {
              id: 0,
              width: 50,
              staves: [
                { staff: 0, glyph: { svg: '<path class="clef-g" d="M0 0h10"/>', width: 50 } },
                { staff: 1, glyph: { svg: '<path class="clef-f" d="M0 0h10"/>', width: 50 } },
              ],
            },
          ],
    contextChanges: mode === 'page' ? [] : [{ x: 0, occ: 0, context: 0, glyphEnd: 58 }],
    segments,
    report: {
      modelNotes: notes.length,
      graphicalNotes: notes.length,
      mapped: notes.length,
      unmappedNotes: [],
      unmappedGraphics: [],
      relaxedMatches: 0,
      sharedHeads: 0,
      ottavasMapped: 0,
      ottavasUnmapped: [],
    },
    stats: {
      loadMs: 0,
      engraveMs: 0,
      extractMs: 0,
      labelMs: 0,
      partitionMs: 0,
      totalMs: 0,
      svgNodes: 0,
      segmentBytes: 0,
      labelFailuresPerIteration: [],
      placements: { right: 0, stagger: 0, left: 0, stack: 0, callout: 0 },
    },
    ...(mode === 'page'
      ? { mode: 'page' as const, systems: [{ index: 0, occStart: 0, occEnd: n, y0: 0, y1: 220, staves: STAVES }] }
      : {}),
  }
}

describe('planExcerpts', () => {
  it('one excerpt per bar in the order of its most severe item, items of a bar together', () => {
    const items = [
      { occ: 4, id: 'a' },
      { occ: 1, id: 'b' },
      { occ: 4, id: 'c' },
      { occ: 2, id: 'd' },
    ]
    const { shown, more } = planExcerpts(items)
    expect(shown.map((p) => p.occ)).toEqual([4, 1, 2])
    expect(shown[0]!.items.map((i) => i.id)).toEqual(['a', 'c'])
    expect(more).toEqual([])
  })

  it('caps the excerpts shown, cutting from the least severe end', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ occ: 10 + i }))
    const { shown, more } = planExcerpts(items)
    expect(shown).toHaveLength(EXCERPT_LIMIT)
    expect(shown.map((p) => p.occ)).toEqual([10, 11, 12, 13])
    expect(more.map((p) => p.occ)).toEqual([14, 15, 16, 17, 18])
    expect(planExcerpts(items, 100).more).toEqual([])
    expect(planExcerpts([]).shown).toEqual([])
  })
})

describe('ghostShapes', () => {
  const layout = stripLayout(4)
  const space = 10 // (80 − 40) / 4

  it('places a ghost by diatonic steps from its anchor on the anchor’s staff, right of the place', () => {
    // Anchor: bar 1's treble note on the middle line (y 60). Two steps up: the next line (y 50).
    const [g] = ghostShapes(layout, [{ anchor: 0, steps: 2, accidental: '', place: [0, 1] }])
    expect(g!.cy).toBeCloseTo(50)
    expect(g!.cx).toBeGreaterThan(94 + 12) // right of the notehead (x 94–106)
    expect(g!.ledgers).toEqual([])
    // On the bass staff: three steps down from its middle line (y 160) is y 175.
    const [b] = ghostShapes(layout, [{ anchor: 1, steps: -3, accidental: '♭', place: [0, 1] }])
    expect(b!.cy).toBeCloseTo(175)
    expect(b!.accidental).toBe('♭')
    expect(b!.ax).toBeLessThan(b!.cx - b!.rx)
  })

  it('adds ledger lines above and below the staff as far as the ghost reaches', () => {
    // Treble middle line (y 60) + 6 steps = y 30: one ledger line above the staff at y 30.
    const [above] = ghostShapes(layout, [{ anchor: 0, steps: 6, accidental: '', place: [0] }])
    expect(above!.cy).toBeCloseTo(30)
    expect(above!.ledgers).toEqual([30])
    // + 7 steps (y 25, a space above that line): still one ledger line.
    expect(ghostShapes(layout, [{ anchor: 0, steps: 7, accidental: '', place: [0] }])[0]!.ledgers).toEqual([30])
    // Bass middle line (y 160) − 8 steps = y 200: two ledger lines below (190, 200).
    const [below] = ghostShapes(layout, [{ anchor: 1, steps: -8, accidental: '', place: [1] }])
    expect(below!.ledgers).toEqual([190, 200])
    expect(below!.ry).toBeCloseTo(space * 0.54)
  })

  it('stands several ghosts of one place side by side, at most a few, and skips unmapped anchors', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ anchor: 0, steps: i, accidental: '', place: [0, 1] }))
    const shapes = ghostShapes(layout, many)
    expect(shapes).toHaveLength(GHOSTS_PER_PLACE)
    expect(shapes[1]!.cx).toBeGreaterThan(shapes[0]!.cx)
    expect(ghostShapes(layout, [{ anchor: 999, steps: 0, accidental: '', place: [999] }])).toEqual([])
  })
})

describe('excerptMarkup', () => {
  const marks = [{ notes: [2], kind: 'accidental' as const, text: 'D♮4, not D♭4' }]

  it('cuts one bar from its segment with the clef and key in front, the ring, its label and ghosts', () => {
    const layout = stripLayout(4)
    const ex = excerptMarkup(layout, 1, {
      marks,
      ghosts: [{ anchor: 2, steps: 0, accidental: '♭', place: [2, 3] }],
      measurer: estimateMeasurer,
    })!
    expect(ex).not.toBeNull()
    // The sticky context's glyphs (both staves) and five staff lines per staff in front.
    expect(ex.svg).toContain('clef-g')
    expect(ex.svg).toContain('clef-f')
    expect(ex.svg.match(/<path d="M0 /g)).toHaveLength(10)
    // The bar's notation (its own notes only shown: the nested viewport crops to bar 2's x range).
    expect(ex.svg).toContain('data-n="2"')
    expect(ex.svg).toMatch(/<svg class="pn-ex-music" x="56" [^>]*viewBox="2[0-9]{2}(\.[0-9]+)? /)
    expect(ex.svg).toContain('class="pn-corr-ring"')
    expect(ex.svg).toContain('D♮4, not D♭4')
    expect(ex.svg).toContain('class="pn-ex-ghost"')
    expect(ex.svg).toContain('>♭</text>')
    expect(ex.svg).toContain('class="pn-ex-num"')
    expect(ex.width).toBeGreaterThan(BAR)
    // Nothing unsafe is added.
    expect(ex.svg).not.toMatch(/<script|foreignObject|\son\w+=|href=/i)
  })

  it('draws no context in front of the first bar (it engraves its own) and escapes text', () => {
    const layout = stripLayout(4)
    const ex = excerptMarkup(layout, 0, {
      marks: [{ notes: [0], kind: 'wrong', text: '<b>&' }],
      measurer: estimateMeasurer,
    })!
    expect(ex.svg).not.toContain('clef-g')
    expect(ex.svg).toContain('&lt;b&gt;&amp;')
    expect(ex.svg).not.toContain('<b>')
  })

  it('on a page, cuts the system’s start in front of a bar within the system', () => {
    const layout = stripLayout(3, 'page')
    const first = excerptMarkup(layout, 0)!
    expect(first.svg).not.toContain('pn-ex-sig')
    const later = excerptMarkup(layout, 2)!
    expect(later.svg).toContain('class="pn-ex-sig"')
    // The cut runs from the system's first bar line to before its first notehead (less room for an accidental).
    expect(later.svg).toMatch(/<svg class="pn-ex-sig" x="0" y="0" width="20" /)
  })

  it('returns null for a bar that is not in the layout', () => {
    expect(excerptMarkup(stripLayout(2), 9)).toBeNull()
  })
})
