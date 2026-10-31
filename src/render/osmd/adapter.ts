/**
 * OSMD 2.2.1 renderer adapter (spec "MusicXML engraving" row, "Execution and rendering
 * architecture"; DECISIONS R1–R3). One `prepare` call:
 *  1. loads OSMD lazily and engraves `renderXml` as one horizontal staffline in an attached,
 *     hidden container;
 *  2. extracts note, measure, staff, ottava and glyph geometry and maps every notehead to its
 *     `PerformedNote.index`;
 *  3. places the app-drawn measure numbers clear of engraved marks (R6), then reserves a
 *     worst-case label box beside every notehead (all-notes layout, R3), avoiding notation and
 *     numbers; box widths come from the strip's real font (`labels/metrics.ts`); when too many
 *     labels would need a callout it widens spacing for both staves together and engraves again
 *     (bounded iterations);
 *  4. tags notehead / hand / ottava elements, sanitizes the SVG, partitions it into measure-range
 *     segments and discards the complete tree and the OSMD instance.
 */
import { add, toNumber } from '../../core/music/rational'
import { layoutKey } from '../cache'
import { buildContexts } from '../context'
import { round, roundBox, unionAll } from '../geom'
import { layoutLabels, type LabelUnitInput } from '../labels/layout'
import {
  type TextMeasurer,
  NUMBER_BOX_H,
  canvasMeasurer,
  estimateMeasurer,
  labelBoxSize,
  LABEL_FONT_FAMILY,
  LABEL_FONT_PX,
  loadLabelFont,
  numberBoxWidth,
  uiFontFamily,
} from '../labels/metrics'
import { placeMeasureNumbers } from '../labels/numbers'
import { mapNotes, type NoteMapping } from '../mapping'
import { DEFAULT_SEGMENT_WIDTH, partitionSvg, segmentBounds } from '../partition'
import { sanitizeSvgTree } from '../sanitize'
import {
  PREPARED_LAYOUT_FORMAT,
  type Box,
  type LabelBox,
  type LayoutStats,
  type NoteGeometry,
  type OccurrenceGeometry,
  type OttavaGeometry,
  type PreparedLayout,
  type PrepareOptions,
  type PrepareStage,
  type RenderInput,
  type RendererAdapter,
  type SpacingParams,
  type StaffGeometry,
} from '../types'
import { extract, type Extraction, type RawMeasure, type RawOttava } from './extract'
import { loadOsmd } from './load'
import type { OsmdInstance } from './osmd-types'

export const OSMD_VERSION = '2.2.1'
/**
 * Bump when extraction, label layout or segment output changes (part of the cache key).
 * pn-3: label and measure-number widths from font metrics; numbers placed clear of notation.
 * pn-4: label boxes measured in the self-hosted label font (R14).
 * pn-5: default label size 13.5 px (was 12): wider and taller reserved label boxes.
 */
export const ADAPTER_VERSION = 'pn-5'
export const RENDERER_NAME = 'osmd'
export const RENDERER_VERSION = `${OSMD_VERSION}+${ADAPTER_VERSION}`

/** Label-aware default: OSMD 0.85 × ~1.65 leaves room for a label beside nearly every notehead. */
export const DEFAULT_SPACING: SpacingParams = { voiceSpacingMultiplier: 1.4, voiceSpacingAddend: 3 }
/** Width limit for the one horizontal system (layout px); far beyond any practical score. */
const MAX_SHEET_WIDTH = 50_000_000
/** Widen spacing when more than this share of labels would need a callout. */
export const CALLOUT_TOLERANCE = 0.005

const OSMD_OPTIONS = {
  autoResize: false,
  backend: 'svg',
  renderSingleHorizontalStaffline: true,
  pageFormat: 'Endless',
  drawTitle: false,
  drawSubtitle: false,
  drawComposer: false,
  drawLyricist: false,
  drawCredits: false,
  drawPartNames: false,
  drawPartAbbreviations: false,
  drawMeasureNumbers: false,
  newSystemFromXML: false,
  newPageFromXML: false,
  newSystemFromNewPageInXML: false,
  autoGenerateMultipleRestMeasuresFromRestMeasures: false,
  disableCursor: true,
  stretchLastSystemLine: false,
} as const

