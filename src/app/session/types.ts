/**
 * Seams of the practice session: everything it talks to is an interface so the coordinator
 * runs in unit tests with a fake clock, fake MIDI, a fake strip and fake output.
 */
import type { MidiRouteEvent } from '../../core/midi/adapter'
import type { MidiInputEvent } from '../../core/midi/types'
import type { MidiOutputLike } from '../../core/midi/webmidi'
import type { AbandonEvent, AttemptRecord, InterruptReason, PassageRange } from '../../core/model/practice'
import type { HandSelection } from '../../core/model/score'
import type { Rational } from '../../core/music/rational'
import type { AppSettings } from '../../core/model/settings'
import type { Phase } from '../../core/engine'
import type { BrowserAudioModule, MetronomeModule, OutputBackend, TimerApi } from '../../core/playback'
import type { LadderSettings, ResumePosition } from '../../core/storage/records'
import type { GuideKey } from '../../render/keyboard/types'
import type { CorrectionMark } from '../../render/strip/StripView'

/** The subset of `StripView` the session drives (render/strip/StripView.ts). */
export interface StripSink {
  setCursor(position: number, opts?: { smooth?: boolean }): void
  setTargets(notes: readonly number[]): void
  setAccepted(notes: readonly number[]): void
  setAutomatic(notes: readonly number[]): void
  setPlaybackHighlights(notes: readonly number[]): void
  setSubduedHand(hand: 'L' | 'R' | null): void
  setWrongMarker(on: boolean): void
  pulseWrong(): void
  /**
   * The amber cursor tint for a right pitch pressed too early (gentler than the red wrong-key
   * marker, P3 revised). Optional: a strip without it shows nothing for early presses.
   */
  setEarlyMarker?(on: boolean): void
  setOttavaEmphasis(spans: readonly number[]): void
  setLabels(texts: ReadonlyMap<number, string>): void
  setLabelOpacity(opacity: ReadonlyMap<number, number>): void
  setLoop(range: PassageRange | null): void
  setLoopEditable(editable: boolean): void
  /**
   * Note onsets (exact, ascending) of the current hands — all onsets in Listen — that the dragged
   * playhead and the loop edges snap to (U19, U21). The same array again is a no-op.
   */
  setSnapPositions(onsets: readonly Rational[]): void
  /** The playhead can be dragged onto a note (`StripOptions.onCursorSeek`, U23). */
  setCursorDraggable(enabled: boolean): void
  setBrowseEnabled(enabled: boolean): void
  /**
   * The round repeat button in the middle of the cursor line (`StripOptions.onCursorAction`),
   * shown outside Repeat mode while nothing plays, or while playing with the chrome revealed
   * (DECISIONS U14). Never shown in Repeat mode.
   */
  setCursorAction(visible: boolean): void
  /**
   * A Repeat pass wrapped back to the loop start: the next cursor position is `position` (a
   * float whole-note position). The strip pans there quickly instead of scrolling backward.
   * Optional; without it the next `setCursor` jumps.
   */
  wrapTo?(position: number): void
  /**
   * The teacher's corrections after a completed scored attempt (red-pen rings with "Wrong note",
   * "Too soon", "Too late"; `./corrections.ts`); `[]` clears them.
   */
  setCorrections?(marks: readonly CorrectionMark[]): void
  visibleLabels(): number[]
  isBrowsing(): boolean
  /** Onset under a browsed fixed cursor, or null when browsing does not move the cursor. */
  browsedPosition?(): Rational | null
  /** End browsing and follow the current cursor again. */
  returnToCurrent?(): void
  /**
   * Applies the changes made so far in this animation frame now (the session calls it at the end
   * of its frame), so they show in this frame instead of the strip's own next frame.
   */
  flushFrame?(): void
}

/** The wrong-note flash (ui/WrongNoteFlash handle). */
export interface FlashSink {
  /** `soft`: the gentler envelope for a right pitch pressed too early (P3 revised). */
  hit(now?: number, untilMs?: number, options?: { readonly soft?: boolean }): void
  clear(): void
}

/** MIDI as the session sees it (app/services MidiService + its adapter). */
export interface MidiSource {
  /** Decoded input events of the selected piano input, in order. */
  subscribe(fn: (ev: MidiInputEvent) => void): () => void
  onRoute(fn: (ev: MidiRouteEvent) => void): () => void
  /** Stop sound runs registered owners before CC 123 (DECISIONS C4). */
  registerSoundOwner(owner: () => void): () => void
  /** Connected selected output, or null. */
  output(): MidiOutputLike | null
}

