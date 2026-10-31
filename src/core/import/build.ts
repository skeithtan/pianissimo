/**
 * ScoreModel assembly for one score document and part selection (spec "Common score model and
 * import pipeline"). Stages: read parts → skeleton → unfold repeats → ottava scope → source notes
 * → performed notes, ties, rolls → tempo map → hands → context maps → unsupported regions and
 * timing issues → render XML.
 */
import { ZERO, le, lt } from '../music/rational'
import {
  type Diagnostic,
  IMPORTER_VERSION,
  type OttavaSpan,
  type PartRef,
  type PerformedNote,
  ROLL_POLICY_VERSION,
  SCORE_PACKAGE_FORMAT,
  type ScoreMeta,
  type ScoreModel,
} from '../model/score'
import { describeDocument, validateSelection } from './candidates'
import { DiagnosticSink } from './diagnostics'
import { ImportError } from './errors'
import { clefEvents, dynamicMarks, keyEvents, meterEvents, pedalMarks } from './events'
import { collectVoices, homeStaff, isCrossStaff, proposeHands, voiceKey } from './hands'
import { type TimingMark, type UnsupportedMark, timingIssuesFor, unsupportedRegions, verbalTimingMarks } from './issues'
import type { ImportLimits } from './limits'
import { resolveNavigation } from './navigation'
import { buildOccurrences, occurrencesByMeasure } from './occurrences'
import { OttavaLookup, performOttavas, sourceOttavaSpans, type SourceOttava } from './ottava'
import { groupArpeggios, linkTies, performNotes } from './performance'
import { readPart } from './read/part'
import type { PartData, RawNavMark, RawSection, RawTempo, RawWords } from './read/types'
import { scoreSections } from './sections'
import { buildRenderXml } from './renderXml'
import { unfoldRepeats } from './repeats'
import { realizeRolls } from './rolls'
import { buildSkeleton } from './skeleton'
import type { Packaging, SourceDocument } from './source'
import { buildSourceNotes } from './sourceNotes'
import { buildTempoMap, resolveTempos } from './tempoMap'
import { attr, childrenNamed, type XmlElement } from './xml'

export interface BuildInput {
  readonly doc: SourceDocument
  readonly packaging: Packaging
  readonly fileName: string
  readonly partIds: readonly string[]
  readonly scoreVersionId: string
  readonly importedAt: number
  readonly limits: ImportLimits
  readonly diag: DiagnosticSink
  readonly progress?: (stage: string, fraction: number) => void
}

export interface BuiltScore {
  readonly model: ScoreModel
  readonly renderXml: string
}

