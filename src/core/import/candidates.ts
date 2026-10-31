/**
 * Candidates offered after opening a file (spec: "If an import contains several scores or
 * movements, let the user select one"): one per score document, with its parts (id, name,
 * staves) so the user can pick the piano part(s) — one two-staff part, or two one-staff parts
 * (right hand on top).
 */
import type { DiagnosticSink } from './diagnostics'
import { ImportError } from './errors'
import type { SourceDocument } from './source'
import { attr, child, childrenNamed, childText, elements, textOf, toInt, type XmlElement } from './xml'

export interface PartInfo {
  readonly id: string
  readonly name: string
  readonly abbreviation?: string
  readonly instrument?: string
  readonly midiProgram?: number
}

export interface CandidatePart extends PartInfo {
  readonly staves: number
  readonly measures: number
  /** Pitched notes in the part. */
  readonly notes: number
  /** Name, instrument or MIDI program suggests a keyboard instrument. */
  readonly pianoLike: boolean
}

export interface ImportCandidate {
  /** Pass back as `ImportSelection.candidate`. */
  readonly id: string
  /** Archive entry for compressed files. */
  readonly entry?: string
  readonly title: string
  readonly subtitle?: string
  readonly movementTitle?: string
  readonly composer?: string
  readonly arranger?: string
  readonly musicXmlVersion: string
  readonly originalRoot: 'score-partwise' | 'score-timewise'
  readonly parts: readonly CandidatePart[]
  readonly measures: number
  /** Proposed piano selection (part ids, top to bottom); empty when nothing fits. */
  readonly suggestedParts: readonly string[]
}

export interface ScoreTitles {
  readonly title: string
  readonly subtitle?: string
  readonly movementTitle?: string
  readonly composer?: string
  readonly arranger?: string
}

const PIANO_NAME =
  /piano|pianoforte|fortepiano|klavier|clavier|keyboard|harpsichord|cembalo|celesta|\bpf\b|\bpno\b|\bkbd\b/i

/** Part names and instruments from `<part-list>`. */
export function partList(root: XmlElement): Map<string, PartInfo> {
  const out = new Map<string, PartInfo>()
  const list = child(root, 'part-list')
  if (!list) return out
  for (const sp of childrenNamed(list, 'score-part')) {
    const id = attr(sp, 'id')
    if (!id) continue
    const info: { -readonly [K in keyof PartInfo]: PartInfo[K] } = { id, name: '' }
    const name = childText(sp, 'part-name') ?? ''
    const abbreviation = childText(sp, 'part-abbreviation')
    const instrument = child(sp, 'score-instrument')
    const instrumentName = instrument ? childText(instrument, 'instrument-name') : undefined
    const midi = child(sp, 'midi-instrument')
    const program = midi ? toInt(childText(midi, 'midi-program')) : undefined
    info.name = name || instrumentName || abbreviation || id
    if (abbreviation) info.abbreviation = abbreviation
    if (instrumentName) info.instrument = instrumentName
    if (program !== undefined) info.midiProgram = program
    out.set(id, info)
  }
  return out
}

export function scoreTitles(root: XmlElement, fallback: string): ScoreTitles {
  const work = child(root, 'work')
  const workTitle = work ? childText(work, 'work-title') : undefined
  const movementTitle = childText(root, 'movement-title')
  let creditTitle: string | undefined
  let subtitle: string | undefined
  for (const credit of childrenNamed(root, 'credit')) {
    const type = childText(credit, 'credit-type')
    const words = childrenNamed(credit, 'credit-words')
      .map((w) => textOf(w))
      .join(' ')
      .trim()
    if (!words) continue
    if (type === 'title' && !creditTitle) creditTitle = words
    if (type === 'subtitle' && !subtitle) subtitle = words
  }
  let composer: string | undefined
  let arranger: string | undefined
  const ident = child(root, 'identification')
  if (ident) {
    for (const c of childrenNamed(ident, 'creator')) {
      const type = attr(c, 'type')
      if (type === 'composer' && !composer) composer = textOf(c) || undefined
      if (type === 'arranger' && !arranger) arranger = textOf(c) || undefined
    }
  }
  const out: { -readonly [K in keyof ScoreTitles]: ScoreTitles[K] } = {
    title: workTitle || creditTitle || movementTitle || fallback,
  }
  if (subtitle) out.subtitle = subtitle
  if (movementTitle && movementTitle !== out.title) out.movementTitle = movementTitle
  if (composer) out.composer = composer
  if (arranger) out.arranger = arranger
  return out
}