export interface FrameApi {
  request(cb: (time: number) => void): unknown
  cancel(handle: unknown): void
}

export interface HistorySink {
  queueAttempt(record: AttemptRecord): void
  queueAbandon(event: AbandonEvent): void
}

/** What the session persists on the piece (throttled by the caller; never per MIDI event). */
export interface PiecePatch {
  readonly lastMultiplier?: number
  readonly lastHands?: HandSelection
  readonly lastPassage?: PassageRange | null
  readonly resume?: ResumePosition | null
  readonly repeatTarget?: number | null
  readonly ladder?: LadderSettings | null
  /** Keep time (rhythm mode) for this piece. */
  readonly rhythm?: boolean
}

export interface PieceSink {
  /** `immediate` writes now (pause, seek, hide); otherwise debounced. */
  save(patch: PiecePatch, immediate?: boolean): void
}

export interface SessionDeps {
  readonly clock: () => number
  readonly timers: TimerApi
  readonly frames: FrameApi
  readonly midi: MidiSource
  readonly history: HistorySink
  readonly piece: PieceSink
  /** `performance.timeOrigin` for record timestamps. */
  readonly timeOrigin?: number
  /** Lazy loaders (tests inject fakes; MIDI-only use never calls `loadBrowserAudio`). */
  readonly loadBrowserAudio?: () => Promise<BrowserAudioModule>
  /**
   * Can this device play sound itself (Web Audio)? Decides whether Listen can fall back to
   * browser sound without a piano output (DECISIONS S3). Default: true when
   * `loadBrowserAudio` is supplied.
   */
  readonly hasWebAudio?: () => boolean
  readonly loadMetronome?: () => Promise<MetronomeModule>
  /** Builds the MIDI output backend (tests inject a recording backend). */
  readonly createMidiBackend?: (output: MidiOutputLike, channel: number, humanGuard: boolean) => MidiBackendLike
}

/** What the session needs from `MidiOutputBackend` beyond `OutputBackend`. */
export interface MidiBackendLike extends OutputBackend {
  humanInput(ev: MidiInputEvent): void
  resetHuman(): void
  disconnected(): void
  reconnect(output: MidiOutputLike, now: number): void
}

/**
 * What the session is doing (coarse; drives the footer and banners). `'playing'`: play-through
 * mode is on (DECISIONS P12), started or not.
 */
export type Activity = 'idle' | 'reading' | 'scored' | 'listening' | 'playing'

export interface AttemptSummary {
  readonly id: string
  readonly passed: boolean
  readonly wrongAttacks: number
  readonly groupsFirstPass: number
  readonly groupsTotal: number
  readonly completionTimeSec: number | null
  readonly expectedTimeSec: number | null
  readonly assistance: 'none' | 'names' | 'keyboard'
  readonly persistentLabels: boolean
  /** Consecutive passed attempts in this run (Repeat target). */
  readonly streak: number
  readonly targetReached: boolean
  /** What the speed ladder did after this attempt (absent when it did nothing). */
  readonly ladder?: {
    /** The next attempt is prepared at this faster speed. */
    readonly climbedTo?: number
    /** The next attempt is prepared at this slower speed. */
    readonly droppedTo?: number
    /** The target was met at the goal: the climb is over. */
    readonly done?: boolean
  }
  /**
   * Keep time (strict transport) only: how the attempt kept time (`timingAccuracy`), shown in
   * place of the completion time. Absent for gated attempts.
   */
  readonly timing?: AttemptTiming
}

/** How a Keep time attempt kept time: groups judged and how many were on time, early, late, missed. */
export interface AttemptTiming {
  readonly groups: number
  readonly onTime: number
  readonly early: number
  readonly late: number
  readonly missed: number
}

/**
 * The speed ladder while it is set (Repeat mode, see `ladder.ts`). Speeds are multipliers.
 */
export interface LadderUi {
  readonly goal: number
  readonly step: number
  /** The speed when the ladder was switched on (or opened with): the floor for drops. */
  readonly start: number
  /** Consecutive failed attempts since the last pass, climb, drop or manual speed change. */
  readonly failures: number
  /** The target was met at the goal (or the speed was set at or above it). */
  readonly done: boolean
}

