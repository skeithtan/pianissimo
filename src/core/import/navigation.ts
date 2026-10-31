/**
 * D.C. / D.S. / To Coda / Fine (spec "Unfold written repeats into a linear performance order";
 * DECISIONS I4). Marks are read from `<sound>` attributes (dacapo, dalsegno, tocoda, coda, segno,
 * fine), from `<segno/>` / `<coda/>` signs and from the common words ("D.S. al Coda", "To Coda",
 * "Fine", "Coda"), then resolved per bar into a `NavigationPlan` that `unfoldRepeats` follows.
 *
 * Conventions (bar granularity, like repeats):
 *  - D.C., D.S., To Coda and Fine act at the *end* of the bar that carries them; a segno or coda
 *    sign marks the *start* of its bar (of the next bar when written at the bar's end or on a
 *    right-hand barline).
 *  - Each jump is taken once. After it, Fine ends the performance ("al Fine") and To Coda goes
 *    to the coda ("al Coda"); neither acts before a jump. Without "al Fine"/"al Coda" the mode is
 *    inferred: a To Coda between target and jump → al Coda, else a Fine → al Fine, else to the end.
 *  - After a jump, repeats and endings already played are not taken again (the last ending is
 *    played) unless the words ask for them ("con repetizione", "with repeats").
 *  - D.S. targets the segno whose token matches, else the only segno, else the last one before
 *    the jump. The coda is the first coda sign after the To Coda bar (token match preferred).
 * Genuinely ambiguous cases are not followed and their bars stay `unsupported-repeat`: a D.S.
 * without a segno, "al Fine" without a Fine, "al Coda" without a To Coda or coda sign, D.C. and
 * D.S. in one bar, a jump inside a repeated section (before its backward repeat), and a To Coda
 * no followed jump uses.
 */
import type { SourceMeasure } from '../model/score'
import { type Rational, ge } from '../music/rational'
import type { NavKind, RawBarlines, RawNavMark } from './read/types'
import type { XmlElement } from './xml'

export interface NavJump {
  readonly kind: 'dc' | 'ds'
  /** Source measure the performance continues at. */
  readonly target: number
  /** What ends the passage after the jump. */
  readonly mode: 'fine' | 'coda' | 'end'
  /** Repeats already played are taken again after the jump ("con repetizione"). */
  readonly withRepeats: boolean
  /** Printed instruction ("D.S. al Coda"), for diagnostics. */
  readonly text: string
}

export interface NavigationPlan {
  /** Jump taken at the end of a source measure (the first time it is reached). */
  readonly jumps: ReadonlyMap<number, NavJump>
  /** Source measures whose end is a Fine (acts after an "al Fine" jump). */
  readonly fine: ReadonlySet<number>
  /** To Coda bar → first bar of the coda (acts after an "al Coda" jump). */
  readonly toCoda: ReadonlyMap<number, number>
}

export const NO_NAVIGATION: NavigationPlan = { jumps: new Map(), fine: new Set(), toCoda: new Map() }

/** What happens at the end of one occurrence because of a navigation mark. */
export type NavAction = 'jump' | 'to-coda' | 'fine'

export interface NavigationResult {
  readonly plan: NavigationPlan
  /** Bars whose instruction is not followed (→ `unsupported-repeat`), with the reason. */
  readonly unsupported: readonly { readonly m: number; readonly detail: string }[]
  /**
   * Every source `<direction>` / measure-level `<sound>` carrying a navigation mark, with the
   * instructions it holds (empty for a segno/coda sign or a "Coda" heading). Render XML.
   */
  readonly elements: ReadonlyMap<XmlElement, readonly NavAction[]>
}

export interface NavWords {
  readonly kinds: readonly NavKind[]
  readonly alFine: boolean
  readonly alCoda: boolean
  readonly withRepeats: boolean
}

