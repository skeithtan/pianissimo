/**
 * Structural types for the parts of OSMD 2.2.1 the adapter reads. Declared here (instead of
 * importing OSMD's own declarations) so the dependency surface is explicit and the main bundle
 * never references the library statically.
 */
export interface OsmdFraction {
  readonly RealValue: number
  readonly Numerator: number
  readonly Denominator: number
  readonly WholeValue: number
}

export interface OsmdPoint {
  readonly x: number
  readonly y: number
}

export interface OsmdBoundingBox {
  readonly AbsolutePosition: OsmdPoint
  readonly Size: { readonly width: number; readonly height: number }
}

export interface OsmdSourceNote {
  readonly halfTone: number
  readonly IsGraceNote: boolean
  isRest(): boolean
  readonly PrintObject: boolean
  readonly ParentVoiceEntry: { readonly ParentVoice: { readonly VoiceId: number } }
}

export interface OsmdVexNote {
  getAbsoluteX(): number
  getGlyph?(): { getWidth(): number }
}

export interface OsmdGraphicalNote {
  readonly sourceNote: OsmdSourceNote
  readonly vfnote?: readonly [OsmdVexNote, number]
  getSVGGElement?(): SVGGElement | undefined
  getSVGId?(): string | undefined
  getNoteheadSVGs?(): HTMLElement[]
}

export interface OsmdVoiceEntry {
  readonly notes: readonly OsmdGraphicalNote[]
  readonly parentVoiceEntry: { readonly ParentVoice: { readonly VoiceId: number } }
}

export interface OsmdStaffEntry {
  readonly relInMeasureTimestamp: OsmdFraction
  readonly graphicalVoiceEntries: readonly OsmdVoiceEntry[]
  readonly PositionAndShape: OsmdBoundingBox
}

export interface OsmdMeasure {
  readonly staffEntries: readonly OsmdStaffEntry[]
  readonly PositionAndShape: OsmdBoundingBox
  readonly MeasureNumber: number
  readonly beginInstructionsWidth: number
  readonly parentSourceMeasure?: { readonly Duration?: OsmdFraction }
}

export interface OsmdOctaveShift {
  readonly startNote?: OsmdVexNote
  readonly endNote?: OsmdVexNote
  readonly text?: string
  readonly supscript?: string
  /** VexFlow TextBracket position: 1 = above (TOP), -1 = below (BOTTOM). */
  readonly position?: number
}

export interface OsmdStaffLine {
  readonly PositionAndShape: OsmdBoundingBox
  readonly StaffHeight: number
  readonly OctaveShifts?: readonly OsmdOctaveShift[]
  /** The staff line's graphical measures (page mode reads which system holds a bar). */
  readonly Measures?: readonly OsmdMeasure[]
}

export interface OsmdGraphicSheet {
  /** [measureIndex][staffIndex]; entries may be undefined for invisible staves. */
  readonly MeasureList: readonly (readonly (OsmdMeasure | undefined)[])[]
  readonly MusicPages: readonly {
    readonly MusicSystems: readonly { readonly StaffLines: readonly OsmdStaffLine[] }[]
  }[]
}

export interface OsmdEngravingRules {
  VoiceSpacingMultiplierVexflow: number
  VoiceSpacingAddendVexflow: number
  SheetMaximumWidth: number
  RenderMultipleRestMeasures?: boolean
  [key: string]: unknown
}

export interface OsmdInstance {
  load(content: string): Promise<unknown>
  render(): void
  clear(): void
  readonly GraphicSheet: OsmdGraphicSheet
  readonly EngravingRules: OsmdEngravingRules
  readonly Version?: string
}

export interface OsmdModule {
  readonly OpenSheetMusicDisplay: new (host: HTMLElement, options: Record<string, unknown>) => OsmdInstance
}
