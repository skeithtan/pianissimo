/**
 * Import summary (spec "MusicXML score import": show the selected piano parts, hand
 * assignments, numerical tempo and any missing or unsupported information, and check pitches,
 * ottavas and their scope, durations, chords, ties, tuplets, staves and voices, repeats and
 * tempo changes before enabling scored practice). Pure data for the Library view.
 */
import { cmp, key } from '../music/rational'
import { type Rational } from '../music/rational'
import { beatUnitName, hasTempo } from '../music/tempo'
import type { Diagnostic, Hand, ScoreModel, TimingIssue, UnsupportedRegion, VoiceKey } from '../model/score'
import { homeStaff, isCrossStaff, voiceKey } from './hands'
import { isDyadic } from './read/values'

export interface SummaryVoice {
  readonly key: VoiceKey
  readonly partId: string
  readonly partName: string
  readonly voice: string
  readonly hand: Hand
  /** Note counts per global staff. */
  readonly notesPerStaff: Readonly<Record<number, number>>
  /** The staff holding most of the voice's notes; its hand is the proposal (M2). */
  readonly homeStaff: number
  /** Printed bar numbers where the voice has notes written on another staff (cross-staff). */
  readonly crossStaffBars: readonly string[]
  /** Genuinely split between the staves: needs the user's choice (M2). */
  readonly ambiguous: boolean
}

export interface SummaryOttava {
  readonly index: number
  readonly staff: number
  /** "8va", "8vb", "15ma" or "15mb". */
  readonly label: string
  readonly fromBar: string
  readonly toBar: string
  readonly notes: number
}

export interface SummaryRoll {
  readonly index: number
  readonly bar: string
  readonly direction: 'up' | 'down'
  readonly directionDefaulted: boolean
  readonly crossStaff: boolean
  readonly pitches: number
  /** Reference spread in milliseconds at 1× (0 until a tempo is known). */
  readonly spreadMs: number
}

export interface SummaryTempo {
  readonly present: boolean
  readonly segments: number
  /** Tempo at the start: displayed beat unit name, BPM, and quarter-note BPM. */
  readonly initial?: {
    readonly beatUnit: Rational
    readonly beatUnitName: string
    readonly beatBpm: number
    readonly quarterBpm: number
  }
  readonly minQuarterBpm?: number
  readonly maxQuarterBpm?: number
  readonly sources: readonly string[]
  readonly conflicts: number
}

export interface ImportSummary {
  readonly title: string
  readonly composer?: string
  readonly parts: readonly { readonly id: string; readonly name: string; readonly staffCount: number }[]
  readonly counts: {
    readonly measures: number
    readonly occurrences: number
    readonly sourceNotes: number
    readonly performedNotes: number
    /** Onsets where one voice attacks several pitches together. */
    readonly chords: number
    readonly tiedContinuations: number
    /** Source notes with a tuplet (non-binary) duration. */
    readonly tupletNotes: number
    readonly graceNotes: number
    /** Source notes marked `<cue/>`: engraved, never performed (I13). */
    readonly cueNotes: number
    readonly voices: number
    readonly staves: number
    readonly pedalMarks: number
    readonly dynamicMarks: number
  }
  readonly voices: readonly SummaryVoice[]
  readonly handsConfirmed: boolean
  readonly ottavas: readonly SummaryOttava[]
  readonly rolls: readonly SummaryRoll[]
  readonly repeats: {
    readonly unfolded: boolean
    /** Bars played more than once, with their pass count. */
    readonly repeatedBars: readonly { readonly bar: string; readonly passes: number }[]
    readonly endings: readonly string[]
  }
  readonly tempo: SummaryTempo
  readonly changes: { readonly keys: number; readonly meters: number; readonly clefs: number }
  readonly unsupported: readonly (UnsupportedRegion & { readonly bars: string })[]
  readonly timingIssues: readonly (TimingIssue & { readonly bar: string })[]
  readonly diagnostics: {
    readonly errors: number
    readonly warnings: number
    readonly infos: number
    readonly list: readonly Diagnostic[]
  }
  readonly readiness: {
    readonly tempo: boolean
    readonly hands: boolean
    /** Scored practice can start (tempo known, hands confirmed, no import errors). */
    readonly scoredPractice: boolean
    /** What the user must still do, in plain words. */
    readonly blockers: readonly string[]
  }
}

function barLabel(model: ScoreModel, occ: number): string {
  const o = model.occurrences[occ]
  if (!o) return String(occ + 1)
  return o.pass > 1 ? `${o.number} (pass ${o.pass})` : o.number
}

function ottavaLabel(size: number, sounds: 'up' | 'down'): string {
  return size === 15 ? (sounds === 'up' ? '15ma' : '15mb') : sounds === 'up' ? '8va' : '8vb'
}