const SEGNO_GLYPHS = /[\u{1D10B}]/gu
const CODA_GLYPHS = /[\u{1D10C}\u{1D10D}]/gu
const DC = /(?:^|[\s(])(?:d\.?\s?c\.?|da\s+capo)(?=$|[\s.,;:)])/
const DS = /(?:^|[\s(])(?:d\.?\s?s\.?|dal\s+segno)(?=$|[\s.,;:)])/
const TO_CODA = /(?:^|\s)to\s+(?:the\s+)?coda\b/
const AL_FINE = /\bal\s+fine\b/
const AL_CODA = /\b(?:al\s+coda|e\s+poi\s+(?:la\s+)?coda)\b/
const WITH_REPEATS = /\b(?:con\s+rep|with\s+repeats?\b)/

/** Classify direction words; unrelated text yields no kinds. */
export function classifyNavWords(text: string): NavWords {
  const t = text
    .toLowerCase()
    .replace(SEGNO_GLYPHS, ' segno ')
    .replace(CODA_GLYPHS, ' coda ')
    .replace(/\s+/g, ' ')
    .trim()
  const kinds: NavKind[] = []
  const dc = DC.test(t)
  const ds = DS.test(t)
  if (dc) kinds.push('dacapo')
  if (ds) kinds.push('dalsegno')
  if (!dc && !ds) {
    if (TO_CODA.test(t)) kinds.push('tocoda')
    else if (/^fine\.?$/.test(t)) kinds.push('fine')
    else if (/^(?:coda\s*)+\.?$/.test(t)) kinds.push('coda')
    else if (/^(?:segno\s*)+$/.test(t)) kinds.push('segno')
  }
  return { kinds, alFine: AL_FINE.test(t), alCoda: AL_CODA.test(t), withRepeats: WITH_REPEATS.test(t) }
}

const INSTRUCTION: Readonly<Partial<Record<NavKind, NavAction>>> = {
  dacapo: 'jump',
  dalsegno: 'jump',
  tocoda: 'to-coda',
  fine: 'fine',
}

/** True when `kind` is an instruction (acts at a bar's end) rather than a target sign. */
export function isInstruction(kind: NavKind): boolean {
  return INSTRUCTION[kind] !== undefined
}

interface BarMarks {
  tokens: Set<string>
  text: string
}

function addMark(map: Map<number, BarMarks>, bar: number, mark: RawNavMark): void {
  let e = map.get(bar)
  if (!e) map.set(bar, (e = { tokens: new Set(), text: '' }))
  if (mark.token) e.tokens.add(mark.token)
  if (!e.text && mark.text) e.text = mark.text
}

const sortedBars = (map: ReadonlyMap<number, unknown>): number[] => [...map.keys()].sort((a, b) => a - b)

function matching(
  candidates: readonly number[],
  marks: ReadonlyMap<number, BarMarks>,
  tokens: ReadonlySet<string>,
): number[] {
  if (tokens.size === 0) return [...candidates]
  const hit = candidates.filter((b) => [...(marks.get(b)?.tokens ?? [])].some((t) => tokens.has(t)))
  return hit.length > 0 ? hit : [...candidates]
}

/**
 * True when bar `j` lies inside a repeated section before its backward repeat or before a later
 * ending of its group, so the jump would cut a repeat short (ambiguous).
 */
function insideRepeat(barlines: readonly RawBarlines[], j: number): boolean {
  if (barlines[j]?.backwardRepeat) return false
  let inEnding = false
  for (let k = 0; k <= j; k++) {
    if (barlines[k]?.endingStart) inEnding = true
    if (k < j && barlines[k]?.endingStop) inEnding = false
  }
  const n = barlines.length
  if (inEnding) {
    let k = j
    while (k < n - 1 && !barlines[k]!.endingStop) {
      k++
      if (barlines[k]!.backwardRepeat || barlines[k]!.endingStart) return true
    }
    return k + 1 < n && barlines[k + 1]!.endingStart !== undefined
  }
  for (let k = j + 1; k < n; k++) {
    const b = barlines[k]!
    if (b.forwardRepeat) return false
    if (b.endingStart || b.backwardRepeat) return true
  }
  return false
}