export function defaultMeasureLabel(number: string, pass: number): string {
  return pass > 1 ? `${number} (pass ${pass})` : number
}

/**
 * Reserved label box for `maxChars` at `fontPx`. With a measurer (the adapter passes the canvas
 * one) the width is the widest label of that naming family in the strip's font; without, the
 * deterministic 0.62 em estimate.
 */
export function labelMetrics(
  maxChars: number,
  fontPx: number,
  measure: TextMeasurer = estimateMeasurer,
  family?: string,
): { w: number; h: number } {
  return labelBoxSize(maxChars, fontPx, measure, family)
}

class Aborted extends Error {
  constructor() {
    super('Layout preparation was canceled')
    this.name = 'AbortError'
  }
}

const now = (): number => performance.now()
const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

export class OsmdRenderer implements RendererAdapter {
  readonly name = RENDERER_NAME
  readonly version = RENDERER_VERSION

  async prepare(input: RenderInput, options: PrepareOptions): Promise<PreparedLayout> {
    const t0 = now()
    const signal = options.signal
    const check = (): void => {
      if (signal?.aborted) throw new Aborted()
    }
    const progress = (stage: PrepareStage, f: number): void => options.onProgress?.(stage, f)
    const fontPx = options.labels.fontPx ?? LABEL_FONT_PX
    const host = options.host ?? document.body
    const family = uiFontFamily(host)
    // Label boxes are measured in the label web font: load it first (R14).
    await loadLabelFont(document, fontPx)
    try {
      await document.fonts?.ready
    } catch {
      // Measuring with the fallback metrics of a font still loading is only slightly off.
    }
    const measure = options.textMeasurer ?? canvasMeasurer(document) ?? estimateMeasurer
    const label = labelMetrics(options.labels.maxChars, fontPx, measure, LABEL_FONT_FAMILY)
    const segmentWidth = options.segmentWidth ?? DEFAULT_SEGMENT_WIDTH
    const maxIterations = Math.max(1, options.maxIterations ?? 3)
    const measureLabel = options.measureLabel ?? defaultMeasureLabel

    progress('loading', 0)
    const tl = now()
    const mod = await loadOsmd()
    const loadMs = now() - tl
    check()

    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText =
      'position:absolute;left:-200000px;top:0;width:1600px;visibility:hidden;pointer-events:none;contain:layout style'
    host.append(container)
    let osmd: OsmdInstance | undefined = new mod.OpenSheetMusicDisplay(container, { ...OSMD_OPTIONS })
    try {
      progress('engraving', 0)
      const te = now()
      await osmd.load(input.renderXml)
      let engraveMs = now() - te
      let extractMs = 0
      let labelMs = 0
      let spacing = options.spacing ?? DEFAULT_SPACING
      const failuresPerIteration: number[] = []

      for (let iteration = 1; ; iteration++) {
        check()
        // OSMD wraps a "single" staffline into new systems beyond SheetMaximumWidth (32767 px).
        osmd.EngravingRules.SheetMaximumWidth = MAX_SHEET_WIDTH
        osmd.EngravingRules.VoiceSpacingMultiplierVexflow = spacing.voiceSpacingMultiplier
        osmd.EngravingRules.VoiceSpacingAddendVexflow = spacing.voiceSpacingAddend
        await nextTask()
        const tr = now()
        osmd.render()
        engraveMs += now() - tr
        check()

        progress('extracting', 0)
        await nextTask()
        const tx = now()
        const ex = extract(osmd, container, input.occurrences.length)
        const mapping = mapNotes(input.notes, ex.graphics)
        const occurrences = occurrenceGeometry(input, ex, measureLabel, (text) => numberBoxWidth(text, measure, family))
        extractMs += now() - tx
        check()

        progress('labels', 0)
        const tlab = now()
        const units = labelUnits(input, ex, mapping)
        const obstacles = [...ex.obstacles, ...occurrences.map((o) => o.labelBox)]
        const result = layoutLabels({
          units,
          obstacles,
          staves: ex.staves,
          labelW: label.w,
          labelH: label.h,
          fontPx,
        })
        labelMs += now() - tlab
        failuresPerIteration.push(result.failures.length)

        const tooMany = result.failures.length > Math.max(0, units.length * CALLOUT_TOLERANCE)
        if (tooMany && iteration < maxIterations) {
          const factor = Math.min(2, Math.max(1.15, result.spacingDemand))
          spacing = {
            voiceSpacingMultiplier: round(spacing.voiceSpacingMultiplier * factor, 3),
            voiceSpacingAddend: spacing.voiceSpacingAddend,
          }
          continue
        }

        progress('partitioning', 0)
        await nextTask()
        const tp = now()
        const order = result.labels
          .map((l, unit) => ({ l, unit }))
          .sort((a, b) => a.l.occ - b.l.occ || a.l.box.x - b.l.box.x || a.l.box.y - b.l.box.y)
        const labels: LabelBox[] = order.map(({ l }, id) => ({
          ...l,
          id,
          box: roundBox(l.box),
          tx: round(l.tx),
          ty: round(l.ty),
        }))
        const labelOfUnit = new Map(order.map(({ unit }, id) => [unit, id]))
        const notes = noteGeometry(input, ex, mapping, labelOfUnit)
        const ottavas = ottavaGeometry(input, ex.ottavas, occurrences, ex.staves)

        tagElements(input, ex, mapping, ottavas.raw)
        const svgNodes = ex.svgNodes
        sanitizeSvgTree(ex.svg)

        const bboxOf = (el: Element): Box => {
          const b = (el as SVGGraphicsElement).getBBox()
          return { x: b.x, y: b.y, w: b.width, h: b.height }
        }
        const { contexts, changes } = buildContexts({
          staves: ex.staves,
          glyphs: ex.glyphs,
          occX: occurrences.map((o) => o.x0),
          clefs: input.clefs,
          keys: input.keys,
          meters: input.meters,
          bbox: bboxOf,
        })

        const extent = unionAll([
          ex.content,
          ...labels.map((l) => l.box),
          ...occurrences.map((o) => o.labelBox),
          ...ottavas.geometry.filter((g): g is OttavaGeometry => g !== null).map((g) => g.box),
        ])!
        const pad = 6
        const top = Math.floor(extent.y - pad)
        const height = Math.ceil(extent.y + extent.h + pad) - top
        const width = Math.ceil(Math.max(extent.x + extent.w, occurrences.at(-1)?.x1 ?? 0) + pad)
        const bounds = segmentBounds(occurrences, width, segmentWidth)
        const firstLabelOfOcc = labelIndexByOcc(labels, occurrences.length)
        const segments = partitionSvg(ex.svg, bounds, top, height, (b) => [
          firstLabelOfOcc[b.occStart]!,
          firstLabelOfOcc[b.occEnd]!,
        ])
        const partitionMs = now() - tp

        const stats: LayoutStats = {
          loadMs,
          engraveMs,
          extractMs,
          labelMs,
          partitionMs,
          totalMs: now() - t0,
          svgNodes,
          segmentBytes: segments.reduce((n, s) => n + s.svg.length, 0),
          labelFailuresPerIteration: failuresPerIteration,
          placements: result.placements,
        }
        const renderer = { name: this.name, version: this.version }
        const layout: PreparedLayout = {
          format: PREPARED_LAYOUT_FORMAT,
          key: layoutKey({
            scoreVersionId: input.scoreVersionId,
            renderer,
            labelChars: options.labels.maxChars,
            labelFontPx: fontPx,
            segmentWidth,
          }),
          scoreVersionId: input.scoreVersionId,
          renderer,
          params: {
            labelChars: options.labels.maxChars,
            labelFontPx: fontPx,
            labelW: label.w,
            labelH: label.h,
            segmentWidth,
            spacing,
            iterations: iteration,
          },
          width,
          top,
          height,
          staves: ex.staves,
          occurrences,
          notes,
          labels,
          ottavas: ottavas.geometry,
          contexts,
          contextChanges: changes,
          segments,
          report: {
            ...mapping.report,
            ottavasMapped: ottavas.geometry.filter((g) => g?.engraved).length,
            ottavasUnmapped: ottavas.unmapped,
          },
          stats,
        }
        progress('done', 1)
        return layout
      }
    } finally {
      try {
        osmd?.clear()
      } catch {
        // The instance is discarded either way.
      }
      osmd = undefined
      container.remove()
    }
  }
}