export function summarizeImport(model: ScoreModel): ImportSummary {
  const partName = new Map(model.parts.map((p) => [p.id, p.name] as const))
  const ambiguous = new Set(model.hands.ambiguousVoices)
  const voices: SummaryVoice[] = model.voices.map((v) => {
    const home = homeStaff(v)
    const bars = new Set<string>()
    if (isCrossStaff(v)) {
      for (const n of model.sourceNotes) {
        if (n.staff === home || voiceKey(n.partId, n.voice) !== v.key) continue
        bars.add(model.sourceMeasures[n.measure]?.number ?? String(n.measure + 1))
      }
    }
    return {
      key: v.key,
      partId: v.partId,
      partName: partName.get(v.partId) ?? v.partId,
      voice: v.voice,
      hand: model.hands.byVoice[v.key] ?? 'R',
      notesPerStaff: v.notesPerStaff,
      homeStaff: home,
      crossStaffBars: [...bars],
      ambiguous: ambiguous.has(v.key),
    }
  })

  const chordKeys = new Map<string, Set<number>>()
  for (const n of model.notes) {
    if (n.grace) continue
    const k = `${n.occ}|${key(n.onset)}|${n.partId}|${n.voice}`
    let s = chordKeys.get(k)
    if (!s) chordKeys.set(k, (s = new Set()))
    s.add(n.midi)
  }
  let chords = 0
  for (const s of chordKeys.values()) if (s.size > 1) chords++

  const passes = new Map<string, number>()
  for (const o of model.occurrences) if (o.pass > 1) passes.set(o.number, Math.max(passes.get(o.number) ?? 1, o.pass))
  const endings = [...new Set(model.occurrences.flatMap((o) => (o.endingNumber !== undefined ? [o.endingNumber] : [])))]

  const segs = model.tempo.segments
  const first = segs[0]
  const quarter = segs.map((s) => s.quarterBpm)
  const tempo: SummaryTempo = {
    present: hasTempo(model.tempo),
    segments: segs.length,
    ...(first
      ? {
          initial: {
            beatUnit: first.beatUnit,
            beatUnitName: beatUnitName(first.beatUnit),
            beatBpm: first.beatBpm,
            quarterBpm: first.quarterBpm,
          },
          minQuarterBpm: Math.min(...quarter),
          maxQuarterBpm: Math.max(...quarter),
        }
      : {}),
    sources: [...new Set(segs.map((s) => s.source))],
    conflicts: model.diagnostics.filter((d) => d.code === 'tempo-conflict').length,
  }

  const errors = model.diagnostics.filter((d) => d.severity === 'error').length
  const handsOk = model.hands.confirmed || model.hands.ambiguousVoices.length === 0
  const blockers: string[] = []
  if (!tempo.present) blockers.push('Choose a practice tempo: the score has no numerical tempo.')
  if (!handsOk) {
    const names = voices.filter((v) => v.ambiguous).map((v) => `voice ${v.voice} of ${v.partName}`)
    blockers.push(`Choose which hand plays ${names.join(', ')}: its notes are split between the staves.`)
  }
  if (errors > 0) blockers.push('Fix or review the import errors listed below.')

  const summary: { -readonly [K in keyof ImportSummary]: ImportSummary[K] } = {
    title: model.meta.title,
    parts: model.parts.map((p) => ({ id: p.id, name: p.name, staffCount: p.staffCount })),
    counts: {
      measures: model.sourceMeasures.length,
      occurrences: model.occurrences.length,
      sourceNotes: model.sourceNotes.length,
      performedNotes: model.notes.length,
      chords,
      tiedContinuations: model.notes.filter((n) => n.tieContinuation).length,
      tupletNotes: model.sourceNotes.filter((n) => !n.grace && n.duration.n > 0 && !isDyadic(n.duration)).length,
      graceNotes: model.sourceNotes.filter((n) => n.grace).length,
      cueNotes: model.sourceNotes.filter((n) => n.cue).length,
      voices: model.voices.length,
      staves: model.staves.length,
      pedalMarks: model.pedals.length,
      dynamicMarks: model.dynamics.length,
    },
    voices,
    handsConfirmed: handsOk,
    ottavas: model.ottavas.map((o) => ({
      index: o.index,
      staff: o.staff,
      label: ottavaLabel(o.size, o.sounds),
      fromBar: barLabel(model, o.startOcc),
      toBar: barLabel(model, o.endOcc),
      notes: o.notes.length,
    })),
    rolls: model.arpeggios.map((g) => ({
      index: g.index,
      bar: barLabel(model, g.occ),
      direction: g.direction,
      directionDefaulted: g.directionDefaulted,
      crossStaff: g.crossStaff,
      pitches: new Set(g.notes.map((i) => model.notes[i]?.midi)).size,
      spreadMs: Math.round(g.spreadSec * 1000),
    })),
    repeats: {
      unfolded: model.occurrences.length !== model.sourceMeasures.length || passes.size > 0,
      repeatedBars: [...passes].map(([bar, p]) => ({ bar, passes: p })),
      endings,
    },
    tempo,
    changes: {
      keys: Math.max(0, model.keys.length - 1),
      meters: Math.max(0, model.meters.length - 1),
      clefs: Math.max(0, model.clefs.length - model.staves.length),
    },
    unsupported: model.unsupported.map((r) => ({
      ...r,
      bars:
        r.fromOcc === r.toOcc
          ? barLabel(model, r.fromOcc)
          : `${barLabel(model, r.fromOcc)}–${barLabel(model, r.toOcc)}`,
    })),
    timingIssues: [...model.timingIssues]
      .sort((a, b) => cmp(a.at, b.at))
      .map((t) => ({ ...t, bar: barLabel(model, t.occ) })),
    diagnostics: {
      errors,
      warnings: model.diagnostics.filter((d) => d.severity === 'warning').length,
      infos: model.diagnostics.filter((d) => d.severity === 'info').length,
      list: model.diagnostics,
    },
    readiness: {
      tempo: tempo.present,
      hands: handsOk,
      scoredPractice: tempo.present && handsOk && errors === 0,
      blockers,
    },
  }
  if (model.meta.composer !== undefined) summary.composer = model.meta.composer
  return summary
}
