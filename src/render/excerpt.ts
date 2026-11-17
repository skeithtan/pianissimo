/**
 * Score excerpts for the expanded result card (DECISIONS U99): one bar of an already prepared
 * layout (strip or page), cut out of its segment markup without engraving anything, with the
 * clef and key signature in front of it (as a system of the page shows them), the teacher's
 * red-pen marks of that bar (`shared/corrections.ts`) and "ghost" noteheads for keys that were
 * pressed but are not written there.
 *
 * Everything is a string of SVG in layout px: the bar's own markup is the sanitized segment
 * markup; everything added here is built from numbers and escaped text, so the result holds no
 * script, `foreignObject`, event handler or external reference. Pure (no DOM), so it is unit
 * tested in node; the card mounts the strings only once it is expanded and drops them when it
 * closes.
 */
import { estimateMeasurer, type TextMeasurer } from './labels/metrics'
import { layoutCorrections, penRing, type CorrectionMark } from './shared/corrections'
import type { PreparedLayout, StaffGeometry } from './types'

/** Something to show on the music: its bar (`occ`), in severity order (first = most severe). */
export interface ExcerptItem {
  readonly occ: number
}

/** One bar to draw and the items in it, most severe first. */
export interface ExcerptPlan<T extends ExcerptItem> {
  readonly occ: number
  readonly items: readonly T[]
}

/** Excerpts mounted before "Show N more bars" (`planExcerpts`). */
export const EXCERPT_LIMIT = 4

/**
 * One excerpt per bar, in the order of each bar's most severe item; the items of one bar are
 * shown together under it (a bar is never drawn twice). The first `limit` are `shown`; the rest
 * are `more` (cut from the least severe end).
 */
export function planExcerpts<T extends ExcerptItem>(
  items: readonly T[],
  limit: number = EXCERPT_LIMIT,
): { shown: ExcerptPlan<T>[]; more: ExcerptPlan<T>[] } {
  const byOcc = new Map<number, T[]>()
  for (const item of items) {
    const list = byOcc.get(item.occ)
    if (list) list.push(item)
    else byOcc.set(item.occ, [item])
  }
  const plans = [...byOcc].map(([occ, list]) => ({ occ, items: list }))
  return { shown: plans.slice(0, Math.max(0, limit)), more: plans.slice(Math.max(0, limit)) }
}

/**
 * A key that was pressed but is not written here, drawn as a crossed hollow notehead in the
 * correction red beside the notes of its place. `anchor` is a written note of that place (its
 * staff and notehead fix the ghost's staff and height); `steps` is the ghost's written position
 * in diatonic steps above the anchor's (negative: below); `accidental` is drawn in front of it
 * ("♯", "♭", "♮", "𝄪", "𝄫" or "").
 */
export interface GhostNote {
  readonly anchor: number
  readonly steps: number
  readonly accidental: string
  /** Performed notes of the place (their noteheads' right edge decides where the ghost goes). */
  readonly place: readonly number[]
}

/** Where a ghost is drawn (layout px): notehead center, half sizes, ledger lines and accidental. */
export interface GhostShape {
  readonly cx: number
  readonly cy: number
  readonly rx: number
  readonly ry: number
  /** y of each ledger line the ghost needs (outside the staff), with its x extent. */
  readonly ledgers: readonly number[]
  readonly lx0: number
  readonly lx1: number
  readonly accidental: string
  /** Accidental anchor (text-anchor end, baseline). */
  readonly ax: number
  readonly ay: number
}

/** Ghosts drawn per place; more are only named in words. */
export const GHOSTS_PER_PLACE = 3

/** The staves of the system holding `occ` (page) or of the strip. */
function stavesAt(layout: PreparedLayout, occ: number): readonly StaffGeometry[] {
  const sys = layout.occurrences[occ]?.system
  return (sys !== undefined ? layout.systems?.[sys]?.staves : undefined) ?? layout.staves
}

/**
 * The ghosts' shapes, in order; a ghost whose anchor has no notehead in the layout (or whose
 * staff is unknown) is left out (the words and the ring still say it). Several ghosts at one place
 * stand side by side, right of the place's noteheads; at most `GHOSTS_PER_PLACE` per place.
 */