function labelIndexByOcc(labels: readonly LabelBox[], occCount: number): number[] {
  const first = new Array<number>(occCount + 1).fill(labels.length)
  for (let i = labels.length - 1; i >= 0; i--) first[labels[i]!.occ] = i
  for (let o = occCount - 1; o >= 0; o--) first[o] = Math.min(first[o]!, first[o + 1]!)
  return first
}

function occurrenceGeometry(
  input: RenderInput,
  ex: Pick<Extraction, 'measures' | 'staves' | 'obstacles'>,
  measureLabel: (number: string, pass: number) => string,
  numberWidth: (text: string) => number,
): OccurrenceGeometry[] {
  const measures: readonly RawMeasure[] = ex.measures
  const texts = input.occurrences.map((o) => measureLabel(o.number, o.pass))
  const numberBoxes = placeMeasureNumbers(
    input.occurrences.map((_, i) => ({ x0: measures[i]!.x0, w: numberWidth(texts[i]!) })),
    ex.obstacles,
    ex.staves[0]?.top ?? 0,
    NUMBER_BOX_H,
  )
  return input.occurrences.map((o, i) => {
    const m = measures[i]!
    const duration = toNumber(o.duration)
    const anchors: [number, number][] = []
    for (const [pos, x] of m.entries) {
      if (pos >= duration - 1e-9) continue
      const prev = anchors.at(-1)
      anchors.push([pos, round(prev ? Math.max(prev[1], x) : x)])
    }
    if (!anchors.length || anchors[0]![0] > 1e-9)
      anchors.unshift([0, round(Math.min(m.contentX, anchors[0]?.[1] ?? m.contentX))])
    anchors.push([duration, round(m.x1)])
    const text = texts[i]!
    const labelBox = roundBox(numberBoxes[i]!)
    return {
      occ: i,
      x0: round(m.x0),
      x1: round(m.x1),
      start: toNumber(o.start),
      duration,
      anchors,
      label: text,
      labelBox,
    }
  })
}

