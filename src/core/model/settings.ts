import type { LanguagePreference } from './language'
/**
 * App settings shared by naming, labels, hints, MIDI routing, playback and storage.
 * Defaults follow the spec's "Recommended defaults" table. Settings are plain JSON and
 * included in export/restore.
 */
import type { Spelling } from '../music/pitch'
import type { ClefKey } from './score'

/**
 * 2: `sound.destination` gained 'auto' (the new default); a stored 'midi' from version 1 was the
 * old default and is read as 'auto' once (DECISIONS S4, `core/storage/settings.ts`).
 * 3: `hints.autoThreshold` default 1 (was 2); a stored 2 from an older version was the old
 * default and is read as 1 once (`core/storage/settings.ts`).
 */
export const SETTINGS_VERSION = 3

export interface NamingSettings {
  readonly system: 'letter' | 'fixed-do'
  /** Fixed-do 7th degree: "si" (default) or "ti". */
  readonly seventh: 'si' | 'ti'
  readonly showOctave: boolean
  /** Spec default ON: name the actual pitch independently of key signature/carried accidentals. */
  readonly alwaysShowEffectiveAccidentals: boolean
  /** Spec default OFF: B♯→C, C♭→B, E♯→F, F♭→E, double accidentals reduced. */
  readonly simplifyEnharmonics: boolean
}

export interface LabelCondition {
  readonly enabled: boolean
  /** Threshold pitch (name + accidental + octave). Null = unset. Comparisons are strict. */
  readonly threshold: Spelling | null
}

export interface ClefLabelRule {
  readonly below: LabelCondition
  readonly above: LabelCondition
}

export type PersistentLabelMode = 'off' | 'all' | 'conditional'

export interface PersistentLabelSettings {
  readonly mode: PersistentLabelMode
  /** One rule per clef key ("G2", "F4", …). Unknown clefs get a both-disabled rule when first seen. */
  readonly rules: Readonly<Record<ClefKey, ClefLabelRule>>
  /**
   * Also label tie continuations, the notes held over rather than played (default off, DECISIONS
   * U69). Applies to All notes and Conditional; temporary hints only ever name played notes.
   */
  readonly tiedContinuations: boolean
}

export interface HintSettings {
  /** Wrong attacks at the current group before names auto-appear. null = off. */
  readonly autoThreshold: number | null
  /** Active-practice seconds a temporary hint stays; 'until-correct' never expires. */
  readonly lifetime: number | 'until-correct'
  /** Label fade-out duration in ms (proposed 300). */
  readonly fadeMs: number
  /**
   * The red edge flash on a wrong note (default on, DECISIONS S5). Guide markings, cues and
   * hints are controlled separately.
   */
  readonly damageFlash: boolean
  /** Show live rushing and dragging cues and their matching cursor tint. */
  readonly showTimingCues: boolean
}

export interface HintPedalMapping {
  readonly channel: number | null
  readonly controller: number
  /** Value boundary between up and down (conventional 64; learned from the piano). */
  readonly threshold: number
  readonly inverted: boolean
  /** Observed range during learning, for diagnostics. */
  readonly observedMin: number
  readonly observedMax: number
  readonly verified: boolean
}

export interface PedalSettings {
  readonly hintPedal: HintPedalMapping | null
  readonly hintPedalAction: 'names' | 'keys'
  /** Controller numbers the piano was observed to send in setup (sustain 64, sostenuto 66, soft 67…). */
  readonly observedControllers: readonly number[]
}

export interface MidiRouteSettings {
  readonly inputId: string | null
  readonly inputName: string | null
  readonly outputId: string | null
  readonly outputName: string | null
  /** 0-based MIDI channel for app-generated output. */
  readonly outputChannel: number
  /** User confirmed the Play test note sounded on the piano. */
  readonly outputVerified: boolean
  /** Echo test result: does app output come back on the input? */
  readonly echo: 'untested' | 'none' | 'echo-detected'
  /** Send score pedals in one-hand practice (only when verified confined to the automatic part). */
  readonly automaticPedalsInHandPractice: boolean
  /** 0..1 velocity scaling for app-generated playback. */
  readonly accompanimentLevel: number
  readonly connection: 'usb' | 'bluetooth' | 'unknown'
}

/**
 * Where app playback (accompaniment, Listen) goes (DECISIONS S4): 'auto' = the connected piano's
 * MIDI output when there is one, otherwise this device's browser sound; 'midi' = the piano only;
 * 'browser' = this device only.
 */
export type SoundDestination = 'auto' | 'midi' | 'browser'

export interface SoundSettings {
  readonly destination: SoundDestination
  readonly browserVolume: number
  /** Optional monitoring of the learner's keys through browser sound (silent controllers). Off. */
  readonly monitorInput: boolean
}

/**
 * The Web Audio click (DECISIONS P20). The Keep time count-in always clicks, whatever both
 * switches say.
 */