export interface Interruption {
  readonly reason: InterruptReason
  readonly text: string
  /** Reading can resume at the same position; scored attempts restart. */
  readonly canResume: boolean
}

/** Coarse state for the Preact view; changes on phase/selection/feedback-status changes only. */
export interface SessionUi {
  readonly activity: Activity
  readonly phase: Phase | null
  /** Start/Pause button state. */
  readonly playing: boolean
  readonly hands: HandSelection
  /**
   * False while no piano input is connected (U27): the hand toggles are off and unavailable and
   * the session is in Listen; the learner's hands come back with the piano.
   */
  readonly handsAvailable: boolean
  readonly range: PassageRange | null
  readonly multiplier: number
  readonly startAction: 'reading' | 'scored' | 'listen' | 'play'
  readonly startEnabled: boolean
  readonly startReason: string | null
  /** Ready blockers in words ("Release the keys to begin."). */
  readonly waiting: string | null
  readonly hintVisible: boolean
  readonly keyboardVisible: boolean
  readonly canHint: boolean
  readonly repeat: boolean
  /**
   * The current reading is a lead-in (Repeat mode, a seek anywhere but the loop start): unscored
   * reading until the music next arrives at the loop start (directly from before the loop, after
   * wrapping at the loop end or the piece end from inside or after it), where the scored attempt
   * over the loop takes over. False once the attempt is live. `startAction` stays 'scored'; the
   * main button reads Start, then Pause / Resume like reading.
   */
  readonly leadIn: boolean
  readonly repeatTarget: number | null
  /** The speed ladder, or null when off. It acts only while Repeat mode is open. */
  readonly ladder: LadderUi | null
  readonly lastResult: AttemptSummary | null
  /** Teacher's correction marks shown on the score now (0 when none), e.g. "3 points to improve". */
  readonly corrections: number
  readonly interruption: Interruption | null
  /** Output problems or loading ("Loading piano sounds…"). */
  readonly soundStatus: string | null
  readonly inputDisconnected: boolean
  /**
   * Play-through mode is on (DECISIONS P12): the cursor follows the music and the learner's
   * playing, wrong notes never block, nothing is graded or recorded.
   */
  readonly playThrough: boolean
  /**
   * Keep time (rhythm mode, DECISIONS P13) is on: every Start is a scored attempt played against
   * the music (strict transport), after a one-bar count-in. Exclusive with play-through.
   */
  readonly rhythm: boolean
  /** Beats left in the Keep time count-in (the number to show), else null. */
  readonly countIn: number | null
  /** Completed the whole piece in ordinary reading. */
  readonly finished: boolean
}

/** Frequently changing view state (cursor, current bar), read by small subscribed components. */
export interface SessionProgress {
  readonly position: number
  readonly occ: number
}

/**
 * A correction cue shown at the cursor, just left of it (U30 revised): an octave direction for a
 * right pitch class in the wrong octave, or the target's name with its accidental emphasized for
 * a key one semitone off on the same letter (F for F♯, F♯ for F♮).
 */
export type StageCue =
  | { readonly kind: 'octave'; readonly direction: 'up' | 'down' }
  | {
      readonly kind: 'accidental'
      /** The target's name per the naming settings, accidental always shown ("F♯4", "fa♮"). */
      readonly text: string
      /** The glyph to emphasize, contained in `text`: ♯, ♭, ♮, 𝄪 or 𝄫. */
      readonly accidental: string
    }

/** Wrong-key feedback; corrections are a cue at the cursor. */
export interface FeedbackState {
  readonly visible: boolean
  readonly reason: 'wrong' | 'early'
  readonly cue: StageCue | null
  readonly pulse: number
}

/** Keyboard guide state (published at most once per frame while it is visible, only on change). */
export interface GuideState {
  /** Highlighted keys of the 88-key guide, low to high (targets, sounding, held, wrong; U15). */
  readonly keys: readonly GuideKey[]
  readonly rollDirection: 'up' | 'down' | undefined
}

export type SessionSettings = Pick<
  AppSettings,
  'naming' | 'labels' | 'hints' | 'pedal' | 'route' | 'sound' | 'metronome'
> & {
  /** Keep time tolerance; absent (Study, which has no Keep time) = the engine default. */
  readonly rhythm?: AppSettings['rhythm']
}