function labelUnits(input: RenderInput, ex: Extraction, mapping: NoteMapping): LabelUnitInput[] {
  return mapping.units.map((notes) => {
    const graphics = notes.map((n) => ex.graphics[mapping.graphicOf[n]!]!)
    const first = input.notes[notes[0]!]!
    const g0 = graphics[0]!
    return {
      notes,
      occ: g0.occ,
      staff: g0.staff,
      hand: first.hand,
      head: unionAll(graphics.map((g) => g.head))!,
      x: g0.x,
    }
  })
}

function noteGeometry(
  input: RenderInput,
  ex: Extraction,
  mapping: NoteMapping,
  labelOfUnit: ReadonlyMap<number, number>,
): (NoteGeometry | null)[] {
  return input.notes.map((n) => {
    const gid = mapping.graphicOf[n.index]!
    if (gid < 0) return null
    const g = ex.graphics[gid]!
    return {
      index: n.index,
      occ: n.occ,
      staff: g.staff,
      hand: n.hand,
      head: roundBox(g.head),
      x: round(g.x),
      label: labelOfUnit.get(mapping.unitOf[n.index]!) ?? -1,
      graphic: g.graphic,
    }
  })
}

const OTTAVA_TEXT: Record<string, string> = { '8up': '8va', '8down': '8vb', '15up': '15ma', '15down': '15mb' }

/** x of a performance position on the strip (linear between onset anchors). */
export function positionX(occurrences: readonly OccurrenceGeometry[], occ: number, offset: number): number {
  const o = occurrences[occ]
  if (!o) return occurrences.at(-1)?.x1 ?? 0
  const a = o.anchors
  for (let i = 1; i < a.length; i++) {
    const [p1, x1] = a[i]!
    if (offset <= p1) {
      const [p0, x0] = a[i - 1]!
      return p1 === p0 ? x0 : x0 + ((offset - p0) / (p1 - p0)) * (x1 - x0)
    }
  }
  return o.x1
}

