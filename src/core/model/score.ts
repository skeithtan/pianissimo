/**
 * The common score model — the single authority shared by import, matching, hints,
 * labels, looping, playback, rendering and suggested practice (spec: "Common score model").
 *
 * Timelines:
 *  - *Source* positions: within a source measure (`onsetInMeasure`, whole notes).
 *  - *Performance* positions: from the start of the unfolded performance (repeats written
 *    out), in whole notes. Everything time-related at runtime uses performance positions.
 *
 * Identity (spec: keep these separate):
 *  - `SourceNote.id`      — one `<note>` element (document order, selected parts only).
 *  - `PerformedNote.id`   — one source note in one measure occurrence ("occ:src").
 *  - graphic ids          — owned by the renderer, mapped to `PerformedNote.index`.
 *
 * The model is plain JSON-serializable data (structured-clone safe) so it can cross the
 * worker boundary and be stored in IndexedDB.
 */
import type { Rational } from '../music/rational'
import type { Spelling, Step } from '../music/pitch'
import type { TempoMapData } from '../music/tempo'

export const SCORE_PACKAGE_FORMAT = 1
/**
 * Part of `scoreVersionId`. 0.2.0: D.C. / D.S. / Coda / Fine followed (performance order changed
 * for scores with jumps), `SourceNote.attack` kept.
 */
export const IMPORTER_VERSION = '0.3.0'
/** Bump when the reference roll realization changes; part of the comparison context. */
export const ROLL_POLICY_VERSION = 'roll-v1-120ms-half-interval'
/**
 * Bump when matching semantics change; part of the comparison context.
 * v2: remembered attacks plus an early-press grace (accompaniment gate and next group), named in
 * the id: 80 ms until 31 October 2026, then 120 ms.
 */
export const MATCHING_RULES_VERSION = 'match-v2-early-grace-120ms'

export type Hand = 'L' | 'R'
/** Which hands the learner plays. 'none' is Preview. */
export type HandSelection = 'both' | 'right' | 'left' | 'none'

/** Clef identity used for conditional label rules: sign + line (+ octave change), e.g. "G2", "F4", "C3", "G2-8". */
export type ClefKey = string

export interface ClefDef {
  readonly sign: 'G' | 'F' | 'C' | 'percussion' | 'TAB' | 'none'
  readonly line: number
  readonly octaveChange: number
}

export interface ScoreMeta {
  readonly title: string
  readonly subtitle?: string
  readonly composer?: string
  readonly arranger?: string
  readonly movementTitle?: string
  readonly musicXmlVersion: string
  readonly packaging: 'musicxml' | 'mxl' | 'xml'
  readonly sourceFileName: string
  /** For compressed files / opus: which internal score was chosen. */
  readonly sourceEntry?: string
  readonly importerVersion: string
  readonly rollPolicyVersion: string
  readonly importedAt: number
}

export interface PartRef {
  readonly id: string
  readonly name: string
  readonly staffCount: number
}

export interface StaffDef {
  /** Global staff index (0-based) across the selected parts, top to bottom. */
  readonly index: number
  readonly partId: string
  /** MusicXML `<staff>` number within its part (1-based). */
  readonly staffNumber: number
}

/** Voice key = `${partId}:${voice}`. Hands are assigned per voice, never by pitch or clef. */
export type VoiceKey = string

export interface VoiceDef {
  readonly key: VoiceKey
  readonly partId: string
  readonly voice: string
  /** Note counts per global staff index — shows cross-staff use. */
  readonly notesPerStaff: Readonly<Record<number, number>>
}

export interface HandAssignment {
  readonly byVoice: Readonly<Record<VoiceKey, Hand>>
  /** Voices whose assignment the importer could not establish unambiguously (e.g. cross-staff). */
  readonly ambiguousVoices: readonly VoiceKey[]
  /** True once the user confirmed the assignment in the import summary. */
  readonly confirmed: boolean
}

export interface SourceMeasure {
  readonly index: number
  /** Printed measure number attribute ("12", "12a", "0" for pickups). */
  readonly number: string
  readonly implicit: boolean
  /** Duration from the time signature. */
  readonly nominalDuration: Rational
  /** Duration actually filled (pickups and incomplete bars are shorter). */
  readonly duration: Rational
}

export interface MeasureOccurrence {
  /** Performance-order index. Also the index of this measure in `ScorePackage.renderXml`. */
  readonly index: number
  readonly sourceMeasure: number
  readonly number: string
  /** 1-based pass through this source measure (repeat occurrence), e.g. "bar 12, pass 2". */
  readonly pass: number
  readonly start: Rational
  readonly duration: Rational
  readonly endingNumber?: string
}

