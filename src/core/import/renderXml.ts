/**
 * MusicXML for the engraver (`ScorePackage.renderXml`; DECISIONS M5, R1):
 *  - the selected parts only, one `<measure>` per `MeasureOccurrence` in performance order,
 *    numbered 1…N so every occurrence is unique (the app draws printed numbers and passes itself);
 *  - repeat and ending barlines, `<print>` layout/breaks and multi-measure-rest styles removed;
 *  - pitches and notations unchanged (the engraver applies octave shifts for display);
 *  - after a repeat jump, the key, time, clefs and divisions in force at the jump target are
 *    re-stated where they differ from the bar before the jump, so the engraving context is right;
 *  - octave-shift markup is re-written from the model's performed spans (same type, size, number
 *    and source attributes; spans cut by a jump are closed and reopened) and placed where OSMD
 *    2.2.1 reads exactly the model's half-open scope (see `placeShifts`): a source stop written at
 *    the next bar's first beat, as in the reference piece, would otherwise displace that beat's notes too;
 *  - a D.C. / D.S. / To Coda / Fine instruction that the performance follows is shown only on the
 *    occurrence where it takes effect (the strip is already in performance order); instructions
 *    that are not followed keep their written appearance on every pass; a segno/coda sign is
 *    shown once, where a followed jump lands on it (else on its bar's first pass).
 *    Navigation is display-only here: `<sound>` navigation attributes are removed and navigation
 *    words end with an invisible U+2060 so OSMD draws them as text instead of building its own
 *    repetition structure (its word patterns are anchored, e.g. "^(d.c. al fine)[ .]*$").
 */
import { type Rational, ONE, ZERO, add, eq, gt, isZero, lt, max, sub } from '../music/rational'
import type { MeasureOccurrence, SourceMeasure } from '../model/score'
import type { NavAction } from './navigation'
import type { PerformedOttava } from './ottava'
import { PosIndex } from './positions'
import type { RawClef, RawDivisions, RawKey, RawTime } from './read/types'
import { decimalRat, divisionsToWhole, wholeToDivisions } from './read/values'
import type { SelectedPart } from './skeleton'
import {
  attr,
  child,
  childText,
  childrenNamed,
  el,
  elements,
  isElement,
  serializeElement,
  textEl,
  type XmlElement,
  type XmlNode,
} from './xml'

const HEADER_KEEP = new Set(['work', 'movement-number', 'movement-title', 'identification', 'defaults'])

const ATTRIBUTE_ORDER = [
  'footnote',
  'level',
  'divisions',
  'key',
  'time',
  'staves',
  'part-symbol',
  'instruments',
  'clef',
  'staff-details',
  'transpose',
  'for-part',
  'directive',
  'measure-style',
]

function decimal(r: Rational): string {
  if (r.d === 1) return String(r.n)
  const v = r.n / r.d
  return String(Math.round(v * 1e6) / 1e6)
}

function filteredPartList(root: XmlElement, selected: ReadonlySet<string>): XmlElement | undefined {
  const list = childrenNamed(root, 'part-list')[0]
  if (!list) return undefined
  const kept: XmlElement[] = []
  for (const c of elements(list)) {
    if (c.name === 'score-part') {
      if (selected.has(attr(c, 'id') ?? '')) kept.push(c)
    } else if (c.name === 'part-group') {
      kept.push(c)
    }
  }
  // Drop part-group start/stop pairs that no longer enclose a selected part.
  const drop = new Set<XmlElement>()
  const open = new Map<string, { el: XmlElement; parts: number }>()
  for (const c of kept) {
    if (c.name === 'score-part') {
      for (const g of open.values()) g.parts++
      continue
    }
    const number = attr(c, 'number') ?? '1'
    if (attr(c, 'type') === 'start') open.set(number, { el: c, parts: 0 })
    else {
      const g = open.get(number)
      if (!g || g.parts === 0) {
        drop.add(c)
        if (g) drop.add(g.el)
      }
      open.delete(number)
    }
  }
  for (const g of open.values()) drop.add(g.el)
  return el(
    'part-list',
    { ...list.attrs },
    kept.filter((c) => !drop.has(c)),
  )
}

