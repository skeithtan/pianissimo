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
  /** Performance start of each occurrence (whole notes): a clef change after it is mid-bar. */
  readonly occStart: readonly number[]
  /** x of the onset `offset` whole notes into occurrence `occ` (adapter `positionX`). */
  readonly xAt: (occ: number, offset: number) => number
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
  const offsetOf = (c: ClefInput): number => c.at.n / c.at.d - (input.occStart[c.occ] ?? 0)
  // A clef change after the bar's start applies from where it is drawn, not from the barline.
  const isMid = (c: ClefInput): boolean => offsetOf(c) > 1e-9
  const byAt = (a: ClefInput, b: ClefInput): number => a.at.n / a.at.d - b.at.n / b.at.d
  /** The clef in force from the barline of `occ` on `staff` (changes after the bar start excluded). */
  const clefAtBar = (staff: number, occ: number): ClefInput | undefined =>
    input.clefs
      .filter((c) => c.staff === staff && c.occ === occ && !isMid(c))
      .sort(byAt)
      .at(-1)
  for (const s of staves) {
    const k = clefAtBar(s.index, 0)?.key
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
    ...input.clefs.filter((c) => !isMid(c)).map((c) => c.occ),
    ...input.keys.map((k) => k.occ),
    ...input.meters.map((m) => m.occ),
  ])
  changeOccs.delete(0)
  /** Mid-bar clef changes, grouped by bar and onset (both staves changing at once are one change). */
  const mids = new Map<string, ClefInput[]>()
  for (const c of [...input.clefs].filter(isMid).sort(byAt)) {
    const k = `${c.occ}:${c.at.n / c.at.d}`
    const group = mids.get(k)
    if (group) group.push(c)
    else mids.set(k, [c])
  }
  type Step = { readonly occ: number; readonly order: number; readonly mid?: readonly ClefInput[] }
  const steps: Step[] = [
    ...[...changeOccs].map((occ) => ({ occ, order: -1 })),
    ...[...mids.values()].map((mid) => ({ occ: mid[0]!.occ, order: offsetOf(mid[0]!), mid })),
  ].sort((a, b) => a.occ - b.occ || a.order - b.order)

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
    // Kept in x order for the strip's binary search.
    const last = changes.at(-1)
    if (last?.context !== id) changes.push({ x: Math.max(x, last?.x ?? x), occ, context: id, glyphEnd })
  }
  emit(0, 0, initialEnd)

  const setClef = (s: StaffGeometry, ev: ClefInput, small: Element | undefined): void => {
    const st = state[s.index]!
    const full = fullClefs.get(ev.key)
    if (full) st.clef = { ...piece(full.el, full.staff), pivotY: full.staff.top }
    else if (small) st.clef = piece(small, s, SMALL_CLEF_SCALE, clefLineY(s, ev.clef.line))
  }

  for (const step of steps) {
    const occ = step.occ
    if (step.mid) {
      // Switches where the change clef is drawn (else at its onset): notes before it keep the old clef.
      let x = Infinity
      let end = -Infinity
      for (const ev of step.mid) {
        const s = staves.find((g) => g.index === ev.staff)
        if (!s) continue
        const onset = input.xAt(occ, offsetOf(ev))
        const small = clefNear(glyphs[s.index]?.[occ]?.clefs, onset, bbox)
        setClef(s, ev, small)
        const b = small ? bbox(small) : null
        x = Math.min(x, b ? b.x : onset)
        end = Math.max(end, b ? bboxRight(b) : onset)
      }
      if (Number.isFinite(x)) emit(occ, x, end)
      continue
    }
    const x = input.occX[occ] ?? 0
    let end = x
    for (const s of staves) {
      const st = state[s.index]!
      const ev = clefAtBar(s.index, occ)
      if (ev) {
        const small = nearestClef(glyphs[s.index], occ, x, bbox)
        setClef(s, ev, small)
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

type ClefInput = RenderInput['clefs'][number]

const bboxRight = (b: Box): number => b.x + b.w

/** The clef glyph of a bar drawn nearest an onset x (a mid-bar change clef sits just before its note). */
function clefNear(clefs: readonly Element[] | undefined, x: number, bbox: (el: Element) => Box): Element | undefined {
  let best: Element | undefined
  let bestD = Infinity
  for (const el of clefs ?? []) {
    const b = bbox(el)
    const d = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0
    if (d < bestD) {
      bestD = d
      best = el
    }
  }
  return bestD < 80 ? best : undefined
}

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