function ottavaGeometry(
  input: RenderInput,
  raw: readonly RawOttava[],
  occurrences: readonly OccurrenceGeometry[],
  staves: readonly StaffGeometry[],
): { geometry: (OttavaGeometry | null)[]; unmapped: number[]; raw: Map<number, RawOttava> } {
  const used = new Set<RawOttava>()
  const byIndex = new Map<number, RawOttava>()
  const geometry: (OttavaGeometry | null)[] = []
  const unmapped: number[] = []
  for (const span of input.ottavas) {
    const text = OTTAVA_TEXT[`${span.size}${span.sounds}`] ?? `${span.size}`
    const occStart = input.occurrences[span.startOcc]?.start
    const startX = occStart ? positionX(occurrences, span.startOcc, toNumber(span.start) - toNumber(occStart)) : 0
    let best: RawOttava | undefined
    for (const r of raw) {
      if (used.has(r) || r.staff !== span.staff || r.text !== text) continue
      if (Math.abs(r.startX - startX) > 80) continue
      if (!best || Math.abs(r.startX - startX) < Math.abs(best.startX - startX)) best = r
    }
    if (best) {
      used.add(best)
      byIndex.set(span.index, best)
      geometry[span.index] = {
        span: span.index,
        staff: span.staff,
        box: roundBox(best.box),
        labelBox: roundBox(best.labelBox),
        text,
        engraved: true,
      }
      continue
    }
    unmapped.push(span.index)
    const endOccStart =
      input.occurrences[span.endOcc]?.start ?? add(input.occurrences.at(-1)!.start, input.occurrences.at(-1)!.duration)
    const endX = positionX(occurrences, span.endOcc, toNumber(span.end) - toNumber(endOccStart))
    const staff = staves.find((s) => s.index === span.staff)
    const y = span.sounds === 'up' ? (staff?.top ?? 0) - 34 : (staff?.bottom ?? 0) + 14
    const labelBox: Box = { x: round(startX - 6), y: round(y), w: text.length * 8, h: 18 }
    geometry[span.index] = {
      span: span.index,
      staff: span.staff,
      box: roundBox({ x: labelBox.x, y: labelBox.y, w: Math.max(labelBox.w, endX - labelBox.x), h: labelBox.h }),
      labelBox,
      text,
      engraved: false,
    }
  }
  for (let i = 0; i < geometry.length; i++) geometry[i] ??= null
  return { geometry, unmapped, raw: byIndex }
}

/** Adds `data-n` (notes), `data-h` (hand) and `data-o` (ottava span) before sanitizing strips ids. */
function tagElements(
  input: RenderInput,
  ex: Extraction,
  mapping: NoteMapping,
  ottavas: ReadonlyMap<number, RawOttava>,
): void {
  const notesOfGraphic = new Map<number, number[]>()
  input.notes.forEach((n) => {
    const gid = mapping.graphicOf[n.index]!
    if (gid < 0) return
    const list = notesOfGraphic.get(gid)
    if (list) list.push(n.index)
    else notesOfGraphic.set(gid, [n.index])
  })
  const handOfNoteId = new Map<string, string>()
  for (const [gid, notes] of notesOfGraphic) {
    ex.headEls[gid]!.setAttribute('data-n', notes.join(' '))
    const hand = input.notes[notes[0]!]!.hand
    const group = ex.noteGroupEls[gid]
    group?.setAttribute('data-h', hand)
    const sid = ex.graphics[gid]!.graphic
    if (sid) handOfNoteId.set(sid, hand)
  }
  for (const el of ex.svg.querySelectorAll('[id^="vf-auto"]')) {
    const m = /^vf-(auto\d+)/.exec(el.id)
    const hand = m ? handOfNoteId.get(m[1]!) : undefined
    if (hand && !el.hasAttribute('data-h')) el.setAttribute('data-h', hand)
  }
  for (const [span, raw] of ottavas) for (const el of raw.elements) el.setAttribute('data-o', String(span))
}