/**
 * Key signature + accidentals carried earlier in the same measure on the same staff, as a
 * reader would assume them *before* this note's own accidental. Keyed by written step+octave.
 * Used by naming to decide whether an accidental is redundant (never to compute pitch).
 */
export interface AccidentalContext {
  readonly keyFifths: number
  readonly carried: ReadonlyArray<readonly [step: Step, writtenOctave: number, alter: number]>
}

export interface SourceNote {
  readonly id: number
  readonly measure: number
  readonly partId: string
  readonly staff: number
  readonly staffNumber: number
  readonly voice: string
  readonly onsetInMeasure: Rational
  /** Sounding duration in whole notes (tuplets applied). 0 for grace notes. */
  readonly duration: Rational
  /** True sounding pitch (MusicXML `<pitch>`, transposition applied if any). */
  readonly sounding: Spelling
  /** As engraved (sounding shifted back by the active ottava). */
  readonly written: Spelling
  readonly midi: number
  /** Octaves sounding minus written: +1 for 8va, +2 for 15ma, -1 for 8vb, -2 for 15mb. */
  readonly ottavaShift: number
  readonly chord: boolean
  readonly tieStart: boolean
  readonly tieStop: boolean
  readonly grace: boolean
  readonly cue: boolean
  /** Printed accidental glyph, if any ("sharp", "natural", "flat-flat", …). Informational only. */
  readonly printedAccidental?: string
  readonly arpeggiate?: { readonly number?: string; readonly direction?: 'up' | 'down' }
  readonly accidentalContext: AccidentalContext
  /** Fingering from the score, if supplied (keyboard guide may show it). */
  readonly fingering?: string
  /**
   * Explicit MusicXML `attack` offset in whole notes (source-resolved roll timing), kept so a
   * practice tempo supplied later (`withUserTempo`) realizes it instead of the default spread.
   */
  readonly attack?: Rational
}

export interface PerformedNote {
  /** Index in `ScoreModel.notes` (sorted by onset, then staff, then midi). */
  readonly index: number
  /** Stable within a score version: `${occ}:${src}`. */
  readonly id: string
  readonly src: number
  readonly occ: number
  readonly onset: Rational
  readonly duration: Rational
  /** Tie-chain head: total tied duration. Continuations: their own duration. */
  readonly soundingDuration: Rational
  readonly staff: number
  readonly staffNumber: number
  readonly partId: string
  readonly voice: string
  readonly hand: Hand
  readonly midi: number
  readonly sounding: Spelling
  readonly written: Spelling
  readonly ottavaShift: number
  /** Index into `ScoreModel.ottavas` when under an ottava. */
  readonly ottava?: number
  /** Clef governing this note's displayed staff at its onset. */
  readonly clef: ClefKey
  /** True when this note continues a tie (no fresh attack required). */
  readonly tieContinuation: boolean
  /** Performed index of the tie-chain head (itself when not tied). */
  readonly tieHead: number
  /** Index into `ScoreModel.arpeggios` when part of a marked roll. */
  readonly arpeggio?: number
  /** Reference attack offset in seconds at 1× (rolls); scale by 1/multiplier at runtime. */
  readonly refOffsetSec: number
  /** Playback velocity 1..127 from dynamics. */
  readonly velocity: number
  readonly grace: boolean
  /**
   * MusicXML `<cue/>`: engraved for information (another part, an ossia), not played. Never
   * expected, sounded, labeled or snapped to; the bar stays supported (DECISIONS I13).
   */
  readonly cue: boolean
  readonly onsetInMeasure: Rational
  readonly accidentalContext: AccidentalContext
  readonly fingering?: string
}

export interface KeyEvent {
  readonly at: Rational
  readonly occ: number
  readonly fifths: number
  readonly mode?: string
}

export interface MeterEvent {
  readonly at: Rational
  readonly occ: number
  readonly beats: number
  readonly beatType: number
  /** Raw `<beats>` text for compound/additive meters like "3+2". */
  readonly beatsText: string
  readonly symbol?: string
}

export interface ClefEvent {
  readonly at: Rational
  readonly occ: number
  readonly staff: number
  readonly clef: ClefDef
  readonly key: ClefKey
}

export interface OttavaSpan {
  readonly index: number
  readonly staff: number
  readonly number: string
  /** 8 or 15 (MusicXML `size`). */
  readonly size: 8 | 15
  /** Sounding relative to written: 'up' = 8va/15ma, 'down' = 8vb/15mb. */
  readonly sounds: 'up' | 'down'
  /** Performance positions, half-open [start, end). */
  readonly start: Rational
  readonly end: Rational
  readonly startOcc: number
  readonly endOcc: number
  /** Performed note indices displaced by this span. */
  readonly notes: readonly number[]
}

