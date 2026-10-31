/**
 * Raw per-part data read from a score-partwise document, before measures are unfolded.
 * Positions are *source* positions: a measure index plus an offset in whole notes.
 */
import type { Rational } from '../../music/rational'
import type { Spelling } from '../../music/pitch'
import type { ClefDef, PedalKind } from '../../model/score'
import type { XmlElement } from '../xml'

/** A position in the written score: source measure index + offset within it (whole notes). */
export interface SrcPos {
  readonly m: number
  readonly at: Rational
}

export interface RawNote {
  readonly partId: string
  /** Order among this part's `<note>` elements (rests included). */
  readonly docOrder: number
  readonly m: number
  readonly at: Rational
  /** Whole notes; 0 for grace notes. */
  readonly duration: Rational
  readonly voice: string
  /** `<staff>` within the part (1-based). */
  readonly staff: number
  readonly rest: boolean
  /** `<pitch>` as written in the file (MusicXML: the sounding pitch under an ottava). */
  readonly pitch?: Spelling
  readonly unpitched: boolean
  readonly chord: boolean
  readonly grace: boolean
  readonly cue: boolean
  readonly tieStart: boolean
  readonly tieStop: boolean
  readonly printedAccidental?: string
  readonly arpeggiate?: { readonly number?: string; readonly direction?: 'up' | 'down' }
  readonly fermata: boolean
  /** A caesura after this note (articulation): an unmeasured pause. */
  readonly caesura: boolean
  /** Names of `<ornaments>` children that need realization ("trill-mark", "tremolo", …). */
  readonly ornaments: readonly string[]
  readonly fingering?: string
  /** `attack` attribute converted to whole notes (source-resolved performance timing). */
  readonly attack?: Rational
  /** `dynamics` attribute: percentage of forte (90). */
  readonly dynamicsPct?: number
  readonly printObject: boolean
}

export interface RawKey {
  readonly m: number
  readonly at: Rational
  readonly fifths: number
  readonly mode?: string
  /** The source `<key>` element (re-inserted at repeat jumps in the render XML). */
  readonly el?: XmlElement
}

export interface RawTime {
  readonly m: number
  readonly at: Rational
  readonly beats: number
  readonly beatType: number
  readonly beatsText: string
  readonly symbol?: string
  /** Nominal measure length in whole notes (sum of all beats/beat-type pairs). */
  readonly nominal: Rational
  readonly senzaMisura: boolean
  readonly el?: XmlElement
}

export interface RawClef {
  readonly m: number
  readonly at: Rational
  readonly staff: number
  readonly clef: ClefDef
  readonly el?: XmlElement
}

export interface RawDivisions {
  readonly m: number
  readonly at: Rational
  /** Divisions per quarter note. */
  readonly value: Rational
}

export interface RawMetronome {
  readonly beatUnit: Rational
  readonly perMinute: number
  readonly printed: boolean
}

/** One tempo statement at a position: `<sound tempo>` and/or a numeric `<metronome>`. */
export interface RawTempo {
  readonly partId: string
  readonly m: number
  readonly at: Rational
  readonly sound?: number
  readonly metronome?: RawMetronome
}

export interface RawDynamics {
  readonly m: number
  readonly at: Rational
  readonly staff?: number
  /** MIDI velocity (sound dynamics × 0.9, or the mark's conventional value). */
  readonly velocity: number
  readonly text?: string
}

export interface RawPedal {
  readonly m: number
  readonly at: Rational
  readonly kind: PedalKind
  readonly type: 'start' | 'stop' | 'change' | 'continue'
  readonly value?: number
  readonly staff?: number
}

export interface RawOttava {
  readonly m: number
  readonly at: Rational
  readonly staff: number
  readonly type: 'up' | 'down' | 'stop' | 'continue'
  readonly size: number
  readonly number: string
  /** The `<octave-shift>` element (identity used when writing the unfolded render XML). */
  readonly el: XmlElement
}

export interface RawWords {
  readonly m: number
  readonly at: Rational
  readonly staff?: number
  readonly text: string
  /** True when the direction itself states a numeric tempo (metronome or sound tempo). */
  readonly withTempo: boolean
  /** A metronome equation (beat-unit = beat-unit) without a numeric tempo. */
  readonly metricModulation?: boolean
}

/** A section mark (DECISIONS I12): a rehearsal mark, or words written like a heading. */
export interface RawSection {
  readonly m: number
  readonly at: Rational
  readonly label: string
  readonly source: 'rehearsal' | 'words'
}

/** Navigation marks (spec "Unfold written repeats"; DECISIONS I4): targets and jump instructions. */
export type NavKind = 'segno' | 'coda' | 'tocoda' | 'fine' | 'dacapo' | 'dalsegno'

/**
 * One navigation mark as written: a `<sound>` attribute (segno, coda, tocoda, fine, dacapo,
 * dalsegno), a sign (`<segno/>`, `<coda/>` in a direction or barline) or recognized words
 * ("D.S. al Coda", "To Coda", "Fine"). Resolved per bar by `navigation.ts`.
 */
export interface RawNavMark {
  readonly m: number
  readonly at: Rational
  readonly kind: NavKind
  /** `<sound>` token linking a jump to its target (dalsegno="segno" → segno="segno"). */
  readonly token?: string
  /** The direction's printed words, if any ("D.S. al Coda"). */
  readonly text?: string
  /** A sign on a right-hand barline: it marks the start of the next bar. */
  readonly endOfBar?: boolean
  /** The `<direction>` or measure-level `<sound>` carrying the mark (render XML shows it per pass). */
  readonly el?: XmlElement
}

export interface RawBarlines {
  readonly forwardRepeat: boolean
  /** Backward repeat at the end of the measure; `times` when the file states it. */
  readonly backwardRepeat?: { readonly times?: number }
  readonly endingStart?: { readonly numbers: readonly number[]; readonly text: string }
  readonly endingStop: boolean
  /** A fermata written on a barline, at the measure's start or end. */
  readonly fermata?: 'left' | 'right'
}

export interface RawMeasure {
  readonly index: number
  readonly number: string
  readonly implicit: boolean
  /** Furthest cursor position reached (MusicXML measure length). */
  readonly filled: Rational
  /** Latest note end per voice (validation). */
  readonly voiceEnds: ReadonlyMap<string, Rational>
  readonly barlines: RawBarlines
  readonly hasMultiRest: boolean
}

export interface PartData {
  readonly id: string
  readonly staves: number
  readonly measures: readonly RawMeasure[]
  readonly notes: readonly RawNote[]
  readonly keys: readonly RawKey[]
  readonly times: readonly RawTime[]
  readonly clefs: readonly RawClef[]
  readonly divisions: readonly RawDivisions[]
  readonly tempos: readonly RawTempo[]
  readonly dynamics: readonly RawDynamics[]
  readonly pedals: readonly RawPedal[]
  readonly ottavas: readonly RawOttava[]
  readonly words: readonly RawWords[]
  readonly navigation: readonly RawNavMark[]
  /** Rehearsal marks and heading-like words (overview sections). */
  readonly sections: readonly RawSection[]
  /** Chromatic/diatonic/octave transposition from `<transpose>` (rare for piano). */
  readonly transpose?: { readonly chromatic: number; readonly diatonic: number; readonly octaveChange: number }
}
