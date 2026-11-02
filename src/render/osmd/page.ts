/**
 * Page-mode preparation (portrait; DECISIONS "Portrait page mode"). The same pipeline as the
 * strip's `OsmdRenderer.prepare`, for an engraving wrapped into systems of `pageWidth`:
 *  1. OSMD engraves a normal endless page (`renderSingleHorizontalStaffline: false`) in a hidden
 *     container of the page width;
 *  2. `extractPage` reads per-note, per-measure and per-system geometry, the label obstacles of
 *     each system and the system of every bar;
 *  3. measure numbers are placed at system starts only (R6 placement), labels are reserved per
 *     system against that system's own marks (the same `layoutLabels`), spacing widens like the
 *     strip's when too many labels need callouts;
 *  4. the systems are restacked with a fixed gap (`page/stack.ts`) so reserved labels never meet
 *     the next system, every coordinate moves to page y, and each system becomes one segment.
 */
import { round, roundBox, unionAll } from '../geom'
import { layoutLabels, type LabelLayoutResult, type LabelUnitInput } from '../labels/layout'
import { labelSpacingDemand } from '../labels/spacing'
import {
  NUMBER_BOX_H,
  canvasMeasurer,
  estimateMeasurer,
  LABEL_FONT_FAMILY,
  LABEL_FONT_PX,
  loadLabelFont,
  numberBoxWidth,
  uiFontFamily,
} from '../labels/metrics'
import { NUMBER_OFFSET_Y, placeMeasureNumbers } from '../labels/numbers'
import { layoutKey } from '../cache'
import { mapNotes } from '../mapping'
import { DEFAULT_SEGMENT_WIDTH, partitionPage } from '../partition'
import {
  PAGE_SYSTEM_GAP,
  nearestSystem,
  shiftLabel,
  shiftNote,
  shiftOccurrence,
  shiftOttava,
  shiftStaves,
  stackSystems,
} from '../page/stack'
import { sanitizeSvgTree } from '../sanitize'
import {
  PREPARED_LAYOUT_FORMAT,
  type Box,
  type LabelBox,
  type LabelPlacement,
  type LabelRoom,
  type LayoutStats,
  type OccurrenceGeometry,
  type OttavaGeometry,
  type PreparedLayout,
  type PrepareOptions,
  type PrepareStage,
  type RenderInput,
  type SystemGeometry,
} from '../types'
import { toNumber } from '../../core/music/rational'
import {
  Aborted,
  CALLOUT_TOLERANCE,
  defaultSpacing,
  OSMD_OPTIONS,
  defaultMeasureLabel,
  labelIndexByOcc,
  labelMetrics,
  labelUnits,
  measureAnchors,
  noteGeometry,
  ottavaGeometry,
  tagElements,
} from './adapter'
import { extractPage, type PageExtraction } from './extract'
import { loadOsmd } from './load'
import type { OsmdInstance } from './osmd-types'

/** Page width when the caller gives none (layout px). */
export const DEFAULT_PAGE_WIDTH = 800
/** Narrowest page engraved (layout px): a bar with labels still fits. */
export const MIN_PAGE_WIDTH = 240
/**
 * OSMD page margins in OSMD units (10 layout px): a little room left of the system's opening
 * barline, and room right of its last notes for their reserved labels.
 */
const PAGE_MARGIN_LEFT = 1
const PAGE_MARGIN_RIGHT = 2.5
/** Padding around each system's content extent (layout px), as the strip pads its content. */
const PAD = 6

/** The preferred page width (and cache-key width) for these options. */
export function pageWidthOf(options: Pick<PrepareOptions, 'pageWidth'>): number {
  return Math.max(MIN_PAGE_WIDTH, Math.round(options.pageWidth ?? DEFAULT_PAGE_WIDTH))
}

const now = (): number => performance.now()
const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