function scanPart(part: XmlElement): { staves: number; measures: number; notes: number } {
  let staves = 1
  let notes = 0
  const measures = childrenNamed(part, 'measure')
  for (const m of measures) {
    for (const c of elements(m)) {
      if (c.name === 'note') {
        if (child(c, 'pitch')) notes++
      } else if (c.name === 'attributes') {
        const s = toInt(childText(c, 'staves'))
        if (s !== undefined && s > staves) staves = s
      }
    }
  }
  return { staves, measures: measures.length, notes }
}

function isPianoLike(info: PartInfo): boolean {
  if (PIANO_NAME.test(info.name) || (info.instrument !== undefined && PIANO_NAME.test(info.instrument))) return true
  return info.midiProgram !== undefined && info.midiProgram >= 1 && info.midiProgram <= 8
}

/** Proposed selection: a piano-like two-staff part, any two-staff part, or two adjacent one-staff parts. */
export function suggestParts(parts: readonly CandidatePart[]): string[] {
  const playable = parts.filter((p) => p.notes > 0)
  const twoStaff = playable.filter((p) => p.staves === 2)
  const piano2 = twoStaff.find((p) => p.pianoLike) ?? twoStaff[0]
  if (piano2) return [piano2.id]
  for (let i = 0; i + 1 < playable.length; i++) {
    const a = playable[i]!
    const b = playable[i + 1]!
    if (a.staves === 1 && b.staves === 1 && a.pianoLike && b.pianoLike) return [a.id, b.id]
  }
  const single = playable.find((p) => p.staves === 1 && p.pianoLike) ?? playable.find((p) => p.staves === 1)
  return single ? [single.id] : []
}

export function describeDocument(doc: SourceDocument, fallbackTitle: string, diag: DiagnosticSink): ImportCandidate {
  const info = partList(doc.root)
  const partEls = childrenNamed(doc.root, 'part')
  if (partEls.length === 0) {
    throw new ImportError('score-structure', `${doc.entry ? `“${doc.entry}”` : 'The score'} contains no parts.`)
  }
  const parts: CandidatePart[] = []
  let measures = 0
  for (const el of partEls) {
    const id = attr(el, 'id') ?? ''
    let pi = info.get(id)
    if (!pi) {
      diag.warn('part-list-mismatch', `Part “${id}” is not listed in the score’s part list.`)
      pi = { id, name: id }
    }
    const scan = scanPart(el)
    measures = Math.max(measures, scan.measures)
    parts.push({ ...pi, ...scan, pianoLike: isPianoLike(pi) })
  }
  for (const id of info.keys()) {
    if (!partEls.some((p) => attr(p, 'id') === id))
      diag.warn('part-list-mismatch', `Part “${id}” is listed but has no music.`)
  }
  const titles = scoreTitles(doc.root, fallbackTitle)
  const c: { -readonly [K in keyof ImportCandidate]: ImportCandidate[K] } = {
    id: doc.id,
    ...titles,
    musicXmlVersion: doc.musicXmlVersion,
    originalRoot: doc.originalRoot,
    parts,
    measures,
    suggestedParts: suggestParts(parts),
  }
  if (doc.entry !== undefined) c.entry = doc.entry
  return c
}

/**
 * Validate a part selection: one part with one or two staves, or two one-staff parts. Returns the
 * ids in score order (top to bottom), or throws `selection-invalid` with a readable reason.
 */
export function validateSelection(parts: readonly CandidatePart[], partIds: readonly string[]): string[] {
  const unique = [...new Set(partIds)]
  if (unique.length === 0) throw new ImportError('selection-invalid', 'Choose the piano part to practice.')
  const chosen = unique.map((id) => {
    const p = parts.find((x) => x.id === id)
    if (!p) throw new ImportError('selection-invalid', `The score has no part “${id}”.`)
    return p
  })
  if (chosen.length > 2)
    throw new ImportError(
      'selection-invalid',
      'Choose one two-staff piano part, or two one-staff parts (right hand, then left hand).',
    )
  if (chosen.length === 2 && chosen.some((p) => p.staves !== 1)) {
    throw new ImportError(
      'selection-invalid',
      'Two parts can be combined only when each has a single staff (right hand above, left hand below).',
    )
  }
  if (chosen.length === 1 && chosen[0]!.staves > 2) {
    throw new ImportError(
      'selection-invalid',
      `“${chosen[0]!.name}” has ${chosen[0]!.staves} staves; only one- or two-staff piano parts are supported.`,
    )
  }
  if (chosen.every((p) => p.notes === 0))
    throw new ImportError('selection-invalid', 'The chosen part has no notes to practice.')
  return parts.filter((p) => unique.includes(p.id)).map((p) => p.id)
}