interface PartContext {
  readonly keys: PosIndex<RawKey>
  readonly times: PosIndex<RawTime>
  readonly divisions: PosIndex<RawDivisions>
  readonly clefs: ReadonlyMap<number, PosIndex<RawClef>>
}

function partContext(part: SelectedPart): PartContext {
  const clefs = new Map<number, PosIndex<RawClef>>()
  for (let s = 1; s <= part.staffCount; s++) clefs.set(s, new PosIndex(part.data.clefs.filter((c) => c.staff === s)))
  return {
    keys: new PosIndex(part.data.keys),
    times: new PosIndex(part.data.times),
    divisions: new PosIndex(part.data.divisions),
    clefs,
  }
}

/** Attribute children to re-state when entering source measure `m` right after measure `prev`. */
function jumpAttributes(ctx: PartContext, prev: number, m: number): XmlElement[] {
  const out: XmlElement[] = []
  const before = <T extends { readonly m: number; readonly at: Rational }>(index: PosIndex<T>) =>
    [index.beforeMeasure(prev + 1), index.beforeMeasure(m)] as const
  const [dPrev, dNext] = before(ctx.divisions)
  if (dNext && (!dPrev || dPrev.value.n * dNext.value.d !== dNext.value.n * dPrev.value.d)) {
    out.push(textEl('divisions', decimal(dNext.value)))
  }
  const [kPrev, kNext] = before(ctx.keys)
  if (kNext?.el && (!kPrev || kPrev.fifths !== kNext.fifths || kPrev.mode !== kNext.mode)) out.push(kNext.el)
  const [tPrev, tNext] = before(ctx.times)
  if (tNext?.el && (!tPrev || tPrev.el !== tNext.el)) {
    const same =
      tPrev !== undefined &&
      tPrev.beatsText === tNext.beatsText &&
      tPrev.beatType === tNext.beatType &&
      tPrev.symbol === tNext.symbol &&
      tPrev.senzaMisura === tNext.senzaMisura
    if (!same) out.push(tNext.el)
  }
  for (const [staff, index] of ctx.clefs) {
    const [cPrev, cNext] = before(index)
    if (!cNext?.el) continue
    const c = cNext.clef
    const p = cPrev?.clef
    if (!p || p.sign !== c.sign || p.line !== c.line || p.octaveChange !== c.octaveChange) {
      out.push(
        cNext.el.attrs['number'] === undefined && staff !== 1
          ? { ...cNext.el, attrs: { ...cNext.el.attrs, number: String(staff) } }
          : cNext.el,
      )
    }
  }
  return out
}