export function ghostShapes(layout: PreparedLayout, ghosts: readonly GhostNote[]): GhostShape[] {
  const out: GhostShape[] = []
  const perPlace = new Map<string, number>()
  for (const g of ghosts) {
    const anchor = layout.notes[g.anchor]
    if (!anchor) continue
    const staff = stavesAt(layout, anchor.occ).find((s) => s.index === anchor.staff)
    if (!staff || !(staff.bottom > staff.top)) continue
    const key = g.place.join(',')
    const column = perPlace.get(key) ?? 0
    if (column >= GHOSTS_PER_PLACE) continue
    perPlace.set(key, column + 1)
    const space = (staff.bottom - staff.top) / 4
    const half = space / 2
    const cy = anchor.head.y + anchor.head.h / 2 - g.steps * half
    // Right of every notehead of the place (on any staff), with room for the accidental.
    let right = anchor.head.x + anchor.head.w
    for (const n of g.place) {
      const h = layout.notes[n]?.head
      if (h) right = Math.max(right, h.x + h.w)
    }
    const rx = space * 0.72
    const ry = space * 0.54
    const accW = g.accidental ? space * 1.3 : 0
    const step = rx * 2 + accW + space * 0.8
    const cx = right + space * 0.9 + accW + rx + column * step
    // Ledger lines: every staff line position between the staff and the ghost.
    const ledgers: number[] = []
    for (let y = staff.top - space; y >= cy - half * 0.5; y -= space) ledgers.push(y)
    for (let y = staff.bottom + space; y <= cy + half * 0.5; y += space) ledgers.push(y)
    out.push({
      cx,
      cy,
      rx,
      ry,
      ledgers,
      lx0: cx - rx - space * 0.45,
      lx1: cx + rx + space * 0.45,
      accidental: g.accidental,
      ax: cx - rx - space * 0.2,
      ay: cy + space * 0.5,
    })
  }
  return out
}

/** One drawn excerpt: an SVG string and its size in layout px. */
export interface ExcerptMarkup {
  readonly svg: string
  readonly width: number
  readonly height: number
}

export interface ExcerptOptions {
  readonly marks?: readonly CorrectionMark[]
  readonly ghosts?: readonly GhostNote[]
  readonly measurer?: TextMeasurer
}

/** Space kept around the notation of an excerpt (layout px). */
const EXCERPT_PAD = 8

/**
 * Bar `occ` of `layout` as one standalone SVG: the clef, key (and, at a change, time) signature
 * in front when the bar does not engrave its own, the bar's notation and number, the red-pen
 * marks and ghost notes. Null when the bar or its segment is not in the layout.
 */
