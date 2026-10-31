// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { partitionSvg, segmentBounds } from './partition'

const NS = 'http://www.w3.org/2000/svg'

/** A top-level engraved group with a stubbed bounding box (happy-dom has no SVG geometry). */
function unit(cls: string, id: string, x0: number, x1: number): SVGGElement {
  const g = document.createElementNS(NS, 'g') as SVGGElement
  g.setAttribute('class', cls)
  g.setAttribute('id', id)
  g.append(document.createElementNS(NS, 'path'))
  Object.defineProperty(g, 'getBBox', { value: () => ({ x: x0, y: 0, width: x1 - x0, height: 10 }) })
  return g
}

function engraving(units: readonly Element[]): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  const line = document.createElementNS(NS, 'g')
  line.setAttribute('class', 'staffline')
  line.append(...units)
  svg.append(line)
  return svg
}

const ids = (svg: string): string[] => [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!)

describe('partitionSvg', () => {
  const measures = [
    { x0: 0, x1: 400 },
    { x0: 400, x1: 800 },
    { x0: 800, x1: 1200 },
  ]
  const bounds = segmentBounds(measures, 1200, 400)

  it('puts a measure only in its own segment although its barline touches the next one', () => {
    const svg = engraving([
      unit('vf-measure', 'm0', 0, 401),
      unit('vf-measure', 'm1', 400, 801),
      unit('vf-measure', 'm2', 800, 1201),
    ])
    const segments = partitionSvg(svg, bounds, 0, 100, () => [0, 0])
    expect(segments.map((s) => ids(s.svg))).toEqual([['m0'], ['m1'], ['m2']])
  })

  it('copies a mark into every segment it crosses, in x order', () => {
    const svg = engraving([
      unit('vf-measure', 'm0', 0, 401),
      unit('vf-measure', 'm1', 400, 801),
      unit('vf-measure', 'm2', 800, 1201),
      unit('vf-curve', 'slur', 350, 850),
    ])
    const segments = partitionSvg(svg, bounds, 0, 100, () => [0, 0])
    expect(segments.map((s) => ids(s.svg))).toEqual([
      ['m0', 'slur'],
      ['slur', 'm1'],
      ['slur', 'm2'],
    ])
  })

  it('draws a hairline unit on a boundary exactly once, in the segment holding its center', () => {
    const svg = engraving([
      unit('vf-measure', 'm0', 0, 400),
      unit('vf-measure', 'm1', 400, 800),
      unit('vf-measure', 'm2', 800, 1200),
      unit('vf-connector', 'bar', 800.04, 801.04),
      unit('vf-connector', 'brace', -12, -2),
      unit('vf-connector', 'final', 1200.2, 1203),
    ])
    const segments = partitionSvg(svg, bounds, 0, 100, () => [0, 0])
    expect(segments.map((s) => ids(s.svg))).toEqual([['brace', 'm0'], ['m1'], ['m2', 'bar', 'final']])
  })

  it('overlaps the viewBox of neighbors by the seam so clipped copies meet without a gap', () => {
    const svg = engraving([unit('vf-measure', 'm0', 0, 400), unit('vf-measure', 'm1', 400, 800)])
    const segments = partitionSvg(svg, segmentBounds(measures.slice(0, 2), 800, 400), 20, 100, () => [1, 2])
    expect(segments[1]!.svg).toContain('viewBox="398 20 404 100"')
    expect(segments[1]).toMatchObject({
      index: 1,
      occStart: 1,
      occEnd: 2,
      x0: 400,
      x1: 800,
      labelStart: 1,
      labelEnd: 2,
    })
  })
})
