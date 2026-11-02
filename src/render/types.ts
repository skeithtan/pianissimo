/**
 * Renderer contracts (spec "Execution and rendering architecture", DECISIONS R1–R3, M5).
 *
 * Coordinates are *layout pixels*: the engraver's SVG user space at zoom 1 (OSMD: one staff
 * space = 10 px). Pinch zoom is a CSS scale applied on top (R2) and never changes these values.
 * Everything here is plain JSON so a `PreparedLayout` can be cached in IndexedDB.
 */
import type {
  ClefEvent,
  Hand,
  KeyEvent,
  MeasureOccurrence,
  MeterEvent,
  OttavaSpan,
  PerformedNote,
  StaffDef,
} from '../core/model/score'
import type { TextMeasurer } from './labels/metrics'

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The parts of a performed note the renderer maps graphics to. `PerformedNote` satisfies it. */
export type MappingNote = Pick<
  PerformedNote,
  'index' | 'occ' | 'staff' | 'voice' | 'onsetInMeasure' | 'midi' | 'grace' | 'hand'
> &
  /** Cue notes are mapped (highlight-safe) but get no label unit (I13). */
  Partial<Pick<PerformedNote, 'cue'>>

/** What the renderer needs from the score package. `ScorePackage` + `ScoreModel` satisfy it. */
export interface RenderInput {
  /** Unfolded MusicXML: one `<measure>` per occurrence, performance order (ScorePackage.renderXml). */
  readonly renderXml: string
  readonly scoreVersionId: string
  readonly notes: readonly MappingNote[]
  readonly occurrences: readonly Pick<MeasureOccurrence, 'index' | 'number' | 'pass' | 'start' | 'duration'>[]
  readonly staves: readonly Pick<StaffDef, 'index'>[]
  readonly ottavas: readonly Pick<
    OttavaSpan,
    'index' | 'staff' | 'size' | 'sounds' | 'start' | 'end' | 'startOcc' | 'endOcc'
  >[]
  readonly clefs: readonly Pick<ClefEvent, 'at' | 'occ' | 'staff' | 'clef' | 'key'>[]
  readonly keys: readonly Pick<KeyEvent, 'at' | 'occ' | 'fifths' | 'mode'>[]
  readonly meters: readonly Pick<MeterEvent, 'at' | 'occ' | 'beats' | 'beatType' | 'beatsText' | 'symbol'>[]
}

/**
 * How much room the engraving leaves for note names (DECISIONS R3 revised). 'all': persistent
 * labels may show every name at once, so each gets a reserved box beside its notehead and the
 * spacing widens until they fit. 'hints': Labels Off, only temporary hints for one group at a
 * time; the music is engraved tight and a hint that finds no room beside its note becomes a
 * callout above or below the staff, which may sit over a neighboring mark.
 */
export type LabelRoom = 'all' | 'hints'

/** Label sizing supplied by the caller. Changing any field is an explicit relayout (R3). */
export interface LabelSizing {
  /** Widest label in characters, e.g. `maxLabelWidthChars(naming)` from core/naming. */
  readonly maxChars: number
  /** Label font size in layout px (default `LABEL_FONT_PX`, 13.5). */
  readonly fontPx?: number
  /** Default 'all'. */
  readonly room?: LabelRoom
}

/** Engraving spacing actually used (OSMD EngravingRules names; other engines map their own). */
export interface SpacingParams {
  readonly voiceSpacingMultiplier: number
  readonly voiceSpacingAddend: number
}

export interface LayoutParams {
  readonly labelChars: number
  readonly labelFontPx: number
  /** Absent in layouts from before rooms existed ('all'). */
  readonly labelRoom?: LabelRoom
  /** Reserved label box size (every label gets this box, R3). */
  readonly labelW: number
  readonly labelH: number
  readonly segmentWidth: number
  readonly spacing: SpacingParams
  /** Engravings performed (1 = the first spacing was enough). */
  readonly iterations: number
  /** Page mode only: the page width the systems were wrapped to (layout px). */
  readonly pageWidth?: number
}

export interface StaffGeometry {
  readonly index: number
  /** y of the top and bottom staff lines. */
  readonly top: number
  readonly bottom: number
}

export interface OccurrenceGeometry {
  readonly occ: number
  /** Left and right barline x. */
  readonly x0: number
  readonly x1: number
  /** Performance start and duration in whole notes (float copies of the model's rationals). */
  readonly start: number
  readonly duration: number
  /**
   * Onset anchors `[positionInMeasure, x]`, sorted, including rests; first is `[0, contentX]`
   * and last `[duration, x1]`. Positions between anchors interpolate linearly.
   */
  readonly anchors: readonly (readonly [number, number])[]
  /** App-drawn measure number text (M5): "12" or "12 (pass 2)". */
  readonly label: string
  readonly labelBox: Box
  /** Page mode only: the system (line) holding this bar. */
  readonly system?: number
}