export function buildScore(input: BuildInput): BuiltScore {
  const { doc, diag, limits } = input
  const progress = input.progress ?? (() => {})
  const candidate = describeDocument(doc, input.fileName.replace(/\.[^.]+$/, ''), diag)
  const partIds = validateSelection(candidate.parts, input.partIds)
  const infoById = new Map(candidate.parts.map((p) => [p.id, p] as const))

  progress('reading', 0.1)
  const selectedParts: { id: string; name: string; el: XmlElement; data: PartData }[] = []
  const tempos: RawTempo[] = []
  const words: RawWords[] = []
  // Navigation is score-wide: a D.S. written only in an unselected part still applies.
  const navigation: RawNavMark[] = []
  // Sections too: a rehearsal mark over another staff still names the bar.
  const sectionMarks: RawSection[] = []
  for (const el of childrenNamed(doc.root, 'part')) {
    const id = attr(el, 'id') ?? ''
    const name = infoById.get(id)?.name ?? id
    if (partIds.includes(id)) {
      const data = readPart(el, id, diag)
      selectedParts.push({ id, name, el, data })
      tempos.push(...data.tempos)
      words.push(...data.words)
      navigation.push(...data.navigation)
      sectionMarks.push(...data.sections)
    } else {
      const data = readPart(el, id, new DiagnosticSink(), { tempoOnly: true })
      tempos.push(...data.tempos)
      words.push(...data.words)
      navigation.push(...data.navigation)
      sectionMarks.push(...data.sections)
    }
  }

  progress('measures', 0.25)
  const skeleton = buildSkeleton(selectedParts, diag)
  if (skeleton.measures.length > limits.maxMeasures) {
    throw new ImportError(
      'score-too-large',
      `The score has ${skeleton.measures.length} bars; the import limit is ${limits.maxMeasures}.`,
    )
  }
  if (skeleton.measures.length === 0) throw new ImportError('score-structure', 'The selected part contains no bars.')
  const noteCount = selectedParts.reduce((a, p) => a + p.data.notes.length, 0)
  if (noteCount > limits.maxNotes) {
    throw new ImportError(
      'score-too-large',
      `The score has ${noteCount} notes; the import limit is ${limits.maxNotes}.`,
    )
  }
  const barOf = (m: number) => skeleton.measures[m]?.number ?? String(m + 1)

  progress('repeats', 0.35)
  const nav = resolveNavigation(navigation, skeleton.barlines, skeleton.measures)
  const unfolded = unfoldRepeats(
    skeleton.barlines,
    skeleton.measures.map((m) => m.number),
    limits.maxOccurrences,
    diag,
    nav.plan,
  )
  const { occurrences, total } = buildOccurrences(unfolded, skeleton.measures)
  const byMeasure = occurrencesByMeasure(occurrences, skeleton.measures.length)

  progress('notes', 0.45)
  const sourceSpans: SourceOttava[] = skeleton.parts.flatMap((p) =>
    sourceOttavaSpans(p.data.ottavas, p, skeleton.measures, diag),
  )
  const ottavaLookup = new OttavaLookup(sourceSpans)
  for (const [a, b] of ottavaLookup.overlaps()) {
    diag.warn(
      'ottava-overlap',
      `Two octave shifts overlap on one staff (bars ${barOf(a.start.m)} and ${barOf(b.start.m)}); the later one applies.`,
      {
        measure: barOf(b.start.m),
      },
    )
  }
  const src = buildSourceNotes(skeleton, ottavaLookup, diag)
  const notes = performNotes(src.notes, src.extras, occurrences, skeleton.measures.length)
  linkTies(notes, src.notes, barOf, diag)
  const arpeggios = groupArpeggios(notes, src.notes, barOf, diag)

  progress('tempo', 0.6)
  const resolved = resolveTempos(tempos, skeleton.measures, diag)
  const tempo = buildTempoMap(resolved, occurrences, skeleton.measures, diag)
  const rolls = realizeRolls(notes, arpeggios, tempo, (i) => src.raw[notes[i]!.src]?.attack)
  for (const n of notes) n.refOffsetSec = rolls.offsets[n.index] ?? 0
  for (const g of arpeggios) g.spreadSec = rolls.spreads[g.index] ?? 0

  progress('ottavas', 0.7)
  const performedOttavas = performOttavas(sourceSpans, occurrences, skeleton.measures)
  const ottavas: OttavaSpan[] = performedOttavas.map((o, index) => ({
    index,
    staff: o.source.staff,
    number: o.source.number,
    size: o.source.size,
    sounds: o.source.sounds,
    start: o.start,
    end: o.end,
    startOcc: o.startOcc,
    endOcc: o.endOcc,
    notes: [],
  }))
  {
    const byStaff = new Map<number, OttavaSpan[]>()
    for (const s of ottavas) {
      let l = byStaff.get(s.staff)
      if (!l) byStaff.set(s.staff, (l = []))
      l.push(s)
    }
    for (const n of notes) {
      if (n.ottavaShift === 0) continue
      const span = byStaff.get(n.staff)?.find((s) => le(s.start, n.onset) && lt(n.onset, s.end))
      if (span) {
        n.ottava = span.index
        ;(span.notes as number[]).push(n.index)
      }
    }
  }

  progress('hands', 0.75)
  const partRefs: PartRef[] = skeleton.parts.map((p) => ({ id: p.id, name: p.name, staffCount: p.staffCount }))
  const voices = collectVoices(src.notes)
  const hands = proposeHands(voices, partRefs, skeleton.staves)
  for (const n of notes) n.hand = hands.byVoice[voiceKey(n.partId, n.voice)] ?? n.hand
  const ambiguous = new Set(hands.ambiguousVoices)
  for (const def of voices) {
    if (!isCrossStaff(def)) continue
    const partName = infoById.get(def.partId)?.name ?? def.partId
    const hand = hands.byVoice[def.key] === 'L' ? 'left' : 'right'
    const home = homeStaff(def)
    const awayBars = new Set<string>()
    let away = 0
    for (const s of src.notes) {
      if (voiceKey(s.partId, s.voice) !== def.key || s.staff === home) continue
      awayBars.add(barOf(s.measure))
      away++
    }
    const bars = [...awayBars]
    const barList = `${bars.length === 1 ? 'bar' : 'bars'} ${bars.slice(0, 6).join(', ')}${bars.length > 6 ? ', …' : ''}`
    const where = bars[0] !== undefined ? { measure: bars[0] } : undefined
    if (ambiguous.has(def.key)) {
      diag.warn(
        'hand-ambiguous',
        `Voice ${def.voice} of “${partName}” has notes on both staves in similar numbers (${barList}), so the file does not say which hand plays it. Proposed: ${hand} hand. Choose the hand before scored practice.`,
        where,
      )
    } else {
      diag.info(
        'hand-cross-staff',
        `Voice ${def.voice} of “${partName}” is the ${hand} hand; ${away} of its notes ${away === 1 ? 'is' : 'are'} written on the other staff (${barList}).`,
        where,
      )
    }
  }

  progress('context', 0.8)
  const keys = keyEvents(skeleton, occurrences)
  const meters = meterEvents(skeleton, occurrences)
  const clefs = clefEvents(src.clefsByStaff, occurrences)
  const pedals = pedalMarks(skeleton, occurrences)
  const dynamics = dynamicMarks(skeleton, occurrences)

  const unsupportedMarks: UnsupportedMark[] = [...src.unsupported]
  for (const t of skeleton.times.items) {
    if (!t.senzaMisura) continue
    for (let m = t.m; m < skeleton.measures.length; m++) {
      const cur = skeleton.times.at(m, ZERO)
      if (cur !== t && m !== t.m) break
      unsupportedMarks.push({ m, kind: 'free-time', detail: '' })
    }
  }
  for (const u of nav.unsupported) unsupportedMarks.push({ m: u.m, kind: 'unsupported-repeat', detail: u.detail })
  const unsupported = unsupportedRegions(unsupportedMarks, occurrences, diag)

  const timingMarks: TimingMark[] = [...src.timing, ...verbalTimingMarks(words, resolved, skeleton.measures.length)]
  skeleton.barlines.forEach((b, m) => {
    if (b.fermata)
      timingMarks.push({
        m,
        at: b.fermata === 'left' ? ZERO : (skeleton.measures[m]?.duration ?? ZERO),
        kind: 'fermata',
        text: 'fermata',
      })
  })
  const timingIssues = timingIssuesFor(timingMarks, byMeasure, occurrences)

  progress('render', 0.85)
  const renderXml = buildRenderXml({
    root: doc.root,
    parts: skeleton.parts,
    occurrences,
    measures: skeleton.measures,
    ottavas: performedOttavas,
    navigation: { elements: nav.elements, actions: unfolded.map((u) => u.nav) },
  })

  const meta: { -readonly [K in keyof ScoreMeta]: ScoreMeta[K] } = {
    title: candidate.title,
    musicXmlVersion: doc.musicXmlVersion,
    packaging: input.packaging,
    sourceFileName: input.fileName,
    importerVersion: IMPORTER_VERSION,
    rollPolicyVersion: ROLL_POLICY_VERSION,
    importedAt: input.importedAt,
  }
  if (candidate.subtitle !== undefined) meta.subtitle = candidate.subtitle
  if (candidate.composer !== undefined) meta.composer = candidate.composer
  if (candidate.arranger !== undefined) meta.arranger = candidate.arranger
  if (candidate.movementTitle !== undefined) meta.movementTitle = candidate.movementTitle
  if (doc.entry !== undefined) meta.sourceEntry = doc.entry

  const diagnostics: Diagnostic[] = diag.list()
  const sections = scoreSections(sectionMarks, occurrences)
  const model: ScoreModel = {
    format: SCORE_PACKAGE_FORMAT,
    scoreVersionId: input.scoreVersionId,
    meta,
    parts: partRefs,
    staves: skeleton.staves,
    voices,
    hands,
    sourceMeasures: skeleton.measures,
    sourceNotes: src.notes,
    occurrences,
    notes: notes as PerformedNote[],
    tempo,
    keys,
    meters,
    clefs,
    ottavas,
    pedals,
    dynamics,
    arpeggios,
    unsupported,
    timingIssues,
    diagnostics,
    totalDuration: total,
    ...(sections.length > 0 ? { sections } : {}),
  }
  return { model, renderXml }
}