export interface MetronomeSettings {
  /** The click in Listen, Wait and Follow (default off). */
  readonly enabled: boolean
  /** The click during a Keep time attempt, after its count-in (default on). */
  readonly keepTime: boolean
  /** 0..1 click volume. */
  readonly volume: number
  /** Browser audio output device ID, or null to follow the system audio output. */
  readonly outputId: string | null
}

/**
 * Keep time (rhythm mode, DECISIONS P13): a group completed within ±`toleranceMs` of its
 * scheduled time is on time. Must equal the engine's `DEFAULT_RHYTHM_TOLERANCE_MS` by default
 * (checked by a test; `core/model` does not import the engine).
 */
export interface RhythmSettings {
  /** Milliseconds, in [MIN_RHYTHM_TOLERANCE_MS, MAX_RHYTHM_TOLERANCE_MS]. */
  readonly toleranceMs: number
  /** Play both scored parts during Keep time (default off). */
  readonly scorePlayback: boolean
  /** 0..1 relative to the usual automatic playback level. */
  readonly scorePlaybackVolume: number
}

export const MIN_RHYTHM_TOLERANCE_MS = 40
export const MAX_RHYTHM_TOLERANCE_MS = 500

/**
 * The audio input performance recordings use (DECISIONS D20): set when a take starts from the
 * setup sheet, null until then. It belongs to this device, like the MIDI route.
 */
export interface RecordingSettings {
  /** Browser audio input device ID. */
  readonly inputId: string | null
  /** The input's name, which recognizes it when the browser gives out new IDs. */
  readonly inputLabel: string | null
}

export interface ViewSettings {
  readonly language: LanguagePreference
  /** Notation scale factor (pinch zoom) of the landscape strip. */
  readonly zoom: number
  /**
   * Notation scale of the portrait page (page mode): zoom in = fewer bars per system. Kept apart
   * from `zoom` because the page re-engraves at `stage width / pageZoom`.
   */
  readonly pageZoom: number
  readonly theme: 'system' | 'light' | 'dark'
  /** Score paper: follow the theme (dark paper in dark mode) or always classic light paper. */
  readonly scorePaper: 'theme' | 'light'
}

export interface SuggestionSettings {
  readonly enabled: boolean
}

export interface AppSettings {
  readonly version: typeof SETTINGS_VERSION
  readonly naming: NamingSettings
  readonly labels: PersistentLabelSettings
  readonly hints: HintSettings
  readonly pedal: PedalSettings
  readonly route: MidiRouteSettings
  readonly sound: SoundSettings
  readonly metronome: MetronomeSettings
  /** Keep time (rhythm mode). Absent in older stored settings: normalized to the default. */
  readonly rhythm: RhythmSettings
  /** Microphone following. Absent in older stored settings: off. */
  /** The remembered recording input. Absent in older stored settings: none. */
  readonly recording: RecordingSettings
  readonly view: ViewSettings
  readonly suggestions: SuggestionSettings
}

/** The user's treble example, offered as an editable preset (spec: below C4 or above C5). */
export const TREBLE_PRESET: ClefLabelRule = {
  below: { enabled: true, threshold: { step: 'C', alter: 0, octave: 4 } },
  above: { enabled: true, threshold: { step: 'C', alter: 0, octave: 5 } },
}

export const DISABLED_RULE: ClefLabelRule = {
  below: { enabled: false, threshold: null },
  above: { enabled: false, threshold: null },
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  naming: {
    system: 'letter',
    seventh: 'si',
    showOctave: true,
    alwaysShowEffectiveAccidentals: true,
    simplifyEnharmonics: false,
  },
  labels: {
    mode: 'off',
    rules: {
      // Treble preset is editable; bass thresholds stay unset until the user chooses.
      G2: TREBLE_PRESET,
      F4: DISABLED_RULE,
    },
    tiedContinuations: false,
  },
  hints: { autoThreshold: 1, lifetime: 30, fadeMs: 300, damageFlash: true, showTimingCues: true },
  pedal: { hintPedal: null, hintPedalAction: 'names', observedControllers: [] },
  route: {
    inputId: null,
    inputName: null,
    outputId: null,
    outputName: null,
    outputChannel: 0,
    outputVerified: false,
    echo: 'untested',
    automaticPedalsInHandPractice: false,
    accompanimentLevel: 1,
    connection: 'unknown',
  },
  sound: { destination: 'auto', browserVolume: 0.8, monitorInput: false },
  metronome: { enabled: false, keepTime: true, volume: 0.6, outputId: null },
  rhythm: { toleranceMs: 150, scorePlayback: false, scorePlaybackVolume: 1 },
  recording: { inputId: null, inputLabel: null },
  view: { language: 'system', zoom: 1, pageZoom: 1, theme: 'system', scorePaper: 'theme' },
  suggestions: { enabled: true },
}