export interface NoteGeometry {
  readonly index: number
  readonly occ: number
  readonly staff: number
  readonly hand: Hand
  /** Union of this note's notehead glyph boxes. */
  readonly head: Box
  /** Onset anchor x (staff-entry x, notehead center for an undisplaced head). */
  readonly x: number
  /** Index of the label unit; notes sharing a graphical notehead share one unit. */
  readonly label: number
  /** Engraver graphic id of the note's glyph group (for diagnostics). */
  readonly graphic: string
  /** Page mode only: the system (line) holding the note. */
  readonly system?: number
}

export type LabelPlacement = 'right' | 'stagger' | 'left' | 'stack' | 'callout'

export interface LabelBox {
  readonly id: number
  /** Performed notes this label names (several only for a shared notehead). */
  readonly notes: readonly number[]
  readonly occ: number
  readonly staff: number
  readonly hand: Hand
  /** Reserved box (labelW × labelH). */
  readonly box: Box
  /** Text anchor point (baseline); `anchor` is the SVG text-anchor (end for labels left of a head). */
  readonly tx: number
  readonly ty: number
  readonly anchor: 'start' | 'end' | 'middle'
  /** Short connecting line `[x1, y1, x2, y2]` for stacked or displaced labels. */
  readonly leader?: readonly [number, number, number, number]
  readonly placement: LabelPlacement
}

export interface OttavaGeometry {
  readonly span: number
  readonly staff: number
  /** Whole bracket: label + dashes + hook. */
  readonly box: Box
  /** The "8va"/"15mb" label glyphs. */
  readonly labelBox: Box
  /** Display text, e.g. "8va", "8vb", "15ma", "15mb". */
  readonly text: string
  /** False when the engraving had no bracket for the span and the box was synthesized. */
  readonly engraved: boolean
}

export interface ContextGlyph {
  /** Standalone SVG fragment (sanitized), drawn with its staff top line at y = 0. */
  readonly svg: string
  readonly width: number
}

/** Clef + key + meter for one staff at some position, pre-engraved for the sticky edge. */
export interface StaffContext {
  readonly staff: number
  readonly glyph: ContextGlyph
}

export interface ContextState {
  readonly id: number
  readonly staves: readonly StaffContext[]
  readonly width: number
}

/** From layout x `x` onward (until the next change), `contexts[context]` applies. */
export interface ContextChange {
  readonly x: number
  readonly occ: number
  readonly context: number
  /** x where the change's own engraved glyphs end; sticky shows once this scrolls away. */
  readonly glyphEnd: number
}

export interface SegmentData {
  readonly index: number
  /** Half-open occurrence range [occStart, occEnd). */
  readonly occStart: number
  readonly occEnd: number
  readonly x0: number
  readonly x1: number
  /**
   * Standalone sanitized SVG in global layout coordinates (viewBox `x0 top (x1-x0) height`).
   * Noteheads carry `data-n="<noteIndex …>"`, note glyph groups `data-h="L|R"`, ottava bracket
   * parts `data-o="<spanIndex>"`.
   */
  readonly svg: string
  /** Label id range [labelStart, labelEnd) whose notes are in this segment. */
  readonly labelStart: number
  readonly labelEnd: number
  /**
   * Page mode only: the segment is one system, drawn from page y `y0` to `y1` (its viewBox is
   * `x0 y0 (x1-x0) (y1-y0)` in page coordinates; the engraving inside is translated there).
   */
  readonly y0?: number
  readonly y1?: number
  readonly system?: number
}

/**
 * Page mode (portrait): one wrapped line of music. Systems are stacked top to bottom with a fixed
 * gap; every page-mode coordinate (notes, labels, staves, bars' number boxes) is in this stacked
 * page space, so a system's content lies within [y0, y1].
 */
export interface SystemGeometry {
  readonly index: number
  /** Half-open bar range [occStart, occEnd). */
  readonly occStart: number
  readonly occEnd: number
  /** Page y extent of the system's content (notation, labels, numbers), layout px. */
  readonly y0: number
  readonly y1: number
  /** The system's staves (top and bottom staff lines in page y). */
  readonly staves: readonly StaffGeometry[]
}

export type LayoutMode = 'strip' | 'page'

export interface MappingReport {
  readonly modelNotes: number
  readonly graphicalNotes: number
  readonly mapped: number
  /** Model notes with no graphic. Must be empty (feasibility gate). */
  readonly unmappedNotes: readonly number[]
  /** Graphical notes with no model note, as `occ:staff:voice:onset:midi`. Must be empty. */
  readonly unmappedGraphics: readonly string[]
  /** Matches that needed a relaxed key (voice or staff disagreed). */
  readonly relaxedMatches: number
  /** Label units covering more than one note (shared noteheads). */
  readonly sharedHeads: number
  readonly ottavasMapped: number
  readonly ottavasUnmapped: readonly number[]
}

