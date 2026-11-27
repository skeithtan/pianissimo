import { describe, expect, it } from 'vitest'
import type { PreparedLayout } from '../types'
import { correctionsKey, layoutCorrections, type CorrectionMark } from './corrections'

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
      { staff: 0, occ: 0, head: { x: 100, y: 95, w: 12, h: 10 } },
      { staff: 1, occ: 0, head: { x: 100, y: 195, w: 12, h: 10 } },
      { staff: 0, occ: 1, head: { x: 200, y: 95, w: 12, h: 10 } },
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

describe('correctionsKey', () => {
  it('differs between repeat: 2 and repeat: 3, and between absent and repeat: 2', () => {
    const base: CorrectionMark = { notes: [0], kind: 'wrong', text: 'Wrong note' }
    const r0: CorrectionMark = { ...base, repeat: 0 }
    const r1: CorrectionMark = { ...base, repeat: 1 }
    const r2: CorrectionMark = { ...base, repeat: 2 }
    const r3: CorrectionMark = { ...base, repeat: 3 }
    expect(correctionsKey([r2])).not.toBe(correctionsKey([r3]))
    expect(correctionsKey([base])).not.toBe(correctionsKey([r2]))
    expect(correctionsKey([base])).toBe(correctionsKey([r0]))
    expect(correctionsKey([base])).toBe(correctionsKey([r1]))
  })
})

describe('layoutCorrections with repeat', () => {
  it('measures the label with its ×N suffix when placing labels', () => {
    const measured: string[] = []
    const measurer = {
      width(text: string): number {
        measured.push(text)
        return text.length * 8
      },
    }
    const mark: CorrectionMark = { notes: [0], kind: 'wrong', text: 'Wrong note', repeat: 3 }
    const [shape] = layoutCorrections(miniLayout(), [mark], measurer)
    expect(measured).toContain('Wrong note ×3')
    expect(shape!.label).not.toBeNull()
    expect(shape!.label!.box.x1 - shape!.label!.box.x0).toBeCloseTo('Wrong note ×3'.length * 8)
  })
})