export async function preparePage(
  renderer: { readonly name: string; readonly version: string },
  input: RenderInput,
  options: PrepareOptions,
): Promise<PreparedLayout> {
  const t0 = now()
  const signal = options.signal
  const check = (): void => {
    if (signal?.aborted) throw new Aborted()
  }
  const progress = (stage: PrepareStage, f: number): void => options.onProgress?.(stage, f)
  const fontPx = options.labels.fontPx ?? LABEL_FONT_PX
  const host = options.host ?? document.body
  const family = uiFontFamily(host)
  await loadLabelFont(document, fontPx)
  try {
    await document.fonts?.ready
  } catch {
    // Measuring with the fallback metrics of a font still loading is only slightly off.
  }
  const measure = options.textMeasurer ?? canvasMeasurer(document) ?? estimateMeasurer
  const label = labelMetrics(options.labels.maxChars, fontPx, measure, LABEL_FONT_FAMILY)
  const segmentWidth = options.segmentWidth ?? DEFAULT_SEGMENT_WIDTH
  const room = options.labels.room ?? 'all'
  const maxIterations = room === 'hints' ? 1 : Math.max(1, options.maxIterations ?? 3)
  const measureLabel = options.measureLabel ?? defaultMeasureLabel
  const requestedWidth = pageWidthOf(options)
  let pageWidth = requestedWidth

  progress('loading', 0)
  const tl = now()
  const mod = await loadOsmd()
  const loadMs = now() - tl
  check()

  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  container.style.cssText = `position:absolute;left:-200000px;top:0;width:${pageWidth}px;visibility:hidden;pointer-events:none;contain:layout style`
  host.append(container)
  let osmd: OsmdInstance | undefined = new mod.OpenSheetMusicDisplay(container, {
    ...OSMD_OPTIONS,
    renderSingleHorizontalStaffline: false,
  })
  try {
    progress('engraving', 0)
    const te = now()
    await osmd.load(input.renderXml)
    let engraveMs = now() - te
    let extractMs = 0
    let labelMs = 0
    let spacing = options.spacing ?? defaultSpacing(room)
    const failuresPerIteration: number[] = []

    for (let iteration = 1; ; iteration++) {
      check()
      const rules = osmd.EngravingRules
      rules['PageLeftMargin'] = PAGE_MARGIN_LEFT
      rules['PageRightMargin'] = PAGE_MARGIN_RIGHT
      rules['SystemLeftMargin'] = 0
      rules['SystemRightMargin'] = 0
      rules.VoiceSpacingMultiplierVexflow = spacing.voiceSpacingMultiplier
      rules.VoiceSpacingAddendVexflow = spacing.voiceSpacingAddend
      await nextTask()
      const tr = now()
      osmd.render()
      engraveMs += now() - tr
      check()

      progress('extracting', 0)
      await nextTask()
      const tx = now()
      const ex = extractPage(osmd, container, input.occurrences.length)
      const mapping = mapNotes(input.notes, ex.graphics)
      const occurrences = pageOccurrences(input, ex, measureLabel, (text) => numberBoxWidth(text, measure, family))
      extractMs += now() - tx
      check()

      progress('labels', 0)
      const tlab = now()
      const units = labelUnits(input, ex, mapping)
      const result = layoutSystemLabels(units, ex, occurrences, label.w, label.h, fontPx, room)
      labelMs += now() - tlab
      failuresPerIteration.push(result.failures.length)

      // A dense bar cannot wrap halfway through. Increasing voice spacing alone makes OSMD
      // squeeze it back to the same page width, leaving labels in stacks with long leaders.
      // Grow the canvas as well, preserving onset alignment and full-size notation. The view
      // allows horizontal browsing/following only when this exceeds the available viewport.
      const unitsBySystem: LabelUnitInput[][] = ex.systems.map(() => [])
      for (const unit of units) unitsBySystem[ex.systemOfOcc[unit.occ] ?? 0]!.push(unit)
      const demands =
        room === 'all'
          ? unitsBySystem.map((systemUnits) =>
              labelSpacingDemand({
                units: systemUnits,
                labelW: label.w,
                labelH: label.h,
                width: pageWidth,
              }),
            )
          : []
      const spacingFactor = Math.max(1, ...demands.map((d) => d.factor))
      // First let whole bars wrap to another line. Only a bar already alone on its system
      // justifies making the page wider, otherwise ordinary passages would overflow too.
      const requiredWidth = Math.max(
        pageWidth,
        ...demands.map((d, i) => (ex.systems[i]!.occEnd - ex.systems[i]!.occStart === 1 ? d.width : pageWidth)),
      )
      const crowded = spacingFactor > 1 + 1 / pageWidth
      const tooMany = result.failures.length > Math.max(0, units.length * CALLOUT_TOLERANCE)
      if ((crowded || tooMany) && iteration < maxIterations) {
        const factor = crowded
          ? Math.min(3, 1 + (spacingFactor - 1) * 1.25)
          : Math.min(2, Math.max(1.15, result.spacingDemand))
        if (requiredWidth > pageWidth + 1) {
          pageWidth = Math.ceil(Math.min(pageWidth * 3, pageWidth + (requiredWidth - pageWidth) * 1.25))
          container.style.width = `${pageWidth}px`
        }
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
      const engravedLabels: LabelBox[] = order.map(({ l }, id) => ({
        ...l,
        id,
        box: roundBox(l.box),
        tx: round(l.tx),
        ty: round(l.ty),
      }))
      const labelOfUnit = new Map(order.map(({ unit }, id) => [unit, id]))
      const engravedNotes = noteGeometry(input, ex, mapping, labelOfUnit)
      const systemOf = (occ: number): number => ex.systemOfOcc[Math.max(0, Math.min(ex.systemOfOcc.length - 1, occ))]!
      const ottavas = ottavaGeometry(input, ex.ottavas, occurrences, ex.staves, {
        stavesOf: (occ) => ex.systems[systemOf(occ)]!.staves,
        inSystem: (r, occ) => nearestSystem(ex.systems, r.box.y + r.box.h / 2) === systemOf(occ),
      })

      tagElements(input, ex, mapping, ottavas.raw)
      const svgNodes = ex.svgNodes
      sanitizeSvgTree(ex.svg)

      // Each system's content extent (engraved y): its marks, labels, number, ottava brackets.
      const startOccOfSpan = new Map(input.ottavas.map((o) => [o.index, o.startOcc]))
      const extras: Box[][] = ex.systems.map((s) => [s.content, occurrences[s.occStart]!.labelBox])
      for (const l of engravedLabels) extras[systemOf(l.occ)]!.push(l.box)
      ottavas.geometry.forEach((g) => {
        if (g) extras[systemOf(startOccOfSpan.get(g.span) ?? 0)]!.push(g.box)
      })
      const extents = extras.map((boxes) => unionAll(boxes)!)
      const stacked = stackSystems(
        extents.map((e) => [e.y - PAD, e.y + e.h + PAD] as const),
        PAGE_SYSTEM_GAP,
      )
      const right = Math.max(...extents.map((e) => e.x + e.w), occurrences.at(-1)?.x1 ?? 0)
      const width = Math.ceil(Math.max(pageWidth, right + PAD))
      const firstLabelOfOcc = labelIndexByOcc(engravedLabels, occurrences.length)
      const segments = partitionPage(
        ex.systems.map((s, k) => ({
          occStart: s.occStart,
          occEnd: s.occEnd,
          elements: s.elements,
          y0: stacked[k]!.y0,
          y1: stacked[k]!.y1,
          dy: stacked[k]!.dy,
          labelStart: firstLabelOfOcc[s.occStart]!,
          labelEnd: firstLabelOfOcc[s.occEnd]!,
        })),
        width,
      )

      // Every coordinate to page y.
      const dyOf = (occ: number): number => stacked[systemOf(occ)]!.dy
      const systems: SystemGeometry[] = ex.systems.map((s, k) => ({
        index: k,
        occStart: s.occStart,
        occEnd: s.occEnd,
        y0: stacked[k]!.y0,
        y1: stacked[k]!.y1,
        staves: shiftStaves(s.staves, stacked[k]!.dy),
      }))
      const pageOccurrencesOut = occurrences.map((o) => shiftOccurrence(o, dyOf(o.occ), systemOf(o.occ)))
      const notes = engravedNotes.map((n) => (n ? shiftNote(n, dyOf(n.occ), systemOf(n.occ)) : null))
      const labels = engravedLabels.map((l) => shiftLabel(l, dyOf(l.occ)))
      const ottavaGeometryOut = ottavas.geometry.map((g): OttavaGeometry | null =>
        g ? shiftOttava(g, dyOf(startOccOfSpan.get(g.span) ?? 0)) : null,
      )
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
      const layout: PreparedLayout = {
        format: PREPARED_LAYOUT_FORMAT,
        key: layoutKey({
          scoreVersionId: input.scoreVersionId,
          renderer,
          labelChars: options.labels.maxChars,
          labelFontPx: fontPx,
          labelRoom: room,
          segmentWidth,
          mode: 'page',
          pageWidth: requestedWidth,
        }),
        scoreVersionId: input.scoreVersionId,
        renderer: { name: renderer.name, version: renderer.version },
        params: {
          labelChars: options.labels.maxChars,
          labelFontPx: fontPx,
          labelRoom: room,
          labelW: label.w,
          labelH: label.h,
          segmentWidth,
          spacing,
          iterations: iteration,
          pageWidth,
        },
        width,
        top: 0,
        height: stacked.at(-1)?.y1 ?? 0,
        staves: systems[0]?.staves ?? [],
        occurrences: pageOccurrencesOut,
        notes,
        labels,
        ottavas: ottavaGeometryOut,
        contexts: [],
        contextChanges: [],
        segments,
        report: {
          ...mapping.report,
          ottavasMapped: ottavas.geometry.filter((g) => g?.engraved).length,
          ottavasUnmapped: ottavas.unmapped,
        },
        stats,
        mode: 'page',
        systems,
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

/**
 * Bar geometry in engraved coordinates: the strip's onset anchors, the system, and a measure
 * number box placed (R6) only for the bar opening each system; the other bars keep a nominal box
 * that is neither drawn nor an obstacle.
 */
function pageOccurrences(
  input: RenderInput,
  ex: PageExtraction,
  measureLabel: (number: string, pass: number) => string,
  numberWidth: (text: string) => number,
): OccurrenceGeometry[] {
  const starts = new Set(ex.systems.map((s) => s.occStart))
  return input.occurrences.map((o, i) => {
    const m = ex.measures[i]!
    const system = ex.systems[ex.systemOfOcc[i]!]!
    const duration = toNumber(o.duration)
    const text = measureLabel(o.number, o.pass)
    const w = numberWidth(text)
    const top = system.staves[0]?.top ?? 0
    const box = starts.has(i)
      ? placeMeasureNumbers([{ x0: m.x0, w }], system.obstacles, top, NUMBER_BOX_H)[0]!
      : { x: m.x0 + 2, y: top + NUMBER_OFFSET_Y, w, h: NUMBER_BOX_H }
    return {
      occ: i,
      x0: round(m.x0),
      x1: round(m.x1),
      start: toNumber(o.start),
      duration,
      anchors: measureAnchors(m, duration),
      label: text,
      labelBox: roundBox(box),
      system: system.index,
    }
  })
}

/**
 * `layoutLabels` per system, against that system's own marks and its measure number only: after
 * restacking no other system can meet its labels. Results are merged in unit order.
 */
function layoutSystemLabels(
  units: readonly LabelUnitInput[],
  ex: PageExtraction,
  occurrences: readonly OccurrenceGeometry[],
  labelW: number,
  labelH: number,
  fontPx: number,
  room: LabelRoom,
): LabelLayoutResult {
  const bySystem = ex.systems.map(() => [] as number[])
  units.forEach((u, i) => bySystem[ex.systemOfOcc[u.occ] ?? 0]!.push(i))
  const labels: LabelLayoutResult['labels'][number][] = new Array(units.length)
  const failures: number[] = []
  const placements: Record<LabelPlacement, number> = { right: 0, stagger: 0, left: 0, stack: 0, callout: 0 }
  let spacingDemand = 1
  ex.systems.forEach((s, k) => {
    const ids = bySystem[k]!
    if (!ids.length) return
    const res = layoutLabels({
      units: ids.map((i) => units[i]!),
      obstacles: [...s.obstacles, occurrences[s.occStart]!.labelBox],
      staves: s.staves,
      labelW,
      labelH,
      fontPx,
      room,
    })
    res.labels.forEach((l, j) => (labels[ids[j]!] = l))
    for (const f of res.failures) failures.push(ids[f]!)
    for (const key of Object.keys(placements) as LabelPlacement[]) placements[key] += res.placements[key]
    spacingDemand = Math.max(spacingDemand, res.spacingDemand)
  })
  return { labels, failures: failures.sort((a, b) => a - b), spacingDemand, placements }
}