function orderAttributes(children: readonly XmlNode[]): XmlNode[] {
  const rank = (n: XmlNode) => (isElement(n) ? ATTRIBUTE_ORDER.indexOf(n.name) : -1)
  return children
    .map((c, i) => [c, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([c]) => c)
}

/** Merge re-stated context into a measure's own leading `<attributes>` (its own values win). */
function mergeAttributes(own: XmlElement | undefined, restated: readonly XmlElement[]): XmlElement {
  if (!own) return el('attributes', {}, orderAttributes(restated))
  const ownNames = new Set<string>()
  const ownClefStaves = new Set<string>()
  for (const c of elements(own)) {
    if (c.name === 'clef') ownClefStaves.add(attr(c, 'number') ?? '1')
    else ownNames.add(c.name)
  }
  const extra = restated.filter((r) =>
    r.name === 'clef' ? !ownClefStaves.has(attr(r, 'number') ?? '1') : !ownNames.has(r.name),
  )
  return el('attributes', { ...own.attrs }, orderAttributes([...own.children, ...extra]))
}

/** A direction holding an octave-shift start or stop for a performed span (source attributes kept). */
function octaveShiftDirection(o: PerformedOttava, kind: 'start' | 'stop'): XmlElement {
  const s = o.source
  const source = kind === 'start' ? s.startEl : (s.stopEl ?? s.startEl)
  const type = kind === 'stop' ? 'stop' : s.sounds === 'up' ? 'down' : 'up'
  const shift = el('octave-shift', { ...source.attrs, type, size: String(s.size), number: s.number })
  return el('direction', { placement: s.sounds === 'up' ? 'above' : 'below' }, [
    el('direction-type', {}, [shift]),
    textEl('staff', s.staffNumber),
  ])
}

/** A note that moves a reader's "previous note" position: onset, cursor after it, its chord group's last index. */
interface Anchor {
  readonly onset: Rational
  readonly next: Rational
  readonly staff: number
  readonly divisions: Rational
  end: number
}

/** Non-chord, non-grace notes (rests included) of a measure's content, with the divisions at the start. */
function noteAnchors(
  nodes: readonly XmlNode[],
  divisions: Rational,
  bodyStart: number,
): { anchors: Anchor[]; startDivisions: Rational } {
  const anchors: Anchor[] = []
  let cursor = ZERO
  let div = divisions
  let startDivisions = divisions
  let current: Anchor | null = null
  nodes.forEach((n, index) => {
    if (index === bodyStart) startDivisions = div
    if (!isElement(n)) return
    if (n.name === 'attributes') {
      const d = decimalRat(childText(n, 'divisions'))
      if (d && d.n > 0) div = d
      return
    }
    if (n.name !== 'note' && n.name !== 'backup' && n.name !== 'forward') return
    const raw = decimalRat(childText(n, 'duration'))
    const w = raw ? divisionsToWhole(raw, div) : ZERO
    if (n.name === 'backup') {
      cursor = max(ZERO, sub(cursor, w))
      return
    }
    if (n.name === 'forward') {
      cursor = add(cursor, w)
      return
    }
    if (child(n, 'chord')) {
      if (current) current.end = index
      return
    }
    if (child(n, 'grace') || isZero(w)) {
      current = null
      return
    }
    current = {
      onset: cursor,
      next: add(cursor, w),
      staff: Number(childText(n, 'staff') ?? '1') || 1,
      divisions: div,
      end: index,
    }
    anchors.push(current)
    cursor = add(cursor, w)
  })
  if (bodyStart >= nodes.length) startDivisions = div
  return { anchors, startDivisions }
}

interface ShiftPlacement {
  readonly node: XmlElement
  readonly kind: 'start' | 'stop'
  readonly number: string
  /** Start: the span's first position in the bar; stop: the span's end in the bar (exclusive). */
  readonly offset: Rational
  readonly staffNumber: number
}

/** `node` at `offset` from a reader cursor at `cursor`, restoring the cursor afterwards. */
function atCursor(node: XmlElement, offset: Rational, cursor: Rational, divisions: Rational): XmlElement[] {
  if (eq(offset, cursor)) return [node]
  const forward = gt(offset, cursor)
  const d = decimal(wholeToDivisions(forward ? sub(offset, cursor) : sub(cursor, offset), divisions))
  const move = (name: string) => el(name, {}, [textEl('duration', d)])
  return forward ? [move('forward'), node, move('backup')] : [move('backup'), node, move('forward')]
}

/**
 * Insert octave-shift directions so OSMD 2.2.1 reads the model's scope. OSMD starts a shift at
 * the reader cursor, but ends it at the onset of the last note read and treats that end as
 * inclusive (a stop written before the notes at its timestamp, or at a bar's end, would cover
 * the following notes). So each stop goes right after the chord group at the last position
 * before the span's end, and each start is placed by cursor: at the bar's beginning, or right
 * after a stop of the same number in the same bar so the stop is read first.
 */
function placeShifts(
  children: readonly XmlNode[],
  items: readonly ShiftPlacement[],
  divisions: Rational,
  bodyStart: number,
): XmlNode[] {
  const { anchors, startDivisions } = noteAnchors(children, divisions, bodyStart)
  const after = new Map<number, XmlElement[]>()
  const push = (at: number, nodes: XmlElement[]) => {
    let list = after.get(at)
    if (!list) after.set(at, (list = []))
    list.push(...nodes)
  }
  const stops: { readonly number: string; readonly offset: Rational; readonly anchor: Anchor | undefined }[] = []
  for (const it of items) {
    if (it.kind !== 'stop') continue
    let best: Anchor | undefined
    for (const a of anchors) {
      if (!lt(a.onset, it.offset)) continue
      if (
        !best ||
        gt(a.onset, best.onset) ||
        (eq(a.onset, best.onset) && a.staff === it.staffNumber && best.staff !== it.staffNumber)
      )
        best = a
    }
    push(best ? best.end : -1, [it.node])
    stops.push({ number: it.number, offset: it.offset, anchor: best })
  }
  for (const it of items) {
    if (it.kind !== 'start') continue
    // A span of the same number ending in this bar before this one starts must be read first.
    const previous = stops.find((s) => s.number === it.number && !gt(s.offset, it.offset) && s.anchor)
    if (previous?.anchor)
      push(previous.anchor.end, atCursor(it.node, it.offset, previous.anchor.next, previous.anchor.divisions))
    else push(-1, atCursor(it.node, it.offset, ZERO, startDivisions))
  }
  const out: XmlNode[] = []
  children.forEach((c, i) => {
    if (i === bodyStart) out.push(...(after.get(-1) ?? []))
    out.push(c)
    out.push(...(after.get(i) ?? []))
  })
  if (bodyStart >= children.length) out.push(...(after.get(-1) ?? []))
  return out
}

/** Without a repeat or ending a barline is kept; with one it is dropped entirely. */
function keepBarline(b: XmlElement): boolean {
  return !elements(b).some((c) => c.name === 'repeat' || c.name === 'ending')
}

function cleanAttributes(a: XmlElement): XmlElement | null {
  let changed = false
  const children: XmlNode[] = []
  for (const c of a.children) {
    if (isElement(c) && c.name === 'measure-style' && elements(c).some((x) => x.name === 'multiple-rest')) {
      changed = true
      const rest = c.children.filter((x) => !(isElement(x) && x.name === 'multiple-rest'))
      if (rest.some(isElement)) children.push({ ...c, children: rest })
      continue
    }
    children.push(c)
  }
  if (!changed) return a
  return children.some(isElement) ? { ...a, children } : null
}

export interface RenderXmlInput {
  readonly root: XmlElement
  readonly parts: readonly SelectedPart[]
  readonly occurrences: readonly MeasureOccurrence[]
  readonly measures: readonly SourceMeasure[]
  readonly ottavas: readonly PerformedOttava[]
  /** Navigation instructions per source element, and the action taken at each occurrence's end. */
  readonly navigation?: {
    readonly elements: ReadonlyMap<XmlElement, readonly NavAction[]>
    readonly actions: readonly (NavAction | undefined)[]
  }
}

/** `<sound>` attributes that carry navigation (dropped with the instruction they belong to). */
const NAV_SOUND_ATTRS = ['segno', 'coda', 'tocoda', 'fine', 'dacapo', 'dalsegno']

const WORD_JOINER = '\u2060'

/** A `<sound>` without navigation attributes (null if nothing remains). */
function stripNavSound(s: XmlElement): XmlElement | null {
  if (!NAV_SOUND_ATTRS.some((a) => s.attrs[a] !== undefined)) return s
  const attrs = { ...s.attrs }
  for (const a of NAV_SOUND_ATTRS) delete attrs[a]
  return Object.keys(attrs).length > 0 || s.children.some(isElement) ? { ...s, attrs } : null
}

/**
 * A navigation direction or measure-level sound for display only (see module doc): navigation
 * `<sound>` attributes removed, words made opaque to OSMD's repetition reader, and, when `hide`,
 * the navigation words and signs dropped. An instruction keeps its words but not its sign ("To
 * Coda ⊕"), and a coda sign becomes the word "Coda": OSMD 2.2.1 draws any `<coda/>` it reads as
 * its own "To ⊕". Null if nothing remains.
 */
function displayNavigation(c: XmlElement, hide: boolean, instruction: boolean): XmlElement | null {
  if (c.name === 'sound') return stripNavSound(c)
  const children: XmlNode[] = []
  let types = 0
  let words = false
  let coda = false
  for (const x of c.children) {
    if (!isElement(x)) {
      children.push(x)
      continue
    }
    if (x.name === 'direction-type') {
      const kinds = elements(x).map((w) => w.name)
      const sign = kinds.includes('segno') || kinds.includes('coda')
      if (hide && (sign || kinds.includes('words'))) continue
      if (kinds.includes('coda') || (instruction && sign)) {
        coda ||= kinds.includes('coda') && !instruction
        continue
      }
      types++
      words ||= kinds.includes('words')
      children.push({
        ...x,
        children: x.children.map((w) =>
          isElement(w) && w.name === 'words' ? { ...w, children: [...w.children, WORD_JOINER] } : w,
        ),
      })
      continue
    }
    if (x.name === 'sound') {
      const sound = stripNavSound(x)
      if (sound) children.push(sound)
      continue
    }
    children.push(x)
  }
  if (coda && !words) {
    children.unshift(el('direction-type', {}, [el('words', {}, ['Coda', WORD_JOINER])]))
    types++
  }
  return types > 0 ? { ...c, children } : null
}

/** Serialize the unfolded render XML (see module doc). */
export function buildRenderXml(input: RenderXmlInput): string {
  const { root, parts, occurrences, measures, ottavas } = input
  // Source measures where each navigation action was actually taken, and the occurrence that
  // shows a measure's segno/coda sign: where a followed jump lands, else its first pass.
  const followed = new Map<NavAction, Set<number>>()
  const signOcc = new Map<number, number>()
  input.navigation?.actions.forEach((a, k) => {
    const o = occurrences[k]
    if (!a || !o) return
    let set = followed.get(a)
    if (!set) followed.set(a, (set = new Set()))
    set.add(o.sourceMeasure)
    const landing = occurrences[k + 1]
    if (a !== 'fine' && landing && !signOcc.has(landing.sourceMeasure))
      signOcc.set(landing.sourceMeasure, landing.index)
  })
  for (const o of occurrences) if (!signOcc.has(o.sourceMeasure)) signOcc.set(o.sourceMeasure, o.index)
  /**
   * True when `c` is not shown at this occurrence: an instruction followed elsewhere, or a sign
   * only (one sign per measure: OSMD would pair repeated segnos into a repetition of its own).
   */
  const hideNavigation = (kinds: readonly NavAction[], o: MeasureOccurrence): boolean => {
    if (kinds.length === 0) return signOcc.get(o.sourceMeasure) !== o.index
    const action = input.navigation?.actions[o.index]
    return kinds.some((k) => followed.get(k)?.has(o.sourceMeasure) === true && action !== k)
  }
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n']
  const selected = new Set(parts.map((p) => p.id))
  const header: XmlNode[] = []
  for (const c of elements(root)) if (HEADER_KEEP.has(c.name)) header.push(c)
  const pl = filteredPartList(root, selected)
  if (pl) header.push(pl)

  out.push('<score-partwise')
  for (const a in root.attrs) out.push(' ', a, '="', root.attrs[a] ?? '', '"')
  out.push('>')
  for (const h of header) if (isElement(h)) serializeElement(h, out)

  for (const part of parts) {
    const ctx = partContext(part)
    const measureEls = childrenNamed(part.el, 'measure')
    // Octave shifts are re-written from the performed spans (same type/size/number and source
    // attributes) and anchored to notes so OSMD reads the intended scope (see placeShifts).
    const inserts = new Map<number, ShiftPlacement[]>()
    const insertAt = (occ: number, placement: ShiftPlacement) => {
      let list = inserts.get(occ)
      if (!list) inserts.set(occ, (list = []))
      list.push(placement)
    }
    const allShiftEls = new Set<XmlElement>()
    for (const o of ottavas) {
      if (o.source.partId !== part.id) continue
      allShiftEls.add(o.source.startEl)
      if (o.source.stopEl) allShiftEls.add(o.source.stopEl)
      const startOcc = occurrences[o.startOcc]!
      const endOcc = occurrences[o.endOcc]!
      const staffNumber = o.source.staffNumber
      const number = o.source.number
      insertAt(o.startOcc, {
        node: octaveShiftDirection(o, 'start'),
        kind: 'start',
        number,
        offset: sub(o.start, startOcc.start),
        staffNumber,
      })
      insertAt(o.endOcc, {
        node: octaveShiftDirection(o, 'stop'),
        kind: 'stop',
        number,
        offset: sub(o.end, endOcc.start),
        staffNumber,
      })
    }

    out.push('<part id="', part.id.replace(/"/g, '&quot;'), '">')
    for (const o of occurrences) {
      const src = measureEls[o.sourceMeasure]
      const attrs: Record<string, string> = { ...(src?.attrs ?? {}), number: String(o.index + 1) }
      delete attrs['width']
      const body: XmlNode[] = []
      let leading: XmlElement | undefined
      let leadingDone = false
      for (const c of src?.children ?? []) {
        if (!isElement(c)) continue
        if (c.name === 'print') continue
        if (c.name === 'barline') {
          if (keepBarline(c)) body.push(c)
          continue
        }
        if (c.name === 'attributes') {
          const cleaned = cleanAttributes(c)
          if (!cleaned) continue
          if (!leadingDone && !leading) {
            leading = cleaned
            leadingDone = true
            continue
          }
          body.push(cleaned)
          continue
        }
        if (c.name === 'note' || c.name === 'backup' || c.name === 'forward' || c.name === 'direction')
          leadingDone = true
        let d: XmlElement | null = c
        const nav = input.navigation?.elements.get(c)
        if (nav) d = displayNavigation(c, hideNavigation(nav, o), nav.length > 0)
        else if (c.name === 'sound') d = stripNavSound(c)
        if (
          d &&
          d.name === 'direction' &&
          elements(d).some((dt) => dt.name === 'direction-type' && elements(dt).some((x) => allShiftEls.has(x)))
        ) {
          d = filterShifts(d, (x) => !allShiftEls.has(x))
        }
        if (d) body.push(d)
      }
      const restated =
        o.index > 0 && occurrences[o.index - 1]!.sourceMeasure + 1 !== o.sourceMeasure
          ? jumpAttributes(ctx, occurrences[o.index - 1]!.sourceMeasure, o.sourceMeasure)
          : []
      const children: XmlNode[] = []
      if (restated.length > 0 || leading)
        children.push(restated.length > 0 ? mergeAttributes(leading, restated) : leading!)
      if (!src) {
        const divisions = ctx.divisions.at(o.sourceMeasure, ZERO)?.value ?? ONE
        const duration = decimal(wholeToDivisions(measures[o.sourceMeasure]?.duration ?? o.duration, divisions))
        for (let s = 1; s <= part.staffCount; s++) {
          if (s > 1) children.push(el('backup', {}, [textEl('duration', duration)]))
          children.push(
            el('note', {}, [
              el('rest', { measure: 'yes' }),
              textEl('duration', duration),
              textEl('voice', s),
              textEl('staff', s),
            ]),
          )
        }
      }
      const bodyStart = children.length > 0 && isElement(children[0]!) && children[0].name === 'attributes' ? 1 : 0
      children.push(...body)
      const ins = inserts.get(o.index)
      const content = ins
        ? placeShifts(children, ins, ctx.divisions.beforeMeasure(o.sourceMeasure)?.value ?? ONE, bodyStart)
        : children
      serializeElement(el('measure', attrs, content), out)
    }
    out.push('</part>')
  }
  out.push('</score-partwise>\n')
  return out.join('')
}

/** A copy of a direction without the octave-shift elements `keepShift` rejects (null if nothing remains). */
function filterShifts(direction: XmlElement, keepShift: (x: XmlElement) => boolean): XmlElement | null {
  const children: XmlNode[] = []
  let types = 0
  for (const c of direction.children) {
    if (isElement(c) && c.name === 'direction-type') {
      const inner = c.children.filter((x) => !(isElement(x) && x.name === 'octave-shift' && !keepShift(x)))
      if (inner.some(isElement)) {
        children.push({ ...c, children: inner })
        types++
      }
      continue
    }
    children.push(c)
  }
  return types > 0 ? { ...direction, children } : null
}
