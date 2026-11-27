/**
 * Seams of the practice session: everything it talks to is an interface so the coordinator
 * runs in unit tests with a fake clock, fake MIDI, a fake strip and fake output.
 */
import type { MidiRouteEvent } from '../../core/midi/adapter'
import type { MidiInputEvent } from '../../core/midi/types'
import type { MidiOutputLike } from '../../core/midi/webmidi'
import type {
  AbandonEvent,
  AttemptRecord,
  InterruptReason,
  PassageRange,
  PracticeMode,
  TimingDirection,
} from '../../core/model/practice'
import type { LearnerHands, ScoreModel } from '../../core/model/score'
import type { Rational } from '../../core/music/rational'
import type { AppSettings } from '../../core/model/settings'
import type { Phase, Timeline } from '../../core/engine'
import type { SpotVisit } from '../../core/history'
import type { RepeatedMistake } from './mistakes'
import type { GroupMark } from './ranking'
import type { PassRecord } from './run'
import type { BrowserAudioModule, MetronomeModule, OutputBackend, TimerApi } from '../../core/playback'
import type { LadderSettings, ResumePosition } from '../../core/storage/records'
import type { GuideKey } from '../../render/keyboard/types'
import type { CorrectionMark, ReminderMark } from '../../render/strip/StripView'
import type { MetronomeScope } from './metronome'

/** The subset of `StripView` the session drives (render/strip/StripView.ts). */
export interface StripSink {
  setCursor(position: number, opts?: { smooth?: boolean }): void
  setTargets(notes: readonly number[]): void
  setAccepted(notes: readonly number[]): void
  /** Reserve space above the score while live timing feedback is enabled. */
  setTimingCue?(direction: TimingDirection | null, enabled: boolean): void
  setOttavaEmphasis(spans: readonly number[]): void
  setLabels(texts: ReadonlyMap<number, string>): void
  setLabelOpacity(opacity: ReadonlyMap<number, number>): void
  setLoop(range: PassageRange | null): void
  setLoopEditable(editable: boolean): void
  /**
   * Note onsets (exact, ascending) of the current hands that the dragged playhead and the loop
   * edges snap to (U19, U21). The same array again is a no-op.
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
   * Animate a return to `position` (a float whole-note position) after a pass. `rewind`
   * identifies the return to the opening after a whole piece finishes without Repeat.
   * Optional; without it the next `setCursor` jumps.
   */
  wrapTo?(position: number, opts?: { rewind?: boolean }): void
  /**
   * The teacher's corrections after a completed scored attempt (red-pen rings with "Wrong note",
   * "Too soon", "Too late"; `./corrections.ts`); `[]` clears them.
   */
  setCorrections?(marks: readonly CorrectionMark[]): void
  /**
   * Quiet highlighter reminders at recent mistake spots during the next pass (under the
   * engraving; `render/shared/reminders.ts`); `[]` clears them.
   */
  setReminders?(marks: readonly ReminderMark[]): void
  /**
   * The review after a completed pass (DECISIONS U97): on while its result shows, the strip zooms
   * out to show the whole loop; off, it zooms back in to the playing frame. `returnBy` is an
   * optional deadline on the performance clock for the zoom back in.
   */
  setReview?(on: boolean, returnBy?: number): void
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
  readonly mode?: PracticeMode
  readonly lastMultiplier?: number
  readonly lastHands?: LearnerHands
  readonly lastPassage?: PassageRange | null
  readonly resume?: ResumePosition | null
  readonly repeatTarget?: number | null
  readonly ladder?: LadderSettings | null
  /** Repeat mode is on (DECISIONS U98): Practice reopens it over `lastPassage`. */
  readonly repeatOpen?: boolean
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
  /**
   * How long a pass's completed final group stays open for a key pressed with that chord (the
   * engine's `finalSlipMs`, DECISIONS P24; a scored pass, or a whole-piece reading). Default
   * `CHORD_SLIP_MS`; the test harness passes 0 so scenario tests see the record at the final key, as
   * before.
   */
  readonly finalSlipMs?: number
  /**
   * How long after a bar's end Keep time judges it silent (DECISIONS U112), so a key press
   * stamped inside the bar but delivered late still counts. Default `KEEP_TIME_GRACE_MS`; the test
   * harness passes 0 so scenario tests see the stop at the barline, as before.
   */
  readonly keepTimeGraceMs?: number
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
  /**
   * Builds the microphone follower for Follow (DECISIONS P15, P22; `app/audio/micFollower.ts`,
   * tests inject a fake). Absent: Follow never uses the microphone.
   */
  readonly createMicFollower?: CreateMicFollower
  /**
   * Can this browser open a microphone at all (`microphoneSupported`; default true when
   * `createMicFollower` is supplied)? Without it, Follow needs a piano.
   */
  readonly micSupported?: () => boolean
  /** The device asks for less motion: Follow's drawn cursor then jumps as before (U162). Default: no. */
  readonly reducedMotion?: () => boolean
}