export interface LayoutStats {
  /** OSMD module fetch + evaluation (0 when already loaded). */
  readonly loadMs: number
  /** MusicXML parse + engraving, all iterations. */
  readonly engraveMs: number
  readonly extractMs: number
  readonly labelMs: number
  readonly partitionMs: number
  readonly totalMs: number
  /** Elements in the complete engraved SVG (before partitioning; discarded afterwards). */
  readonly svgNodes: number
  /** Sum of serialized segment SVG lengths (UTF-16 code units ≈ bytes for this ASCII text). */
  readonly segmentBytes: number
  /** Labels that needed a callout, per engraving iteration. */
  readonly labelFailuresPerIteration: readonly number[]
  readonly placements: Readonly<Record<LabelPlacement, number>>
}

export const PREPARED_LAYOUT_FORMAT = 1

/** Everything needed to show the strip without the engraver. Serializable; cache with `LayoutCache`. */
export interface PreparedLayout {
  readonly format: typeof PREPARED_LAYOUT_FORMAT
  readonly key: string
  readonly scoreVersionId: string
  readonly renderer: { readonly name: string; readonly version: string }
  readonly params: LayoutParams
  /** Content box: x from 0 to `width`, y from `top` to `top + height` (includes every label). */
  readonly width: number
  readonly top: number
  readonly height: number
  readonly staves: readonly StaffGeometry[]
  readonly occurrences: readonly OccurrenceGeometry[]
  /** By `PerformedNote.index`; null only when unmapped (see report). */
  readonly notes: readonly (NoteGeometry | null)[]
  /** Sorted by (occ, box x); ids equal positions. */
  readonly labels: readonly LabelBox[]
  /** By `OttavaSpan.index`. */
  readonly ottavas: readonly (OttavaGeometry | null)[]
  readonly contexts: readonly ContextState[]
  /** Sorted by x; the first applies from x = 0. */
  readonly contextChanges: readonly ContextChange[]
  readonly segments: readonly SegmentData[]
  readonly report: MappingReport
  readonly stats: LayoutStats
  /**
   * 'page' for a portrait page layout (systems wrapped to `params.pageWidth`); absent or 'strip'
   * for the horizontal strip. In page mode `staves` are the first system's, `contexts` and
   * `contextChanges` are empty (every system engraves its own clef and key), segments are systems.
   */
  readonly mode?: LayoutMode
  /** Page mode only: the systems, top to bottom (segment `i` is system `i`). */
  readonly systems?: readonly SystemGeometry[]
}

export interface PrepareOptions {
  readonly labels: LabelSizing
  /** Offscreen host to attach the engraving container to (default `document.body`). */
  readonly host?: HTMLElement
  /** Target segment width in layout px (default 1600). */
  readonly segmentWidth?: number
  /** Bounded engravings when labels do not fit beside their notes (default 3; room 'hints': 1). */
  readonly maxIterations?: number
  /** Spacing for the first engraving (default: the adapter's default for the label room). */
  readonly spacing?: SpacingParams
  readonly signal?: AbortSignal
  readonly onProgress?: (stage: PrepareStage, fraction: number) => void
  /** Measure number text; default M5 "12" / "12 (pass 2)". */
  readonly measureLabel?: (number: string, pass: number) => string
  /**
   * Text measurement for label and measure-number boxes (default: canvas `measureText` in the
   * strip's `--font-ui`, falling back to a 0.62 em estimate). Tests inject a fixed measurer.
   */
  readonly textMeasurer?: TextMeasurer
  /** 'page' engraves wrapped systems (portrait page mode); default 'strip' (one staffline). */
  readonly mode?: LayoutMode
  /**
   * Page mode: the width systems wrap to, in layout px (the stage width minus its side gutters,
   * divided by the zoom; `pageWidthFor` in render/page). Ignored by the strip. Default 800.
   */
  readonly pageWidth?: number
}

export type PrepareStage = 'loading' | 'engraving' | 'extracting' | 'labels' | 'partitioning' | 'done'

/**
 * Engraver adapter (spec: OSMD behind an adapter so Verovio can replace it). One call does the
 * whole-score layout, maps graphics to `PerformedNote.index`, reserves label room, partitions
 * the result into segments and discards the full SVG tree.
 */
export interface RendererAdapter {
  readonly name: string
  readonly version: string
  prepare(input: RenderInput, options: PrepareOptions): Promise<PreparedLayout>
}
