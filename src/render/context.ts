/**
 * Sticky clef / key signature / meter (spec "Practice screen": keep them available at the viewport
 * edge when their original symbols scroll away). Glyphs are copied from the engraving itself:
 * full-size clefs from the opening measure (a clef first met as a smaller change clef is scaled
 * up about its reference line), key signatures without their cancellation naturals, and the
 * engraved meter. Each context is one SVG fragment per staff with the staff's top line at y = 0.
 */
import type { Box, ContextChange, ContextState, RenderInput, StaffGeometry, StaffContext } from './types'

export interface GlyphSource {
  readonly clef?: Element
  readonly clefs?: readonly Element[]
  readonly key?: Element
  readonly time?: Element
}

export interface ContextInput {
  readonly staves: readonly StaffGeometry[]
  /** [staff][occ]. */
  readonly glyphs: readonly (readonly GlyphSource[])[]
  /** Left barline x by occurrence. */
  readonly occX: readonly number[]
  readonly clefs: RenderInput['clefs']
  readonly keys: RenderInput['keys']
  readonly meters: RenderInput['meters']
  readonly bbox: (el: Element) => Box
}

interface Piece {
  readonly html: string
  readonly box: Box
  /** Uniform scale applied about (box.x, pivotY). */
  readonly scale: number
  readonly pivotY: number
}

interface StaffState {
  clef?: Piece
  key?: Piece
  time?: Piece
}

const GAP = 6
const PAD = 4
/** VexFlow change clefs are drawn at 2/3 of the default size. */
const SMALL_CLEF_SCALE = 1.5

function clefLineY(staff: StaffGeometry, line: number): number {
  return staff.top + (5 - line) * ((staff.bottom - staff.top) / 4)
}

export function buildContexts(input: ContextInput): { contexts: ContextState[]; changes: ContextChange[] } {
  const { staves, glyphs, bbox } = input
  const piece = (el: Element, staff: StaffGeometry, scale = 1, pivotY = staff.top): Piece => ({
    html: el.outerHTML,
    box: bbox(el),
    scale,
    pivotY,
  })

  const fullClefs = new Map<string, { el: Element; staff: StaffGeometry }>()
  const clefKeyAt = (staff: number, occ: number): string | undefined =>
    input.clefs
      .filter((c) => c.staff === staff && c.occ === occ)
      .sort((a, b) => a.at.n / a.at.d - b.at.n / b.at.d)
      .at(-1)?.key
  for (const s of staves) {
    const k = clefKeyAt(s.index, 0)
    const el = glyphs[s.index]?.[0]?.clef
    if (k && el && !fullClefs.has(k)) fullClefs.set(k, { el, staff: s })
  }

  const state: StaffState[] = staves.map((s) => {
    const g = glyphs[s.index]?.[0]
    const st: StaffState = {}
    if (g?.clef) st.clef = piece(g.clef, s)
    if (g?.key) st.key = piece(g.key, s)
    if (g?.time) st.time = piece(g.time, s)
    return st
  })
  const initialEnd = Math.max(
    0,
    ...state.flatMap((st) => [st.clef, st.key, st.time].filter((p): p is Piece => !!p).map((p) => p.box.x + p.box.w)),
  )

  const changeOccs = new Set<number>([
    ...input.clefs.map((c) => c.occ),
    ...input.keys.map((k) => k.occ),
    ...input.meters.map((m) => m.occ),
  ])
  changeOccs.delete(0)

  const contexts: ContextState[] = []
  const signatures = new Map<string, number>()
  const changes: ContextChange[] = []
  const emit = (occ: number, x: number, glyphEnd: number): void => {
    const sig = state.map((st) => [st.clef?.html, st.key?.html, st.time?.html].join('|')).join('||')
    let id = signatures.get(sig)
    if (id === undefined) {
      id = contexts.length
      signatures.set(sig, id)
      contexts.push(compose(id, staves, state))
    }
    if (changes.at(-1)?.context !== id) changes.push({ x, occ, context: id, glyphEnd })
  }
  emit(0, 0, initialEnd)

  for (const occ of [...changeOccs].sort((a, b) => a - b)) {
    const x = input.occX[occ] ?? 0
    let end = x
    for (const s of staves) {
      const st = state[s.index]!
      const clefKey = clefKeyAt(s.index, occ)
      if (clefKey) {
        const ev = input.clefs.find((c) => c.staff === s.index && c.occ === occ && c.key === clefKey)!
        const full = fullClefs.get(clefKey)
        const small = nearestClef(glyphs[s.index], occ, x, bbox)
        if (full) {
          st.clef = { ...piece(full.el, full.staff), pivotY: full.staff.top }
        } else if (small) {
          st.clef = piece(small, s, SMALL_CLEF_SCALE, clefLineY(s, ev.clef.line))
        }
        if (small) end = Math.max(end, bboxRight(bbox(small)))
      }
      const keyEv = input.keys.find((k) => k.occ === occ)
      if (keyEv) {
        const el = glyphs[s.index]?.[occ]?.key
        if (keyEv.fifths === 0 || !el) delete st.key
        else st.key = keyPiece(el, Math.abs(keyEv.fifths), s, bbox)
        if (el) end = Math.max(end, bboxRight(bbox(el)))
      }
      if (input.meters.some((m) => m.occ === occ)) {
        const el = glyphs[s.index]?.[occ]?.time
        if (el) {
          st.time = piece(el, s)
          end = Math.max(end, bboxRight(bbox(el)))
        }
      }
    }
    emit(occ, x, end)
  }
  return { contexts, changes }
}