export type PedalKind = 'sustain' | 'sostenuto' | 'soft'

export interface PedalMark {
  readonly at: Rational
  readonly occ: number
  readonly kind: PedalKind
  /** 'change' = release then re-depress at the same position. */
  readonly type: 'start' | 'stop' | 'change' | 'continue'
  /** 0..127 when the source specifies a continuous value. */
  readonly value?: number
  readonly staff?: number
}

export interface DynamicMark {
  readonly at: Rational
  readonly occ: number
  readonly staff?: number
  /** MIDI velocity (MusicXML `sound/@dynamics` × 0.9, or the mark's conventional value). */
  readonly velocity: number
  readonly text?: string
}

export interface ArpeggioGroup {
  readonly index: number
  readonly at: Rational
  readonly occ: number
  /** Performed note indices in the gesture (may span both staves). */
  readonly notes: readonly number[]
  readonly direction: 'up' | 'down'
  /** True when the source gave no arrow (direction defaulted to up). */
  readonly directionDefaulted: boolean
  readonly crossStaff: boolean
  readonly number?: string
  /** Reference spread first→last attack, seconds at 1×. */
  readonly spreadSec: number
}

export type UnsupportedKind =
  'grace' | 'ornament' | 'tremolo' | 'microtone' | 'free-time' | 'unsupported-repeat' | 'non-piano' | 'other'

/** A passage viewable but excluded from scored practice until interpreted (never silently dropped). */
export interface UnsupportedRegion {
  readonly kind: UnsupportedKind
  readonly fromOcc: number
  readonly toOcc: number
  readonly message: string
}

/** Timing that cannot be scored exactly (fermata, verbal tempo, rubato). */
export interface TimingIssue {
  readonly kind: 'fermata' | 'verbal-tempo' | 'rubato' | 'other'
  readonly occ: number
  readonly at: Rational
  readonly text: string
}

/**
 * A section of the piece shown on the overview (DECISIONS I12): a rehearsal mark or heading-like
 * words ("A", "Verse", "Coda") at the start of a performed bar. Display only.
 */
export interface ScoreSection {
  readonly occ: number
  readonly label: string
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  /** Stable machine code, e.g. "tempo-conflict", "hand-ambiguous", "xml-malformed". */
  readonly code: string
  readonly message: string
  /** Printed measure number for display. */
  readonly measure?: string
  readonly occ?: number
}

export interface ScoreModel {
  readonly format: typeof SCORE_PACKAGE_FORMAT
  /** Hash of source bytes + importer version (+ selected entry/parts). */
  readonly scoreVersionId: string
  readonly meta: ScoreMeta
  readonly parts: readonly PartRef[]
  readonly staves: readonly StaffDef[]
  readonly voices: readonly VoiceDef[]
  readonly hands: HandAssignment
  readonly sourceMeasures: readonly SourceMeasure[]
  readonly sourceNotes: readonly SourceNote[]
  readonly occurrences: readonly MeasureOccurrence[]
  readonly notes: readonly PerformedNote[]
  readonly tempo: TempoMapData
  readonly keys: readonly KeyEvent[]
  readonly meters: readonly MeterEvent[]
  readonly clefs: readonly ClefEvent[]
  readonly ottavas: readonly OttavaSpan[]
  readonly pedals: readonly PedalMark[]
  readonly dynamics: readonly DynamicMark[]
  readonly arpeggios: readonly ArpeggioGroup[]
  readonly unsupported: readonly UnsupportedRegion[]
  readonly timingIssues: readonly TimingIssue[]
  readonly diagnostics: readonly Diagnostic[]
  /** Total performance length in whole notes. */
  readonly totalDuration: Rational
  /**
   * Section marks by performed bar, sorted (additive, I12). Absent when the score has none and in
   * packages imported before sections were read.
   */
  readonly sections?: readonly ScoreSection[]
}

/** What gets stored per imported score version. */
export interface ScorePackage {
  readonly model: ScoreModel
  /**
   * MusicXML handed to the engraver: the selected score/parts with repeats unfolded into
   * performance order (one `<measure>` per `MeasureOccurrence`, same order), repeat/ending
   * barlines and system/page breaks removed. Notes keep their original pitch data.
   */
  readonly renderXml: string
}

/** Original source retained locally with its packaging (spec: retain the original source). */
export interface SourceFileRecord {
  readonly fileName: string
  readonly packaging: ScoreMeta['packaging']
  readonly bytes: ArrayBuffer
  readonly sha256: string
}