export function excerptMarkup(layout: PreparedLayout, occ: number, opts: ExcerptOptions = {}): ExcerptMarkup | null {
  const bar = layout.occurrences[occ]
  if (!bar) return null
  const sysIndex = bar.system
  const segment =
    sysIndex !== undefined
      ? layout.segments.find((s) => s.system === sysIndex)
      : layout.segments.find((s) => s.occStart <= occ && occ < s.occEnd)
  if (!segment) return null
  const staves = stavesAt(layout, occ)
  if (staves.length === 0) return null
  const shapes = layoutCorrections(layout, opts.marks ?? [], opts.measurer ?? estimateMeasurer)
  const ghosts = ghostShapes(layout, opts.ghosts ?? [])

  // Vertical extent: the staves, the bar's notes and number, the marks and the ghosts.
  let y0 = Math.min(...staves.map((s) => s.top)) - 20
  let y1 = Math.max(...staves.map((s) => s.bottom)) + 20
  for (const n of layout.notes) {
    if (!n || n.occ !== occ) continue
    y0 = Math.min(y0, n.head.y - 30)
    y1 = Math.max(y1, n.head.y + n.head.h + 30)
  }
  y0 = Math.min(y0, bar.labelBox.y)
  for (const s of shapes) {
    y0 = Math.min(y0, s.y0)
    y1 = Math.max(y1, s.y1)
  }
  for (const g of ghosts) {
    y0 = Math.min(y0, g.cy - g.ry - 4)
    y1 = Math.max(y1, g.cy + g.ry + 4)
  }
  if (sysIndex !== undefined) {
    const sys = layout.systems?.[sysIndex]
    if (sys) {
      y0 = Math.max(y0, sys.y0 - EXCERPT_PAD)
      y1 = Math.min(y1, sys.y1 + EXCERPT_PAD)
    }
  }
  y0 = Math.floor(y0 - EXCERPT_PAD)
  y1 = Math.ceil(y1 + EXCERPT_PAD)

  // Horizontal extent: the bar, widened for marks and ghosts that reach past its bar lines.
  let x0 = bar.x0 - 2
  let x1 = bar.x1 + 2
  for (const s of shapes) {
    x0 = Math.min(x0, s.x0)
    x1 = Math.max(x1, s.x1)
  }
  for (const g of ghosts) x1 = Math.max(x1, g.lx1 + 4)
  x0 = Math.max(segment.x0, Math.floor(x0))
  x1 = Math.min(segment.x1, Math.ceil(x1))

  const prefix = signaturePrefix(layout, occ, staves)
  const pw = prefix ? prefix.width : 0
  const w = r2(pw + (x1 - x0))
  const h = r2(y1 - y0)
  const parts: string[] = []
  if (prefix) parts.push(prefix.svg)
  // The bar: the segment's own markup, cropped to the bar by a nested viewport.
  const inner = innerSvg(segment.svg)
  parts.push(
    `<svg class="pn-ex-music" x="${r2(pw)}" y="${r2(y0)}" width="${r2(x1 - x0)}" height="${h}" viewBox="${r2(x0)} ${r2(y0)} ${r2(x1 - x0)} ${h}">${inner}` +
      numberMarkup(bar.label, bar.labelBox) +
      shapes.map(correctionMarkup).join('') +
      ghosts.map(ghostMarkup).join('') +
      `</svg>`,
  )
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="pn-excerpt-svg" viewBox="0 ${r2(y0)} ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`
  return { svg, width: w, height: h }
}

/**
 * The clef, key and meter in front of a bar that does not engrave its own: the strip's sticky
 * context glyphs (each staff's, drawn with its top line at the staff's y) over five staff lines;
 * on a page, the start of the bar's system (its first bar's clef and key, cut before its first
 * notehead). Null when the bar shows them itself (the first bar, a change at the bar) or nothing
 * is known.
 */
function signaturePrefix(
  layout: PreparedLayout,
  occ: number,
  staves: readonly StaffGeometry[],
): { svg: string; width: number } | null {
  const bar = layout.occurrences[occ]!
  const lines = (width: number) =>
    staves
      .map((st) =>
        Array.from({ length: 5 }, (_, i) => {
          const y = r2(st.top + ((st.bottom - st.top) * i) / 4)
          return `<path d="M0 ${y}H${r2(width)}"/>`
        }).join(''),
      )
      .join('')
  if (layout.mode === 'page') {
    const sys = bar.system !== undefined ? layout.systems?.[bar.system] : undefined
    if (!sys || sys.occStart === occ) return null
    const first = layout.occurrences[sys.occStart]
    const segment = layout.segments.find((s) => s.system === sys.index)
    if (!first || !segment) return null
    let end = first.anchors[0]?.[1] ?? first.x1
    for (const n of layout.notes) if (n && n.occ === sys.occStart) end = Math.min(end, n.head.x)
    // Room for the first note's accidental, which sits left of its head.
    end -= 14
    const width = end - first.x0
    if (!(width > 12)) return null
    const y0 = sys.y0
    const hh = sys.y1 - sys.y0
    return {
      width: r2(width + 6),
      svg:
        `<svg class="pn-ex-sig" x="0" y="${r2(y0)}" width="${r2(width)}" height="${r2(hh)}" viewBox="${r2(first.x0)} ${r2(y0)} ${r2(width)} ${r2(hh)}">${innerSvg(segment.svg)}</svg>` +
        `<g class="pn-ex-staff">${lines(width + 6).replace(/M0 /g, `M${r2(width)} `)}</g>`,
    }
  }
  const changes = layout.contextChanges
  if (changes.length === 0) return null
  let at = changes[0]!
  for (const c of changes) if (c.x <= bar.x0 + 1) at = c
  // The bar engraves the context itself: the piece's first bar, or a change at this bar.
  if (at.occ === occ) return null
  const ctx = layout.contexts[at.context]
  if (!ctx) return null
  const glyphs = ctx.staves
    .map((s) => {
      const st = staves.find((g) => g.index === s.staff)
      return st ? `<g transform="translate(0 ${r2(st.top)})">${s.glyph.svg}</g>` : ''
    })
    .join('')
  const width = ctx.width + 6
  return { width: r2(width), svg: `<g class="pn-ex-staff">${lines(width)}</g><g class="pn-ex-sig">${glyphs}</g>` }
}

