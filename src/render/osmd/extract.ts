/**
 * Reads geometry out of one OSMD engraving: graphical notes (for mapping), measure and staff
 * geometry, ottava brackets, clef/key/meter glyph groups, and obstacle boxes for label layout.
 * Coordinates are layout px (OSMD unit × 10 at zoom 1, equal to the SVG user space).
 */
import { rat, type Rational } from '../../core/music/rational'
import { BoxGrid, round, unionAll } from '../geom'
import type { GraphicNote } from '../mapping'
import type { Box, StaffGeometry } from '../types'
import type { OsmdFraction, OsmdInstance, OsmdMeasure, OsmdStaffLine } from './osmd-types'

/** OSMD unit → layout px at zoom 1. */
export const UNIT = 10

export interface RawMeasure {
  readonly occ: number
  readonly x0: number
  readonly x1: number
  /** Distinct staff-entry onsets `[positionInMeasure, x]` over all staves (incl. rests), sorted. */
  readonly entries: readonly (readonly [number, number])[]
  /** x where notation content starts (after begin-of-measure clef/key/meter). */
  readonly contentX: number
}

export interface RawOttava {
  readonly staff: number
  readonly startX: number
  readonly stopX: number
  readonly text: string
  readonly box: Box
  readonly labelBox: Box
  readonly elements: readonly Element[]
}

export interface MeasureGlyphs {
  /** First clef group (the opening clef in measure 0). */
  readonly clef?: Element
  /** Every clef group in the measure, in document order (change clefs included). */
  readonly clefs: readonly Element[]
  readonly key?: Element
  readonly time?: Element
}

export interface Extraction {
  readonly svg: SVGSVGElement
  readonly svgNodes: number
  readonly staves: readonly StaffGeometry[]
  readonly graphics: readonly GraphicNote[]
  /** By graphic id. */
  readonly headEls: readonly Element[]
  readonly noteGroupEls: readonly (Element | null)[]
  readonly measures: readonly RawMeasure[]
  readonly ottavas: readonly RawOttava[]
  /** [staff][occ] → `g.vf-measure` element. */
  readonly measureEls: readonly (readonly (Element | undefined)[])[]
  /** [staff][occ] glyph groups found inside that staff's measure group. */
  readonly glyphs: readonly (readonly MeasureGlyphs[])[]
  readonly obstacles: readonly Box[]
  /** Union of all drawn marks. */
  readonly content: Box
}

export function fractionToRational(f: OsmdFraction): Rational {
  const expanded = (f as { GetExpandedNumerator?: () => number }).GetExpandedNumerator?.()
  const n = expanded ?? f.WholeValue * f.Denominator + f.Numerator
  return Number.isInteger(n) && Number.isInteger(f.Denominator) && f.Denominator > 0
    ? rat(n, f.Denominator)
    : rat(Math.round(f.RealValue * 1e6), 1e6)
}