/** A position estimate from the microphone follower (float whole notes, confidence 0..1). */
export interface MicEstimate {
  readonly position: number
  readonly confidence: number
}

/** The microphone follower as the session drives it (`app/audio/micFollower.ts`). */
export interface MicFollowerLike {
  /** Opens the microphone (the browser may ask) and follows from `position`; rejects with a reason. */
  start(position: Rational): Promise<void>
  /** Expect the first group at or after `position` next (a seek, a resume). */
  reset(position: Rational): void
  /** Estimates stop until `resume` (the microphone stays open). */
  pause(): void
  /** Listen again: what sounded during the pause is forgotten. */
  resume(): void
  /** Closes the microphone. */
  dispose(): void
}

/**
 * `onEstimate`: the player was heard at a new place. `onLost`: the microphone stopped by itself
 * (unplugged, taken by the system) with a reason for the learner; the follower is of no more use.
 * `hands`: the hands the learner plays (absent: both); with one hand the follower listens for that
 * hand's onset groups only, the practice timeline's for the same hands (DECISIONS P22).
 * The follower needs no tempo and no speed: it follows the order of the notes only (DECISIONS P16).
 */
export type CreateMicFollower = (
  model: ScoreModel,
  onEstimate: (estimate: MicEstimate) => void,
  onLost: (reason: string) => void,
  hands?: LearnerHands,
) => MicFollowerLike

/** What the session needs from `MidiOutputBackend` beyond `OutputBackend`. */
export interface MidiBackendLike extends OutputBackend {
  humanInput(ev: MidiInputEvent): void
  resetHuman(): void
  disconnected(): void
  reconnect(output: MidiOutputLike, now: number): void
}

/**
 * What the session is doing (coarse; drives the footer and banners). `'playing'`: the mode is
 * Follow (DECISIONS P12), started or not.
 */
export type Activity = 'idle' | 'reading' | 'scored' | 'listening' | 'playing'

export interface AttemptSummary {
  readonly id: string
  /**
   * A Wait run outside Repeat that reached the end of the piece (DECISIONS U142): reading, so it has
   * no time and no streak, and it is not stored (the card has no numbers or earlier passes for it).
   */
  readonly run?: boolean
  readonly passed: boolean
  readonly wrongAttacks: number
  readonly groupsFirstPass: number
  readonly groupsTotal: number
  readonly completionTimeSec: number | null
  readonly expectedTimeSec: number | null
  /** Consecutive passed attempts in this run (Repeat target). */
  readonly streak: number
  readonly targetReached: boolean
  /** What the speed ladder did after this attempt (absent when it did nothing). */
  readonly ladder?: {
    /** The next attempt is prepared at this faster speed. */
    readonly climbedTo?: number
    /** The target was met at the goal: the climb is over. */
    readonly done?: boolean
    /** A clean pass with long pauses: the speed stays, and it was not a failure. */
    readonly held?: boolean
  }
  /**
   * Keep time (strict transport) only: how the attempt kept time (`timingAccuracy`), shown in
   * place of the completion time. Absent for gated attempts.
   */
  readonly timing?: AttemptTiming
  /**
   * The same wrong key at the same place in this pass and the passes before it (at least
   * `REPEATED_MISTAKE_PASSES` running, same place in the score, at any speed and in any loop that
   * contains it), most passes first; absent when none (DECISIONS P24). Word one with
   * `repeatedMistakeLine(m, model, naming)`: the result card's note line shows the first (U97).
   */
  readonly repeatedMistakes?: readonly RepeatedMistake[]
  /**
   * Outside Repeat, a run with mistakes: the bars the card's Loop action loops (`roughPassage`,
   * `PracticeSession.loopRoughBars`). Absent in Repeat, for a clean run, and when they would be the
   * whole run.
   */
  readonly rough?: PassageRange
}

/**
 * What the expanded result card ranks (DECISIONS U99, `PracticeSession.resultDetails`): the
 * inputs of `rankMistakes` (in `ranking.ts`, loaded with the card), as the session holds them.
 */
export interface ResultDetails {
  /** The pass the details are of (`AttemptSummary.id`; the last of `records`). */
  readonly attemptId: string
  /** The session's last passes (scored attempts, Wait runs), oldest first (a copy). */
  readonly records: readonly PassRecord[]
  /** The timeline the attempt ran on (its group indices). */
  readonly timeline: Timeline
  /** The attempt's correction mark per group (`correctionMarksByGroup`). */
  readonly marks: ReadonlyMap<number, GroupMark>
  /** Visit history per group index of `timeline`, only for groups with memory, up to and including this pass. */
  readonly spots: ReadonlyMap<number, readonly SpotVisit[]>
  /** Group indices of `timeline` played clean in this pass whose previous visit went wrong. */
  readonly fixed: readonly number[]
}