/** The markup inside a standalone `<svg …>…</svg>` string. */
function innerSvg(svg: string): string {
  const open = svg.indexOf('>', svg.indexOf('<svg'))
  const close = svg.lastIndexOf('</svg>')
  return open < 0 || close < open ? '' : svg.slice(open + 1, close)
}

function numberMarkup(label: string, box: { x: number; y: number; h: number }): string {
  if (!label) return ''
  return `<text class="pn-ex-num" x="${r2(box.x)}" y="${r2(box.y + box.h - 2)}">${escapeText(label)}</text>`
}

function correctionMarkup(shape: ReturnType<typeof layoutCorrections>[number]): string {
  const out: string[] = [`<g class="pn-ex-corr pn-corr-${shape.mark.kind}">`]
  for (const k of shape.links)
    out.push(`<line class="pn-corr-link" x1="${r2(k.x1)}" y1="${r2(k.y1)}" x2="${r2(k.x2)}" y2="${r2(k.y2)}"/>`)
  const label = shape.label
  if (label)
    out.push(
      `<line class="pn-corr-leader" x1="${r2(label.leader.x)}" y1="${r2(label.leader.y1)}" x2="${r2(label.leader.x)}" y2="${r2(label.leader.y2)}"/>`,
    )
  for (const ring of shape.rings)
    out.push(
      `<path class="pn-corr-ring" d="${penRing(ring.cx, ring.cy, ring.rx, ring.ry)}" transform="rotate(-3 ${r2(ring.cx)} ${r2(ring.cy)})"/>`,
    )
  if (label)
    out.push(
      `<text class="pn-corr-label pn-corr-halo" x="${r2(label.x)}" y="${r2(label.y)}" text-anchor="middle">${escapeText(shape.mark.text)}</text>`,
    )
  out.push('</g>')
  return out.join('')
}

function ghostMarkup(g: GhostShape): string {
  const out: string[] = ['<g class="pn-ex-ghost">']
  for (const y of g.ledgers)
    out.push(`<line class="pn-ex-ledger" x1="${r2(g.lx0)}" y1="${r2(y)}" x2="${r2(g.lx1)}" y2="${r2(y)}"/>`)
  out.push(
    `<ellipse class="pn-ex-head" cx="${r2(g.cx)}" cy="${r2(g.cy)}" rx="${r2(g.rx)}" ry="${r2(g.ry)}" transform="rotate(-20 ${r2(g.cx)} ${r2(g.cy)})"/>`,
  )
  // The cross: never mistaken for a printed (filled or hollow) notehead, whatever the color.
  const dx = g.rx * 0.62
  const dy = g.ry * 0.9
  out.push(
    `<path class="pn-ex-cross" d="M${r2(g.cx - dx)} ${r2(g.cy - dy)}L${r2(g.cx + dx)} ${r2(g.cy + dy)}M${r2(g.cx - dx)} ${r2(g.cy + dy)}L${r2(g.cx + dx)} ${r2(g.cy - dy)}"/>`,
  )
  if (g.accidental)
    out.push(
      `<text class="pn-ex-acc" x="${r2(g.ax)}" y="${r2(g.ay)}" text-anchor="end">${escapeText(g.accidental)}</text>`,
    )
  out.push('</g>')
  return out.join('')
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}