const bboxRight = (b: Box): number => b.x + b.w

/** The change clef drawn nearest the barline before `occ` (end of the previous measure or start of this one). */
function nearestClef(
  staffGlyphs: readonly GlyphSource[] | undefined,
  occ: number,
  x: number,
  bbox: (el: Element) => Box,
): Element | undefined {
  let best: Element | undefined
  let bestD = Infinity
  for (const m of [staffGlyphs?.[occ - 1], staffGlyphs?.[occ]]) {
    for (const el of m?.clefs ?? []) {
      const b = bbox(el)
      const d = Math.min(Math.abs(b.x + b.w - x), Math.abs(b.x - x))
      if (d < bestD) {
        bestD = d
        best = el
      }
    }
  }
  return bestD < 80 ? best : undefined
}

/** Drops leading cancellation naturals: keeps the last `count` accidental glyphs. */
function keyPiece(el: Element, count: number, staff: StaffGeometry, bbox: (el: Element) => Box): Piece {
  const kids = [...el.children]
  if (kids.length <= count) return { html: el.outerHTML, box: bbox(el), scale: 1, pivotY: staff.top }
  const kept = kids.slice(kids.length - count)
  const boxes = kept.map(bbox)
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const btm = Math.max(...boxes.map((b) => b.y + b.h))
  return {
    html: `<g class="vf-keysignature">${kept.map((k) => k.outerHTML).join('')}</g>`,
    box: { x, y, w: r - x, h: btm - y },
    scale: 1,
    pivotY: staff.top,
  }
}

function compose(id: number, staves: readonly StaffGeometry[], state: readonly StaffState[]): ContextState {
  const col = (pick: (st: StaffState) => Piece | undefined): number =>
    Math.max(
      0,
      ...state.map((st) => {
        const p = pick(st)
        return p ? p.box.w * p.scale : 0
      }),
    )
  const clefW = col((s) => s.clef)
  const keyW = col((s) => s.key)
  const timeW = col((s) => s.time)
  const clefX = PAD
  const keyX = clefX + clefW + (clefW ? GAP : 0)
  const timeX = keyX + keyW + (keyW ? GAP : 0)
  const width = timeX + timeW + (timeW ? GAP : 0) + PAD

  const staffContexts: StaffContext[] = staves.map((s) => {
    const st = state[s.index]!
    const parts = [place(st.clef, clefX, s), place(st.key, keyX, s), place(st.time, timeX, s)].join('')
    return { staff: s.index, glyph: { svg: parts, width } }
  })
  return { id, staves: staffContexts, width }
}

/** Positions a piece at `x`, relative to its staff's top line (y = 0). */
function place(p: Piece | undefined, x: number, staff: StaffGeometry): string {
  if (!p) return ''
  const r = (v: number): number => Math.round(v * 100) / 100
  if (p.scale === 1) {
    return `<g transform="translate(${r(x - p.box.x)} ${r(-p.pivotY)})">${p.html}</g>`
  }
  const lineY = p.pivotY - staff.top
  return (
    `<g transform="translate(${r(x)} ${r(lineY)}) scale(${p.scale})">` +
    `<g transform="translate(${r(-p.box.x)} ${r(-p.pivotY)})">${p.html}</g></g>`
  )
}
