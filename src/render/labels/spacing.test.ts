import { describe, expect, it } from 'vitest'
import { layoutLabels, type LabelUnitInput } from './layout'
import { labelSpacingDemand, type LabelSpacingInput } from './spacing'

const labelW = 24
const labelH = 14

function unit(index: number, x: number, y: number, staff = 0, group?: string): LabelUnitInput {
  return {
    notes: [index],
    occ: 0,
    staff,
    hand: staff === 0 ? 'R' : 'L',
    head: { x, y: y - 5, w: 12, h: 10 },
    x: x + 6,
    ...(group === undefined ? {} : { group }),
  }
}

function demand(units: readonly LabelUnitInput[], width = 300) {
  return labelSpacingDemand({ units, labelW, labelH, width })
}

describe('labelSpacingDemand', () => {
  it('detects a cramped run even when collision layout avoids callouts', () => {
    const units = Array.from({ length: 8 }, (_, i) => unit(i, 100 + i * 18, 120 - (i % 3) * 5))
    const layout = layoutLabels({
      units,
      obstacles: units.map((u) => u.head),
      staves: [{ index: 0, top: 100, bottom: 140 }],
      labelW,
      labelH,
      fontPx: 12,
    })
    expect(layout.failures).toHaveLength(0)
    expect(layout.placements.stack).toBeGreaterThan(0)
    expect(demand(units)).toEqual({ width: 454, extraWidth: 154, factor: 454 / 300, crowdedGaps: 7 })
  })

  it('leaves already readable spacing unchanged', () => {
    const units = Array.from({ length: 8 }, (_, i) => unit(i, 100 + i * 50, 120 - (i % 3) * 5))
    expect(demand(units, 500)).toEqual({ width: 500, extraWidth: 0, factor: 1, crowdedGaps: 0 })
  })

  it('shares one onset gap across staves instead of adding their demands', () => {
    const top = [unit(0, 100, 120, 0, 'a'), unit(1, 118, 120, 0, 'b')]
    const bottom = [unit(2, 100, 220, 1, 'a'), unit(3, 118, 220, 1, 'b')]
    expect(demand([...top, ...bottom])).toEqual(demand(top))
    expect(demand(top).extraWidth).toBe(22)
  })

  it('uses the widest head envelope at a shared onset', () => {
    const units = [
      unit(0, 100, 120, 0, 'a'),
      unit(1, 118, 120, 0, 'b'),
      { ...unit(2, 100, 220, 1, 'a'), head: { x: 100, y: 215, w: 18, h: 10 } },
      unit(3, 118, 220, 1, 'b'),
    ]
    expect(demand(units).extraWidth).toBe(28)
  })

  it('lets distant registers share horizontal room', () => {
    expect(demand([unit(0, 100, 120), unit(1, 118, 180)]).extraWidth).toBe(0)
  })

  it('keeps the vertical gap when label envelopes only touch its boundary', () => {
    expect(demand([unit(0, 100, 120), unit(1, 118, 136)]).extraWidth).toBe(0)
  })

  it('checks returning to the same register after an intervening distant note', () => {
    const units = [unit(0, 100, 120), unit(1, 118, 180), unit(2, 136, 120)]
    expect(demand(units).extraWidth).toBe(4)
    expect(demand(units).crowdedGaps).toBe(1)
  })

  it('does not multiply a chord by its number of noteheads', () => {
    const first = [110, 120, 130].map((y, i) => unit(i, 100, y))
    const second = [110, 120, 130].map((y, i) => unit(i + 3, 118, y))
    expect(demand([...first, ...second]).extraWidth).toBe(22)
    expect(demand(first).extraWidth).toBe(0)
  })

  it('uses the reserved label width and height rather than character estimates', () => {
    const units = [unit(0, 100, 120), unit(1, 118, 140)]
    expect(demand(units).extraWidth).toBe(0)
    const larger = labelSpacingDemand({ units, labelW: 32, labelH: 24, width: 300 })
    expect(larger.extraWidth).toBe(16)
  })

  it('is independent of unit input order', () => {
    const units = [unit(0, 100, 120), unit(1, 118, 120), unit(2, 136, 120)]
    expect(demand([...units].reverse())).toEqual(demand(units))
  })

  it('handles empty systems without requesting more room', () => {
    expect(demand([])).toEqual({ width: 300, extraWidth: 0, factor: 1, crowdedGaps: 0 })
  })

  it('matches all-pairs geometric constraints across varied rhythms, chords, and registers', () => {
    let seed = 9173
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    for (let sample = 0; sample < 60; sample++) {
      const columns: LabelUnitInput[][] = []
      let x = 40
      let note = 0
      for (let onset = 0; onset < 32; onset++) {
        x += 4 + random(42)
        const chord = Array.from({ length: 1 + random(5) }, () => {
          const staff = random(2)
          const u = unit(note++, x, 80 + staff * 100 + random(12) * 5, staff, String(onset))
          return { ...u, head: { ...u.head, x: u.head.x + random(5) - 2, w: 10 + random(5) } }
        })
        columns.push(chord)
      }
      const input = {
        units: columns.flat().reverse(),
        labelW: 18 + random(18),
        labelH: 12 + random(12),
        gap: random(5),
        width: 600,
      }
      expect(labelSpacingDemand(input)).toEqual(bruteForceDemand(columns, input))
    }
  })
})

/** Slow geometric reference for the interval sweep, deliberately checking every earlier envelope. */
function bruteForceDemand(groups: readonly (readonly LabelUnitInput[])[], input: LabelSpacingInput) {
  const gap = input.gap ?? 2
  const placed: { x: number; y: number; w: number; h: number }[] = []
  let extraWidth = 0
  let crowdedGaps = 0
  for (const group of groups) {
    const envelopes = group.flatMap(({ head }) => [
      head,
      {
        x: head.x + head.w + gap,
        y: head.y + (head.h - input.labelH) / 2,
        w: input.labelW,
        h: input.labelH,
      },
    ])
    const previousShift = extraWidth
    for (const a of placed) {
      for (const b of envelopes) {
        if (a.y < b.y + b.h + gap && b.y < a.y + a.h + gap) {
          extraWidth = Math.max(extraWidth, a.x + a.w + gap - b.x)
        }
      }
    }
    if (extraWidth > previousShift + 0.01) crowdedGaps++
    placed.push(...envelopes.map((b) => ({ ...b, x: b.x + extraWidth })))
  }
  const width = input.width + extraWidth
  return { width, extraWidth, factor: width / input.width, crowdedGaps }
}