/** getBBox in root user space; OSMD's SVG uses absolute coordinates without transforms. */
function bbox(el: Element): Box {
  const b = (el as SVGGraphicsElement).getBBox()
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

export function extract(osmd: OsmdInstance, host: HTMLElement, occurrenceCount: number): Extraction {
  const svg = host.querySelector('svg')
  if (!svg) throw new Error('OSMD produced no SVG')
  const sheet = osmd.GraphicSheet
  const systems = sheet.MusicPages.flatMap((p) => p.MusicSystems)
  const system = systems[0]
  if (!system) throw new Error('OSMD produced no music system')
  if (systems.length !== 1)
    throw new Error(`OSMD laid the score out in ${systems.length} systems instead of one horizontal staffline`)
  if (sheet.MeasureList.length !== occurrenceCount) {
    throw new Error(`Engraved ${sheet.MeasureList.length} measures for ${occurrenceCount} occurrences`)
  }

  const staves = staffGeometry(system.StaffLines)
  const { graphics, headEls, noteGroupEls, measures } = readMeasures(sheet)

  const stafflineEls = [...svg.children].filter((c) => c.classList.contains('staffline'))
  const measureEls = stafflineEls.map((sl) => [...sl.children].filter((c) => c.classList.contains('vf-measure')))
  const glyphs = measureEls.map((list) => list.map(measureGlyphs))

  const ottavas: RawOttava[] = []
  system.StaffLines.forEach((sl, staff) => readOttavas(sl, staff, stafflineEls[staff], ottavas))

  const { obstacles, content, nodes } = collectObstacles(svg)
  return {
    svg,
    svgNodes: nodes,
    staves,
    graphics,
    headEls,
    noteGroupEls,
    measures,
    ottavas,
    measureEls,
    glyphs,
    obstacles,
    content,
  }
}

/** One engraved system (line) of a page-mode engraving. */
export interface RawSystem {
  readonly index: number
  /** Half-open bar range [occStart, occEnd). */
  readonly occStart: number
  readonly occEnd: number
  /** Engraved staff lines of this system (engraved y). */
  readonly staves: readonly StaffGeometry[]
  /** The system's `g.staffline` groups (one per staff) plus the other root marks drawn for it. */
  readonly elements: readonly Element[]
  /** Label obstacles drawn by this system's elements (engraved y). */
  readonly obstacles: readonly Box[]
  /** Union of the system's drawn marks (engraved y). */
  readonly content: Box
}

export interface PageExtraction extends Extraction {
  readonly systems: readonly RawSystem[]
  /** System index by occurrence. */
  readonly systemOfOcc: readonly number[]
}

/**
 * Page mode: the same per-note, per-measure and ottava geometry as `extract`, for an engraving
 * wrapped into systems. `staves` are the first system's; `measureEls` / `glyphs` keep the
 * [staff][occ] shape by concatenating the systems' measure groups. Root marks outside the
 * stafflines (braces) go to the system whose staves are nearest.
 */
export function extractPage(osmd: OsmdInstance, host: HTMLElement, occurrenceCount: number): PageExtraction {
  const svg = host.querySelector('svg')
  if (!svg) throw new Error('OSMD produced no SVG')
  const sheet = osmd.GraphicSheet
  const systems = sheet.MusicPages.flatMap((p) => p.MusicSystems)
  if (!systems[0]) throw new Error('OSMD produced no music system')
  if (sheet.MeasureList.length !== occurrenceCount) {
    throw new Error(`Engraved ${sheet.MeasureList.length} measures for ${occurrenceCount} occurrences`)
  }
  const staffCount = systems[0].StaffLines.length
  if (systems.some((s) => s.StaffLines.length !== staffCount))
    throw new Error('OSMD systems do not all have the same staves')

  const systemOf = new Map<OsmdMeasure, number>()
  systems.forEach((sys, k) => {
    for (const sl of sys.StaffLines) for (const m of sl.Measures ?? []) systemOf.set(m, k)
  })
  const systemOfOcc = sheet.MeasureList.map((row, occ) => {
    for (const m of row) {
      const k = m ? systemOf.get(m) : undefined
      if (k !== undefined) return k
    }
    throw new Error(`Measure ${occ} is in no system`)
  })
  for (let o = 1; o < systemOfOcc.length; o++) {
    if (systemOfOcc[o]! < systemOfOcc[o - 1]!) throw new Error('OSMD systems are not in bar order')
  }

  const { graphics, headEls, noteGroupEls, measures } = readMeasures(sheet)
  const stafflineEls = [...svg.children].filter((c) => c.classList.contains('staffline'))
  if (stafflineEls.length !== systems.length * staffCount)
    throw new Error(`Expected ${systems.length * staffCount} stafflines, found ${stafflineEls.length}`)

  const measureEls: Element[][] = []
  for (let staff = 0; staff < staffCount; staff++) {
    const list: Element[] = []
    for (let k = 0; k < systems.length; k++) {
      const group = stafflineEls[k * staffCount + staff]!
      for (const c of group.children) if (c.classList.contains('vf-measure')) list.push(c)
    }
    measureEls.push(list)
  }
  const glyphs = measureEls.map((list) => list.map(measureGlyphs))

  const ottavas: RawOttava[] = []
  const raw = systems.map((sys, k) => {
    sys.StaffLines.forEach((sl, staff) => readOttavas(sl, staff, stafflineEls[k * staffCount + staff], ottavas))
    const first = systemOfOcc.indexOf(k)
    const occStart = first < 0 ? 0 : first
    let occEnd = occStart
    while (occEnd < systemOfOcc.length && systemOfOcc[occEnd] === k) occEnd++
    return {
      index: k,
      occStart,
      occEnd,
      staves: staffGeometry(sys.StaffLines),
      elements: stafflineEls.slice(k * staffCount, (k + 1) * staffCount),
    }
  })
  for (const el of svg.children) {
    if (el.classList.contains('staffline')) continue
    const b = bbox(el)
    const cy = b.y + b.h / 2
    let best = raw[0]!
    let bestD = Infinity
    for (const sys of raw) {
      const top = sys.staves[0]?.top ?? 0
      const bottom = sys.staves[sys.staves.length - 1]?.bottom ?? top
      const d = cy < top ? top - cy : cy > bottom ? cy - bottom : 0
      if (d < bestD) {
        bestD = d
        best = sys
      }
    }
    best.elements.push(el)
  }

  const systemsOut: RawSystem[] = raw.map((sys) => {
    const obstacles: Box[] = []
    const all: Box[] = []
    for (const el of sys.elements) {
      const c = collectObstacles(el)
      for (const o of c.obstacles) obstacles.push(o)
      if (c.content.w > 0 || c.content.h > 0) all.push(c.content)
    }
    return { ...sys, obstacles, content: unionAll(all) ?? { x: 0, y: sys.staves[0]?.top ?? 0, w: 0, h: 0 } }
  })
  const obstacles = systemsOut.flatMap((s) => s.obstacles)
  const content = unionAll(systemsOut.map((s) => s.content)) ?? { x: 0, y: 0, w: 0, h: 0 }
  return {
    svg,
    svgNodes: svg.getElementsByTagName('*').length,
    staves: raw[0]!.staves,
    graphics,
    headEls,
    noteGroupEls,
    measures,
    ottavas,
    measureEls,
    glyphs,
    obstacles,
    content,
    systems: systemsOut,
    systemOfOcc,
  }
}

function staffGeometry(lines: readonly OsmdStaffLine[]): StaffGeometry[] {
  return lines.map((sl, index) => {
    const top = sl.PositionAndShape.AbsolutePosition.y * UNIT
    return { index, top: round(top), bottom: round(top + sl.StaffHeight * UNIT) }
  })
}

/** Graphical notes (for mapping) and measure geometry, in occurrence order. */
function readMeasures(sheet: OsmdInstance['GraphicSheet']): {
  graphics: GraphicNote[]
  headEls: Element[]
  noteGroupEls: (Element | null)[]
  measures: RawMeasure[]
} {
  const graphics: GraphicNote[] = []
  const headEls: Element[] = []
  const noteGroupEls: (Element | null)[] = []
  const measures: RawMeasure[] = []

  sheet.MeasureList.forEach((row, occ) => {
    const entries = new Map<number, [number, number]>()
    const first = row.find((m): m is OsmdMeasure => m !== undefined)
    if (!first) throw new Error(`Measure ${occ} has no graphical staves`)
    const x0 = first.PositionAndShape.AbsolutePosition.x * UNIT
    const x1 = x0 + first.PositionAndShape.Size.width * UNIT
    row.forEach((gm, staff) => {
      if (!gm) return
      for (const se of gm.staffEntries) {
        const onset = fractionToRational(se.relInMeasureTimestamp)
        const pos = se.relInMeasureTimestamp.RealValue
        const x = se.PositionAndShape.AbsolutePosition.x * UNIT
        const k = Math.round(pos * 1e6)
        const prev = entries.get(k)
        if (!prev || x < prev[1]) entries.set(k, [pos, x])
        for (const gve of se.graphicalVoiceEntries) {
          const voice = String(gve.parentVoiceEntry.ParentVoice.VoiceId)
          for (const gn of gve.notes) {
            const sn = gn.sourceNote
            if (sn.isRest()) continue
            const heads = gn.getNoteheadSVGs?.() ?? []
            const el = heads[gn.vfnote?.[1] ?? 0] ?? heads[0]
            if (!el) continue
            const id = graphics.length
            graphics.push({
              id,
              occ,
              staff,
              voice,
              onset,
              midi: sn.halfTone + 12,
              grace: sn.IsGraceNote,
              head: bbox(el),
              x,
              graphic: gn.getSVGId?.() ?? '',
            })
            headEls.push(el)
            noteGroupEls.push(gn.getSVGGElement?.() ?? null)
          }
        }
      }
    })
    const sorted = [...entries.values()].sort((a, b) => a[0] - b[0])
    const contentX = x0 + first.beginInstructionsWidth * UNIT
    measures.push({ occ, x0, x1, entries: sorted, contentX })
  })
  return { graphics, headEls, noteGroupEls, measures }
}

function measureGlyphs(m: Element): MeasureGlyphs {
  const clefs = [...m.querySelectorAll('g.vf-clef')]
  const out: { clef?: Element; clefs: Element[]; key?: Element; time?: Element } = { clefs }
  const clef = clefs[0]
  const key = m.querySelector('g.vf-keysignature')
  const time = m.querySelector('g.vf-timesignature')
  if (clef) out.clef = clef
  if (key) out.key = key
  if (time) out.time = time
  return out
}

function readOttavas(sl: OsmdStaffLine, staff: number, group: Element | undefined, out: RawOttava[]): void {
  if (!group) return
  for (const os of sl.OctaveShifts ?? []) {
    const start = os.startNote?.getAbsoluteX()
    const stopNote = os.endNote
    if (start === undefined || !stopNote || !os.text) continue
    const stopX = stopNote.getAbsoluteX() + (stopNote.getGlyph?.().getWidth() ?? 10)
    const raw = findBracket(group, os.text, start, stopX)
    if (raw) out.push({ staff, startX: start, stopX, text: os.text + (os.supscript ?? ''), ...raw })
  }
}

/**
 * VexFlow draws an ottava as loose siblings in the staffline group: the number text, the
 * suffix text, dashes and the end hook. Collect that run starting at the number at `startX`.
 */
function findBracket(
  group: Element,
  number: string,
  startX: number,
  stopX: number,
): Pick<RawOttava, 'box' | 'labelBox' | 'elements'> | undefined {
  const kids = [...group.children]
  const at = kids.findIndex(
    (c) =>
      c.tagName === 'text' && !c.getAttribute('class') && c.textContent === number && Math.abs(bbox(c).x - startX) < 4,
  )
  if (at < 0) return undefined
  const numberBox = bbox(kids[at]!)
  const cy = numberBox.y + numberBox.h / 2
  const elements: Element[] = [kids[at]!]
  const labelParts: Box[] = [numberBox]
  for (let i = at + 1; i < kids.length; i++) {
    const c = kids[i]!
    if (c.getAttribute('class')) break
    const b = bbox(c)
    const inX = b.x >= startX - 4 && b.x <= stopX + 16
    const inY = b.y + b.h / 2 > cy - 24 && b.y + b.h / 2 < cy + 24
    if (!inX || !inY) break
    if (c.tagName === 'text') {
      if (labelParts.length > 1) break
      labelParts.push(b)
    }
    elements.push(c)
  }
  const box = unionAll(elements.map(bbox))!
  return { box, labelBox: unionAll(labelParts)!, elements }
}

const LEAF = 'path,rect,text,line,circle,ellipse,polygon,polyline'

/**
 * Obstacles for label layout: every drawn leaf except staff lines. Long curves and beams are
 * sampled along their outline so the empty area under a slur or a slanted beam stays usable.
 */
export function collectObstacles(svg: Element): { obstacles: Box[]; content: Box; nodes: number } {
  const obstacles: Box[] = []
  const all: Box[] = []
  const leaves = svg.querySelectorAll(LEAF)
  for (const el of leaves) {
    const b = bbox(el)
    if (b.w === 0 && b.h === 0) continue
    all.push(b)
    if (isStaffLine(el, b)) continue
    if (el.tagName === 'path' && b.w > 24 && b.h > 6) {
      sampleOutline(el as SVGPathElement, obstacles)
    } else {
      obstacles.push(b)
    }
  }
  return {
    obstacles,
    content: unionAll(all) ?? { x: 0, y: 0, w: 0, h: 0 },
    nodes: svg.getElementsByTagName('*').length,
  }
}

function isStaffLine(el: Element, b: Box): boolean {
  return el.tagName === 'path' && b.h < 0.6 && b.w > 20 && el.parentElement?.classList.contains('vf-measure') === true
}

function sampleOutline(path: SVGPathElement, out: Box[]): void {
  const len = path.getTotalLength()
  const step = 4
  const n = Math.max(2, Math.ceil(len / step))
  for (let i = 0; i <= n; i++) {
    const p = path.getPointAtLength((len * i) / n)
    out.push({ x: p.x - step / 2, y: p.y - step / 2, w: step, h: step })
  }
}

/** Grid of obstacles for repeated queries. */
export function obstacleGrid(obstacles: readonly Box[]): BoxGrid<Box> {
  const g = new BoxGrid<Box>(64)
  for (const o of obstacles) g.add(o)
  return g
}