/** The mistake snippet playing in the expanded result card (DECISIONS U100). */
export interface SnippetState {
  /** The bar it plays. */
  readonly occ: number
  /** `played`: the learner's own presses replayed; `written`: the bar from the score. */
  readonly kind: 'played' | 'written'
  /** A long pause in the replay was shortened. */
  readonly shortened: boolean
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
  /** The target was met at the goal (or the speed was set at or above it). */
  readonly done: boolean
}

export interface Interruption {
  readonly reason: InterruptReason
  readonly text: string
  /** Reading can resume at the same position; scored attempts restart. */
  readonly canResume: boolean
}

/** Where the hand the app plays can sound: the connected piano, this device (U149). */
export interface OtherHandSound {
  readonly piano: boolean
  readonly device: boolean
}

/** Coarse state for the Preact view; changes on phase/selection/feedback-status changes only. */
export interface SessionUi {
  readonly activity: Activity
  readonly phase: Phase | null
  /** Start/Pause button state. */
  readonly playing: boolean
  /** The learner's mode (`PracticeSession.setMode`); it never changes by itself. */
  readonly mode: PracticeMode
  /** The hands the learner plays; in Listen, the hands they hear. */
  readonly hands: LearnerHands
  readonly range: PassageRange | null
  readonly multiplier: number
  readonly startAction: 'reading' | 'scored' | 'listen' | 'play'
  readonly startEnabled: boolean
  /**
   * Why the main button is disabled (`startPlan`), or null. With no piano connected
   * (`pianoConnected` false), in Wait and Keep time it always says that the mode needs one.
   */
  readonly startReason: string | null
  /**
   * `startEnabled` is false only because the app does not know where the hand it plays may sound
   * (P2): pressing Start asks (U149), with the places that are possible. Absent otherwise.
   */
  readonly otherHand?: OtherHandSound
  /** Ready blockers in words ("Release the keys to begin."). */
  readonly waiting: string | null
  readonly hintVisible: boolean
  readonly keyboardVisible: boolean
  readonly canHint: boolean
  /** Repeat mode is open. Never in Follow, which brings it back as it was when it is left. */
  readonly repeat: boolean
  /** An open loop can start from its beginning while playback is stopped. */
  readonly canRestartLoop: boolean
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
  /** Active spot drill: `returnText` names the passage `endDrill` returns to, or null when not drilling. */
  readonly drill: { readonly returnText: string } | null
  readonly lastResult: AttemptSummary | null
  /**
   * The next pass has played its first correct note while `lastResult` still shows (U101): the
   * strip is back at the playing frame and the pill is dimmed (a tap brings it back to full
   * strength) until the cursor leaves that bar, when the result goes (`resultExit` 'played').
   */
  readonly resultDimmed: boolean
  /**
   * How the last result went (or goes): 'played' when the next pass played past it (U101, it
   * slides away), 'dismissed' for anything else (it fades).
   */
  readonly resultExit: 'played' | 'dismissed'
  /**
   * The score reviews the loop after a completed pass (U97), until the first correct note (U101)
   * or the last two beats of the Keep time count-in (U103). Focus mode waits meanwhile (U102).
   */
  readonly reviewing: boolean
  /** Teacher's correction marks shown on the score now (0 when none), e.g. "3 points to improve". */
  readonly corrections: number
  readonly interruption: Interruption | null
  /** Output problems or loading ("Loading piano sounds…"). */
  readonly soundStatus: string | null
  readonly inputDisconnected: boolean
  /**
   * The microphone follower's status while Follow uses it (DECISIONS P15): starting, following, or
   * why it could not start; null otherwise.
   */
  readonly micStatus: string | null
  /**
   * What Follow follows (DECISIONS P22, P37): `'mic'` without a piano input (where the browser can
   * use a microphone); else `'piano'`.
   */
  readonly follow: 'piano' | 'mic'
  /** A piano input is connected (Wait and Keep time can start; Follow follows its keys). */
  readonly pianoConnected: boolean
  /** This browser can open a microphone (Follow's choice offers Microphone). */
  readonly micSupported: boolean
  /** Clicks left in the Keep time count-in (the number to show), else null. */
  readonly countIn: number | null
  /** Which Metronome preference the mode uses, so the menu's switch edits the right one (DECISIONS P20). */
  readonly metronomeScope: MetronomeScope
  /** Follow through the microphone: the metronome is silent whatever its setting (DECISIONS P16). */
  readonly metronomeMuted: boolean
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
  | { readonly kind: 'retry' }
  | { readonly kind: 'once-more' }
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
  /** Keep time tolerance; absent = the engine default. */
  readonly rhythm?: AppSettings['rhythm']
}
