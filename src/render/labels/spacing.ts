import type { Box } from '../types'
import type { LabelUnitInput } from './layout'

export interface LabelSpacingInput {
  /** Units from one system, in layout pixels. */
  readonly units: readonly LabelUnitInput[]
  /** Reserved worst-case label size, matching the label layout. */
  readonly labelW: number
  readonly labelH: number
  readonly width: number
  readonly gap?: number
}

export interface LabelSpacingDemand {
  /** Estimated system width after making room beside the noteheads. */
  readonly width: number
  readonly extraWidth: number
  readonly factor: number
  /** Onset gaps that need to grow, counted once across both staves. */
  readonly crowdedGaps: number
}

interface Column {
  readonly x: number
  readonly envelopes: readonly Box[]
}

/**
 * Estimates horizontal room before collision layout can hide cramped spacing with stacks and
 * callouts. Each note reserves its head and a centered label to its right. Only envelopes that
 * overlap vertically impose a gap, so distant registers can share horizontal space.
 *
 * All notes at one musical onset move together, across both staves. The forward constraints also
 * compare nonadjacent onsets: a high note between two low notes must not hide their label clash.
 * A sweep over vertical intervals keeps these comparisons O(n log n), even for a very dense bar.
 * Existing gaps never shrink. This is a lower bound rather than a complete engraving: accidentals,
 * beams, and labels stacked within a chord still need the normal collision-layout pass.
 */
export function labelSpacingDemand(input: LabelSpacingInput): LabelSpacingDemand {
  const gap = input.gap ?? 2
  const columns = onsetColumns(input.units, input.labelW, input.labelH, gap)
  const edges = [
    ...new Set(columns.flatMap((c) => c.envelopes.flatMap((b) => [b.y - gap / 2, b.y + b.h + gap / 2]))),
  ].sort((a, b) => a - b)
  const edgeIndex = new Map(edges.map((edge, index) => [edge, index]))
  const rightEdges = new IntervalMax(Math.max(0, edges.length - 1))
  const interval = (b: Box): readonly [number, number] => [
    edgeIndex.get(b.y - gap / 2)!,
    edgeIndex.get(b.y + b.h + gap / 2)!,
  ]
  let shift = 0
  let crowdedGaps = 0
  for (const column of columns) {
    const original = column.x + shift
    let position = original
    for (const b of column.envelopes) {
      const [from, to] = interval(b)
      position = Math.max(position, rightEdges.read(from, to) + gap - b.x)
    }
    if (position > original + 0.01) crowdedGaps++
    // Query the whole onset before adding any of it, so chord heads never compete with themselves.
    for (const b of column.envelopes) {
      const [from, to] = interval(b)
      rightEdges.add(from, to, position + b.x + b.w)
    }
    shift = position - column.x
  }
  const extraWidth = Math.max(0, shift)
  const width = input.width + extraWidth
  return { width, extraWidth, factor: input.width > 0 ? width / input.width : 1, crowdedGaps }
}

function onsetColumns(units: readonly LabelUnitInput[], labelW: number, labelH: number, gap: number): Column[] {
  const groups = new Map<string, LabelUnitInput[]>()
  for (const unit of units) {
    const key = unit.group ?? `${unit.occ}|${Math.round(unit.x * 2)}`
    const group = groups.get(key)
    if (group) group.push(unit)
    else groups.set(key, [unit])
  }
  return [...groups.values()]
    .map((group) => {
      const x = group.reduce((left, unit) => Math.min(left, unit.x), Infinity)
      const envelopes = group.flatMap(({ head }) => [
        { ...head, x: head.x - x },
        {
          x: head.x + head.w + gap - x,
          y: head.y + (head.h - labelH) / 2,
          w: labelW,
          h: labelH,
        },
      ])
      return { x, envelopes }
    })
    .sort((a, b) => a.x - b.x)
}

/** Range maximum with monotonic range updates over compressed vertical intervals. */
class IntervalMax {
  private readonly maxima: Float64Array
  private readonly pending: Float64Array

  constructor(private readonly size: number) {
    this.maxima = new Float64Array(Math.max(1, size * 4)).fill(-Infinity)
    this.pending = new Float64Array(this.maxima.length).fill(-Infinity)
  }

  add(from: number, to: number, value: number, node = 1, left = 0, right = this.size): void {
    if (from >= right || to <= left) return
    if (from <= left && to >= right) {
      this.maxima[node] = Math.max(this.maxima[node]!, value)
      this.pending[node] = Math.max(this.pending[node]!, value)
      return
    }
    const middle = (left + right) >> 1
    this.add(from, to, value, node * 2, left, middle)
    this.add(from, to, value, node * 2 + 1, middle, right)
    this.maxima[node] = Math.max(this.pending[node]!, this.maxima[node * 2]!, this.maxima[node * 2 + 1]!)
  }

  read(from: number, to: number, node = 1, left = 0, right = this.size): number {
    if (from >= right || to <= left) return -Infinity
    if (from <= left && to >= right) return this.maxima[node]!
    const middle = (left + right) >> 1
    return Math.max(
      this.pending[node]!,
      this.read(from, to, node * 2, left, middle),
      this.read(from, to, node * 2 + 1, middle, right),
    )
  }
}