/** Resolve the marks of all parts into a plan (see module doc). */
export function resolveNavigation(
  marks: readonly RawNavMark[],
  barlines: readonly RawBarlines[],
  measures: readonly Pick<SourceMeasure, 'duration'>[],
): NavigationResult {
  const n = measures.length
  const segnos = new Map<number, BarMarks>()
  const codas = new Map<number, BarMarks>()
  const toCodas = new Map<number, BarMarks>()
  const fines = new Set<number>()
  const dcs = new Map<number, BarMarks>()
  const dss = new Map<number, BarMarks>()
  const elements = new Map<XmlElement, NavAction[]>()
  const atEnd = (m: number, at: Rational) => ge(at, measures[m]?.duration ?? at)

  for (const mark of marks) {
    if (mark.m < 0 || mark.m >= n) continue
    const action = INSTRUCTION[mark.kind]
    if (mark.el) {
      let list = elements.get(mark.el)
      if (!list) elements.set(mark.el, (list = []))
      if (action && !list.includes(action)) list.push(action)
    }
    switch (mark.kind) {
      case 'segno':
      case 'coda': {
        const bar = mark.endOfBar || atEnd(mark.m, mark.at) ? mark.m + 1 : mark.m
        if (bar < n) addMark(mark.kind === 'segno' ? segnos : codas, bar, mark)
        break
      }
      case 'tocoda':
        addMark(toCodas, mark.m, mark)
        break
      case 'fine':
        fines.add(mark.m)
        break
      case 'dacapo':
        addMark(dcs, mark.m, mark)
        break
      case 'dalsegno':
        addMark(dss, mark.m, mark)
        break
    }
  }

  const jumps = new Map<number, NavJump>()
  const toCoda = new Map<number, number>()
  const unsupported: { m: number; detail: string }[] = []
  const segnoBars = sortedBars(segnos)
  const codaBars = sortedBars(codas)
  const toCodaBars = sortedBars(toCodas)
  const fineBars = [...fines].sort((a, b) => a - b)

  for (const j of [...new Set([...dcs.keys(), ...dss.keys()])].sort((a, b) => a - b)) {
    const dc = dcs.get(j)
    const ds = dss.get(j)
    const text = dc?.text || ds?.text || (ds ? 'D.S.' : 'D.C.')
    const refuse = (reason: string) => unsupported.push({ m: j, detail: `${text}: ${reason}` })
    if (dc && ds) {
      refuse('D.C. and D.S. in one bar')
      continue
    }
    let target = 0
    if (ds) {
      const before = matching(segnoBars, segnos, ds.tokens).filter((b) => b <= j)
      const found = before.at(-1)
      if (found === undefined) {
        refuse('no segno before it')
        continue
      }
      target = found
    }
    const words = classifyNavWords(text)
    const toCodaBar = toCodaBars.find((b) => b >= target && b <= j)
    const mode: NavJump['mode'] = words.alFine
      ? 'fine'
      : words.alCoda
        ? 'coda'
        : toCodaBar !== undefined
          ? 'coda'
          : fineBars.some((b) => b >= target)
            ? 'fine'
            : 'end'
    if (mode === 'fine' && !fineBars.some((b) => b >= target)) {
      refuse('no Fine after the jump target')
      continue
    }
    let codaBar: number | undefined
    if (mode === 'coda') {
      if (toCodaBar === undefined) {
        refuse('no To Coda between the jump target and the jump')
        continue
      }
      codaBar = matching(
        codaBars.filter((b) => b > toCodaBar),
        codas,
        toCodas.get(toCodaBar)!.tokens,
      )[0]
      if (codaBar === undefined) {
        refuse('no coda sign after the To Coda')
        continue
      }
    }
    if (insideRepeat(barlines, j)) {
      refuse('inside a repeated section')
      continue
    }
    jumps.set(j, { kind: ds ? 'ds' : 'dc', target, mode, withRepeats: words.withRepeats, text })
    if (toCodaBar !== undefined && codaBar !== undefined) toCoda.set(toCodaBar, codaBar)
  }
  for (const b of toCodaBars) {
    if (!toCoda.has(b))
      unsupported.push({ m: b, detail: `${toCodas.get(b)!.text || 'To Coda'}: no D.C. or D.S. al Coda leads to it` })
  }
  return { plan: { jumps, fine: fines, toCoda }, unsupported, elements }
}
