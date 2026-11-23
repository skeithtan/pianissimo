import { msg } from '../../i18n/messages'
/**
 * The practice session coordinator (WP10): wires MIDI input → engine → transport → renderer →
 * storage for one piece. Framework-free; every dependency is injected (`SessionDeps`).
 *
 * Input path (spec "Execution and rendering architecture"): each human MIDI event goes to the
 * MIDI output backend's human-held guard and to `engine.input` immediately and in order; the
 * engine's events are drained at once (gate releases go to the transport synchronously,
 * records are queued O(1)); everything visual waits for one requestAnimationFrame. No store
 * the Preact view subscribes to changes per MIDI event: `ui` changes only on coarse state
 * changes, `progress` / `feedback` / `guide` at most once per frame.
 *
 * Modes (DECISIONS P1, U9, U10): with Repeat mode closed, Start = ordinary reading from the
 * current position; with Repeat mode open, Start = a scored attempt over the loop, repeated
 * (the loop is remembered while Repeat is closed). Both hands off = Listen (Preview); a hand
 * back on returns to practice. Playback goes to the piano, or this device without one (Auto, S4).
 * All practice follows a gated musical transport. Both hands uses a silent transport; one-hand
 * practice adds the automatic part. The score holds at each learner onset until it is played.
 *
 * Lead-in (Repeat mode): a seek before the loop reads, unscored, from there to the loop start
 * on one transport over [lead-in, loop end); when the lead-in's last group is done the scored
 * attempt over the loop takes over at once and the music plays on into it (its gates follow the
 * lead-in's). Repeats then use the loop's own transport. A seek inside the loop (or after it)
 * reads, unscored, from there to the loop end (or the piece end), then wraps to the loop start
 * where the attempt is live at once on the loop's own transport.
 *
 * Play-through (DECISIONS P12): a performance aid beside the engine, wired like Listen. Its own
 * gated transport over the whole piece and a `PlayFollower` (core/engine/follow.ts) that decides
 * when each gate is released: the group was played, the learner moved on to one of the next
 * groups, or the patience after the transport's arrival ran out. Human events go to the
 * follower instead of the engine; the engine stays paused at its position and records nothing.
 *
 * Keep time (rhythm mode, DECISIONS P13): every Start is a scored attempt on the strict transport
 * (over the loop in Repeat mode, else from the cursor to the end). When the engine is Ready a one-bar
 * count-in clicks through the metronome sink; at its end the transport plays and the engine's
 * clock starts at the same timestamp. The music never waits: every gate is released (ahead of
 * time, so timer jitter never delays the music) and each arrival is reported to the engine, which
 * judges every group against it. Exclusive with play-through; lead-ins are off.
 */
import {
  CHORD_SLIP_MS,
  DEFAULT_RHYTHM_TOLERANCE_MS,
  DEFAULT_WRONG_FEEDBACK_MS,
  PlayFollower,
  PracticeEngine,
  comparisonContextOf,
  fadeOutOpacity,
  groupAtOrAfter,
  transportGates,
  type EngineEvent,
  type EngineState,
  type Phase,
  type RhythmParams,
  type Timeline,
  type TransportKind,
} from '../../core/engine'
import { groupReached } from '../../core/audio/groups'
import { timingAccuracy } from '../../core/history'
import { HintPedalTrigger } from '../../core/midi/hintPedal'
import { NATURAL, labelFor, labelForMidi } from '../../core/naming'
import type { MidiRouteEvent } from '../../core/midi/adapter'
import { CC_ALL_NOTES_OFF, type MidiInputEvent } from '../../core/midi/types'
import { onsetPositions, passageFromBounds, passageKey, samePassage } from '../../core/model/passage'
import { contextKey, type AttemptRecord, type InterruptReason, type PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import type { LadderSettings } from '../../core/storage/records'
import { type Rational, ZERO, add, eq, key as ratKey, lt, toNumber } from '../../core/music/rational'
import { hasTempo, secondsBetween, type TempoMapData } from '../../core/music/tempo'
import {
  buildClickTrack,
  buildPerformance,
  createTransport,
  passageRange,
  type ClickEvent,
  type BrowserAudioModule,
  type ControlEvent,
  type MetronomeModule,
  type MetronomeSink,
  type NoteOffEvent,
  type NoteOnEvent,
  type OutputBackend,
  type Transport,
} from '../../core/playback'
import { metronomeAudioOutput } from '../../core/playback/webaudio/metronomeOutput'
import { PersistentLabels, labelSnapshot, mergeOpacity, sameOpacity } from './labels'
import {
  accompanimentAllowed,
  defaultMidiBackend,
  hasSoundOutput,
  humanGuardEnabled,
  noPlaybackReason,
  outputKey,
  performanceKey,
  playbackDestination,
  type PlaybackKind,
} from './output'
import { clampPassage, sameSelection, selectionTimeline, startPlan, type Selection, type StartPlan } from './selection'
import { buildGuideKeys, sameGuideKeys } from './guide'
import { correctionMarks, correctionMarksByGroup, type CorrectionMark } from './corrections'
import { REPEATED_MISTAKE_HISTORY, repeatedMistakes } from './mistakes'
import { PassCapture, SNIPPET_PEDALS, SnippetPlayer, playedSnippet, writtenSnippet, type SnippetKind } from './snippets'
import { countInPlan } from './countIn'
import { metronomeOn, metronomeScope, type MetronomeScope } from './metronome'
import { PerformanceTiming, TimingDrift } from './timingDrift'
import {
  fullSpeedLadderStart,
  LADDER_DEFAULT_TARGET,
  LADDER_FULL_SPEED_GOAL,
  ladderAfterAttempt,
  sameLadder,
  startLadder,
} from './ladder'
import { Store, shallowEqual } from './store'
import type {
  Activity,
  AttemptSummary,
  FeedbackState,
  FlashSink,
  GuideState,
  Interruption,
  LadderUi,
  MicEstimate,
  MicFollowerLike,
  MidiBackendLike,
  ResultDetails,
  SnippetState,
  SessionDeps,
  SessionProgress,
  SessionSettings,
  SessionUi,
  StageCue,
  StripSink,
} from './types'

export interface SessionOptions {
  readonly pieceId: string
  /** The practice model (a user-supplied tempo already applied, see `practiceModel`). */
  readonly model: ScoreModel
  readonly selection: Selection
  readonly settings: SessionSettings
  /** Reading starts here (resume position); default: the start of the selection. */
  readonly startPosition?: Rational | null
  readonly repeatTarget?: number | null
  /** The piece's speed ladder (Repeat mode). Default: off. */
  readonly ladder?: LadderSettings | null
  /**
   * Open with Repeat mode on (a preset passage, DECISIONS U10). `selection.range` is the loop;
   * without one the loop starts at the first bar. Default: closed (reading), loop remembered.
   */
  readonly repeat?: boolean
  /**
   * Show the cursor's repeat button (DECISIONS U14). Default true; Study mode (U72) has no
   * Repeat, so it passes false and the button never appears in either score view.
   */
  readonly cursorAction?: boolean
  /** Open with Keep time on (the piece's saved choice; ignored without a numerical tempo). */
  readonly rhythm?: boolean
}

/** The Keep time count-in in progress (`#beginCountIn`). */
interface CountIn {
  /** Real time of the first click. */
  readonly start: number
  readonly beats: number
  readonly beatMs: number
  /** Clicks left to count, the number shown (`ui.countIn`). */
  remaining: number
  timer: unknown
  /**
   * Presses from `from` (the planned downbeat minus the tolerance) on: the first downbeat played
   * early, or on time before this count-in's end reaches the session. `#endCountIn` judges them as
   * the first group's and credits them to the first bar. A ring of `COUNT_IN_PRESSES` (time, key,
   * velocity), oldest overwritten; nothing is allocated per press.
   */
  readonly from: number
  readonly pressTimes: Float64Array
  readonly pressNotes: Uint8Array
  readonly pressVelocities: Uint8Array
  pressHead: number
  pressCount: number
}

interface RepeatOpening {
  readonly end: number
  readonly pitches: ReadonlySet<number>
  readonly waitAnotherPass: boolean
}

/**
 * The silent-bar check of a Keep time pass (DECISIONS U112): its playable bar windows, measured
 * from the count-in downbeat on the attempt's schedule. Every time is compared after taking off
 * the transport's stall shift (`#keepTimeShift`), so the windows follow the music the engine grades.
 */
interface KeepTimeActivity {
  readonly bars: readonly { readonly start: number; readonly end: number }[]
  /** Bars credited with a key press (1), by index; one allocation per pass. */
  readonly played: Uint8Array
  /** The first bar not judged yet. */
  bar: number
  /** A press up to this many ms before a bar's start also counts for it: the Keep time tolerance. */
  readonly early: number
  opening: RepeatOpening | null
  /** The final scoring window can close before the last playable bar ends. */
  completed: AttemptRecord | null
}

/**
 * A lead-in (Repeat mode): unscored reading from `start` until the music next arrives at the loop
 * start, which turns into the scored attempt over the loop there. From before the loop it reads
 * up to the loop start and hands over on one transport; from inside the loop (or after it) it
 * reads to the loop end (or the piece end) and then wraps to the loop start (`wrap`).
 */
interface LeadIn {
  readonly start: Rational
  /**
   * The lead-in passage and its reading timeline: `[start, loop start)` before the loop,
   * `[start, loop end)` inside it, `[start, piece end)` after it.
   */
  readonly passage: PassageRange
  timeline: Timeline
  /**
   * What the lead-in transport and the keyboard guide cover: `[start, loop end)` before the loop
   * (the loop's gates follow the lead-in's), else the passage itself.
   */
  readonly span: PassageRange
  /** It starts inside or after the loop: at the passage end the music wraps to the loop start. */
  readonly wrap: boolean
  /** The scored attempt took over (the transport may still be the lead-in one). */
  handedOver: boolean
}

/**
 * Play-through (DECISIONS P12) once started: its gated transport over the whole piece, the
 * follower that releases the gates, and the output it was built for ('' when it plays nothing:
 * both hands, or the microphone follows).
 */
interface PlayThrough {
  readonly transport: Transport
  readonly follower: PlayFollower
  readonly timing: PerformanceTiming | null
  playing: boolean
  readonly outputKey: string
  /** Built to follow the microphone (DECISIONS P22): silent, and the piano's keys do not move it. */
  readonly mic: boolean
}

/** What the keyboard guide reads from the engine or the play-through follower. */
type GuideSource = Pick<EngineState, 'targetNotes' | 'acceptedPitches' | 'heldKeys' | 'heldWrongKeys'>

/**
 * Keep time judges a bar silent this long after its end (DECISIONS U112). A Note On carries the
 * time the system received it (`MIDIMessageEvent.timeStamp`) but reaches `#keepTimePress` only once
 * the main thread is free, while the bar-end check is a timer: a busy frame on the reference tablet
 * (layout, garbage collection) holds both for tens of milliseconds and may run the timer first, and
 * Bluetooth MIDI can stamp a press up to a connection interval (tens of ms) before delivering it.
 * 100 ms covers both with margin, delays an unattended stop imperceptibly, and stays below the
 * transport's 250 ms stall threshold, beyond which the music itself moves later and the bar windows
 * move with it (`Transport.shiftMs`).
 */
export const KEEP_TIME_GRACE_MS = 100
/** Presses kept from the count-in's last stretch: a chord on the downbeat and a slip or two. */
const COUNT_IN_PRESSES = 16
const RESUME_SAVE_MS = 5000
/** Estimates below this confidence never move the cursor (about 0.5 on synthetic audio; tune on recordings). */
const MIC_CONFIDENCE = 0.5
const MIC_STARTING = 'Starting the microphone…'
const MIC_LISTENING = 'Following through the microphone.'
const MIC_FAILED_TEXT = 'The microphone could not be started.'

const ACTIVE: readonly Phase[] = ['preparing', 'ready', 'running']
const RETRY_CUE: StageCue = { kind: 'retry' }
/** How long `revealAtCursor` names stay when hints are set to last until the correct note (no attempt here). */
export const REVEAL_FALLBACK_S = 4

const INTERRUPT_TEXT: Readonly<Record<InterruptReason, string>> = {
  // Never shown: the main button reads Resume / Start after a pause (no banner).
  pause: 'Paused.',
  seek: 'Moving through the score stopped the attempt.',
  disconnect: 'The piano was disconnected, so the attempt stopped.',
  suspend: 'Practice was interrupted.',
  'setting-change': 'A label setting changed, so the attempt stopped.',
  'layout-change': 'The score layout changed, so the attempt stopped.',
  'tempo-change': 'The speed changed, so the attempt stopped.',
  'hand-change': 'The hands changed, so the attempt stopped.',
  'range-change': 'The passage changed, so the attempt stopped.',
  'mode-change': 'Practice switched mode.',
  'user-stop': 'Stopped.',
  'user-restart': 'Restarted.',
}

export class PracticeSession {
  readonly ui: Store<SessionUi>
  readonly progress: Store<SessionProgress>
  readonly feedback: Store<FeedbackState>
  readonly guide: Store<GuideState>

  readonly #deps: SessionDeps
  readonly #model: ScoreModel
  readonly #tempo: TempoMapData
  readonly #labels: PersistentLabels
  readonly #engine: PracticeEngine
  #settings: SessionSettings
  #sel: Selection
  #timeline: Timeline
  #cursorPassage: { selection: Timeline; timeline: Timeline } | null = null

  #strip: StripSink | null = null
  #flash: FlashSink | null = null

  // Output and transports
  #output: OutputBackend | null = null
  #midiBackend: MidiBackendLike | null = null
  #monitor: ((ev: MidiInputEvent) => void) | null = null
  /** `#output` when it is browser sound (its volume follows the settings). */
  #browser: ReturnType<BrowserAudioModule['createBrowserAudio']> | null = null
  /** `outputKey` and kind of `#output` ('' / null while there is none). */
  #outputKey = ''
  #outputKind: PlaybackKind | null = null
  #outputLoading: Promise<OutputBackend | null> | null = null
  #accomp: Transport | null = null
  #accompKey = ''
  #metronome: InstanceType<MetronomeModule['WebAudioMetronome']> | null = null
  /** The latest metronome request still running; later ones wait for it (`#ensureMetronome`). */
  #metronomeLoading: Promise<void> | null = null
  /** Counts the sink's cancels, so a settings change can tell whether it silenced a count-in. */
  #sinkCancels = 0
  /** Click schedules exist from the start; sound can be enabled later without rebuilding time. */
  readonly #metronomeSink: MetronomeSink = {
    click: (time, accent) => this.#metronome?.click(time, accent),
    cancel: (now) => {
      this.#sinkCancels++
      this.#metronome?.cancel(now)
    },
  }
  /** Listen (both hands off): its transport and the output it was built for. */
  #listen: { transport: Transport; playing: boolean; outputKey: string } | null = null
  /** Play-through mode is on (DECISIONS P12), started or not. */
  #playThrough = false
  /**
   * The learner switched play-through on (`setPlayThrough`). Without a piano it is on whenever a
   * hand is selected (DECISIONS P22); this is what it returns to when the piano comes back.
   */
  #playThroughChosen = false
  /** Keep time was switched off (not saved) because play-through took over without a piano: back with the piano. */
  #rhythmHeld = false
  /**
   * Repeat mode was closed (not saved) because play-through took over without a piano (DECISIONS
   * U98): it reopens over the remembered loop when the piano comes back. Cleared whenever Repeat
   * opens and when the loop is cleared.
   */
  #repeatHeld = false
  /** Play-through once started (Start in play-through); null before and after the mode. */
  #play: PlayThrough | null = null
  /** A play-through was replaced (hands, output) while paused mid-piece: the main button reads Resume. */
  #playResumable = false
  /** Follower state version drawn last (`#framePlay`). */
  #playVersion = -1
  #playProcessing = false
  #playAgain = false
  /** The hint pedal while the follower has the input (the engine's own detector never sees it). */
  #playPedal: HintPedalTrigger | null = null
  /** The microphone follower while play-through uses it (DECISIONS P15). */
  #mic: MicFollowerLike | null = null
  /** Its status for the view: starting, following, or why it could not start. */
  #micStatus: string | null = null
  /** A piano input is connected (`setInputAvailable`). */
  #inputAvailable = true
  /** Keep time (rhythm mode, DECISIONS P13) is on. */
  #rhythm: boolean
  /** The Keep time count-in in progress, else null. */
  #countIn: CountIn | null = null
  /** Groups the music passed (Keep time) since the last frame: the soft wash. */
  #missedPending = 0
  /** The text of an interruption the session caused (the Keep time tolerance changed). */
  #interruptText: string | null = null

  // Lifecycle
  #readingStarted = false
  #awaitPrepared = false
  #pendingRepeat = false
  #secondOpeningBarOnWrap = false
  #keepTimeActivity: KeepTimeActivity | null = null
  /** `SessionDeps.keepTimeGraceMs`. */
  readonly #keepTimeGrace: number
  /** The practice transport's `shiftMs` when it last played (`#keepTimeShift`). */
  #shift = 0
  /** Repeat mode (U10): loop controls shown, Start = scored attempts over `#loop`, repeated. */
  #repeat = false
  /** The loop, remembered while Repeat mode is closed (saved as `lastPassage`). */
  #loop: PassageRange | null = null
  #repeatTarget: number | null
  /** The speed ladder's settings (persisted) and its state, or null when off. */
  #ladderSettings: LadderSettings | null
  #ladder: LadderUi | null
  /** The speed the ladder set for the next attempt, applied when the Repeat reset comes. */
  #ladderNext: number | null = null
  /** A lead-in before the loop (Repeat mode), until the attempt it leads into is replaced. */
  #leadIn: LeadIn | null = null
  /** Passage keys of lead-ins: their reading traversals are not recorded. */
  readonly #leadInKeys = new Set<string>()
  /** `#accomp` is a lead-in transport: the lead-in's gates, then the loop's. */
  #accompLead = false
  /** Engine group i is transport gate i + this (the lead-in's group count once the attempt took over). */
  #gateOffset = 0
  #streak = 0
  #lastResult: AttemptSummary | null = null
  /**
   * The next pass played its first correct note while the last result shows (U101): the bar of
   * that note (the result goes once the cursor leaves it). Null: the result is still at full
   * strength, whatever keys were pressed. Reset by each new result.
   */
  #resultPlayedIn: number | null = null
  /** The next Keep time pass's downbeat once its count-in ends review. Reset by each new result. */
  #reviewReturnBy: number | null = null
  /** How the last result went: played past by the next pass (U101), or dismissed any other way. */
  #resultExit: 'played' | 'dismissed' = 'dismissed'
  /** Recent scored records of one comparison context, oldest first (repeated mistakes, P24). */
  #recentScored: AttemptRecord[] = []
  /** The completed record whose repeated mistakes the next UI publish works out, and its timeline. */
  #repeatedPending: { readonly id: string; readonly timeline: Timeline } | null = null
  /** The timeline the last result's record ran on (its group indices), for `resultDetails` (U99). */
  #resultTimeline: Timeline | null = null
  /** The history up to that completed pass, even if the next repeat is interrupted. */
  #resultRecords: readonly AttemptRecord[] = []
  /** The key events of the pass being played and of the last completed one (U100), never stored. */
  readonly #capture = new PassCapture()
  /** The mistake snippet playing (U100), with whether its echo is filtered from the input. */
  #snippet: { readonly player: SnippetPlayer; readonly echo: boolean } | null = null
  /** Which mistake snippet plays (the expanded result card shows it), or null. */
  readonly snippet = new Store<SnippetState | null>(null, (a, b) => a?.occ === b?.occ && a?.kind === b?.kind)
  /** Teacher's marks of the last completed scored attempt. */
  #corrections: readonly CorrectionMark[] = []
  /** Keep time hides the marks at the downbeat and restores them if the automatic repeat stops. */
  #correctionsVisible = true
  #inputDisconnected = false
  /** The learner's hands, held while no piano input is connected (the session is in Listen, U27). */
  #heldHands: HandSelection | null = null
  #soundStatus: string | null = null
  #completedPending = false
  #lockState = ''
  /** The review last asked of the strip (`strip.setReview`, U97); null: not asked yet. */
  #reviewShown: boolean | null = null

  // Frame and timers
  #frameHandle: unknown = null
  #tickHandle: unknown = null
  #tickAt = Infinity
  #lastVersion = -1
  #wrongPending = 0
  #wrongReason: 'wrong' | 'early' = 'wrong'
  /** The correction cue at the cursor and the missing pitch it points to (U30 revised). */
  #cue: { target: number; cue: StageCue } | null = null
  readonly #timingDrift = new TimingDrift()
  readonly #practiceTiming = new PerformanceTiming()
  /** The chrome is revealed (not in focus mode): the cursor's repeat button may show while playing. */
  #chromeRevealed = true
  /** The cursor's repeat button exists at all (`SessionOptions.cursorAction`). */
  readonly #cursorActionAllowed: boolean
  /**
   * Names revealed on request at the cursor (`revealAtCursor`, Study mode U72): the notes and
   * the real time they are gone by. They fade out over `hints.fadeMs` before `until`.
   */
  #reveal: { readonly notes: readonly number[]; readonly until: number } | null = null
  #lastReveal: ReadonlyMap<number, number> = new Map()
  #pulse = 0
  #lastPersistent: ReadonlyMap<number, number> | null = null
  #lastTemp: ReadonlyMap<number, number> = new Map()
  #labelsDirty = true
  #emitQueue: { time: number; ev: NoteOnEvent | NoteOffEvent }[] = []
  readonly #sounding = new Map<number, readonly number[]>()
  #soundingDirty = false
  #lastResumeSave = -Infinity
  #processing = false
  /** Records ending while this is set are dropped: the learner browsed away from them (U41). */
  #discarding = false
  #again = false
  #disposed = false
  /** An overlay (Settings, Connection) is open: keys go to it, never to the engine. */
  #inputHeld = false
  /** The Start in progress (`start`): sounds may be loading. */
  #starting: Promise<void> | null = null
  /** Bumped by every Pause: a Start still loading sounds when it changes starts nothing. */
  #startGen = 0
  /** `#startGen` when the Start in `#starting` began. */
  #startingGen = 0
  /** Accepted seeks supersede a Listen resume position captured before sounds finish loading. */
  #lastSeek: { position: Rational } | null = null
  /**
   * A strip browse gesture began while something played (U95): sound holds until the finger lifts
   * (`browseReleased`), then playback continues from the note under the fixed cursor line, as Start
   * after browsing does. `from`: where it played (`#continueFrom`), for a loop change meanwhile
   * (U94). Any Pause, an explicit Start or a loop change ends the hold.
   */
  #browseHold: { readonly from: Rational | null } | null = null
  /** Both hands' onset groups for the keyboard guide (U20); rebuilt on first use per selection. */
  #bothTimeline: Timeline | null = null
  /** Snap onsets of the current hands for the strip (U19), rebuilt when the hands change. */
  #snaps: { hands: HandSelection; onsets: readonly Rational[] } | null = null
  /**
   * Key feedback while nothing plays (DECISIONS U37): the session checks held keys against the
   * current group. The score marks accepted notes, and the guide also marks wrong keys.
   */
  readonly #previewAccepted = new Set<number>()
  readonly #previewWrong = new Set<number>()
  #previewDirty = false
  /** The timeline and group the preview was judged against; another one clears it. */
  #previewTimeline: Timeline | null = null
  #previewGroup: number | null = null
  readonly #unsubs: (() => void)[] = []

  constructor(options: SessionOptions, deps: SessionDeps) {
    this.#deps = deps
    this.#model = options.model
    this.#tempo = options.model.tempo
    this.#settings = options.settings
    this.#keepTimeGrace = Math.max(0, deps.keepTimeGraceMs ?? KEEP_TIME_GRACE_MS)
    this.#rhythm = options.rhythm === true && hasTempo(options.model.tempo)
    this.#loop = clampPassage(options.model, options.selection.range)
    this.#repeat = options.repeat === true
    if (this.#repeat && !this.#loop) this.#loop = { fromOcc: 0, toOcc: 0 }
    this.#sel = { ...options.selection, range: this.#repeat ? this.#loop : null }
    this.#repeatTarget = options.repeatTarget ?? null
    this.#ladderSettings = options.ladder ?? null
    this.#ladder = this.#ladderSettings ? startLadder(this.#ladderSettings, this.#sel.multiplier) : null
    this.#cursorActionAllowed = options.cursorAction !== false
    this.#timeline = selectionTimeline(this.#model, this.#tempo, this.#sel)
    this.#labels = new PersistentLabels(
      this.#model.notes,
      options.settings.labels,
      options.settings.naming,
      options.settings.hints.fadeMs,
    )
    const now = deps.clock()
    const startGroup = options.startPosition ? groupAtOrAfter(this.#timeline, options.startPosition) : 0
    this.#engine = new PracticeEngine(
      this.#timeline,
      {
        mode: 'reading',
        transport: 'accompaniment',
        pieceId: options.pieceId,
        hints: options.settings.hints,
        labelSettings: labelSnapshot(options.settings.labels),
        hintPedal: this.#hintPedal(options.settings),
        hintPedalAction: options.settings.pedal.hintPedalAction,
        timeOrigin: deps.timeOrigin ?? 0,
        startGroup,
        startPaused: true,
        // A key pressed with a pass's final chord is still counted (P24).
        finalSlipMs: deps.finalSlipMs ?? CHORD_SLIP_MS,
      },
      now,
    )
    this.ui = new Store<SessionUi>(this.#computeUi(), shallowEqual)
    this.progress = new Store<SessionProgress>(this.#computeProgress(), shallowEqual)
    this.feedback = new Store<FeedbackState>({ visible: false, reason: 'wrong', pulse: 0, cue: null }, shallowEqual)
    this.guide = new Store<GuideState>(
      { keys: [], rollDirection: undefined },
      (a, b) => a.rollDirection === b.rollDirection && sameGuideKeys(a.keys, b.keys),
    )

    this.#unsubs.push(deps.midi.subscribe((ev) => this.#onMidi(ev)))
    this.#unsubs.push(deps.midi.onRoute((ev) => this.#onRoute(ev)))
    this.#unsubs.push(deps.midi.registerSoundOwner(() => this.#stopSound()))
    this.#process(now)
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────────────

  get engine(): PracticeEngine {
    return this.#engine
  }

  get timeline(): Timeline {
    return this.#timeline
  }

  /** The effective selection (`range` is the loop in Repeat mode, else null). */
  get selection(): Selection {
    return this.#sel
  }

  /** The remembered loop, also while Repeat mode is closed. */
  get loop(): PassageRange | null {
    return this.#loop
  }

  get model(): ScoreModel {
    return this.#model
  }

  /** Label texts for the strip (all notes; visibility is per-frame opacity). */
  get labelTexts(): ReadonlyMap<number, string> {
    return this.#labels.texts
  }

  isPersistentLabel(note: number): boolean {
    return this.#labels.isEligible(note)
  }

  // ── Strip and flash ───────────────────────────────────────────────────────────────────

  /** The prepared strip is mounted: push the whole visual state, then keep it updated per frame. */
  attachStrip(strip: StripSink): void {
    this.#strip = strip
    // The cue row first, so the new view never lays out a frame without it (U122); the frame
    // below adds the cue itself.
    strip.setTimingCue?.(null, this.#timingRowEnabled())
    this.#lastVersion = -1
    this.#lockState = ''
    this.#reviewShown = null
    this.#lastPersistent = null
    this.#labelsDirty = true
    strip.setLabels(this.#labels.texts)
    if (this.#correctionsVisible && this.#corrections.length) strip.setCorrections?.(this.#corrections)
    this.#applySelectionVisuals()
    this.#syncLock()
    this.#frame(this.#deps.clock(), true)
    const now = this.#deps.clock()
    this.#reportVisibleLabels(now)
    this.#tryPrepared(now)
    this.#process(now)
  }

  /** The strip goes away (re-preparing the layout, leaving the view). */
  detachStrip(): void {
    this.#strip = null
    // No strip, no release to wait for (U95): a hold ends as a Pause.
    if (this.#browseHold) {
      this.#browseHold = null
      this.#publishUi()
    }
  }

  attachFlash(flash: FlashSink | null): void {
    this.#flash = flash
  }

  /** `StripView.onVisibleLabels`: persistent labels that came into view are assistance (E1). */
  onVisibleLabels(added: readonly number[]): void {
    const now = this.#deps.clock()
    const persistent = added.filter((n) => this.#labels.isEligible(n))
    if (persistent.length === 0) return
    this.#engine.recordPersistentLabelExposure(persistent, now)
    this.#process(now)
  }

  // ── Main controls ─────────────────────────────────────────────────────────────────────

  /** Start / Pause button. */
  togglePlay(): void {
    // A browse hold reads Pause (U95): pressing it cancels the continuation.
    if (this.#isPlaying() || this.#browseHold) this.pause()
    else void this.start()
  }

  /** Study's two transport actions share the cursor and replace each other's sound or input. */
  toggleStudyPlayback(action: 'listen' | 'follow', hands: Exclude<HandSelection, 'none'> = 'both'): void {
    if (this.#disposed || this.#inputHeld) return
    const follow = action === 'follow'
    if (follow && !this.#inputAvailable && !this.#micPossible()) return
    if (follow === this.#playThrough) {
      this.togglePlay()
      return
    }
    const position = this.#onsetAtOrAfter(this.#cursorPosition()) ?? ZERO
    this.pause()
    this.setSelection({ hands: follow ? hands : 'none' })
    if (follow) this.setPlayThrough(true)
    this.seekPosition(position)
    void this.start()
  }

  /**
   * Start reading, a scored attempt or Preview, per the selection. One Start at a time: a second
   * one while sounds load joins the first (it would otherwise stop the transport the first one
   * started at Ready), unless a Pause canceled the first meanwhile: then it runs after it.
   */
  start({ fromLoopStart = false }: { readonly fromLoopStart?: boolean } = {}): Promise<void> {
    // A Start (also the release of a browse hold) is what the hold waited for.
    this.#browseHold = null
    this.#unlockAudio()
    if (this.#starting && this.#startingGen === this.#startGen) return this.#starting
    const before = this.#starting
    const gen = (this.#startingGen = this.#startGen)
    // Queued behind a canceled Start: a Pause meanwhile cancels this one too.
    const queued = () => (this.#startCanceled(gen) ? undefined : this.#start(fromLoopStart))
    const run: Promise<void> = (before ? before.then(queued) : this.#start(fromLoopStart)).finally(() => {
      if (this.#starting === run) this.#starting = null
    })
    this.#starting = run
    return run
  }

  async #start(fromLoopStart: boolean): Promise<void> {
    const gen = this.#startGen
    const first = this.#plan()
    if (!first.enabled) return
    if (first.action === 'play') {
      await this.#startPlay()
      return
    }
    this.#followBrowsedCursor()
    this.#clearCorrections()
    if (first.action === 'listen') {
      await this.#startListening(fromLoopStart)
      return
    }
    if (this.#listen) this.#stopListening()
    if (!this.#practiceSilent()) {
      const output = await this.#ensureOutput()
      if (!output || this.#startCanceled(gen)) return
    }
    // Keep time counts in through the metronome even when the Metronome setting is off.
    await this.#ensureMetronome(this.#rhythm)
    if (this.#startCanceled(gen)) return
    // The selection may have changed while sounds loaded (the loop cleared, the hands changed).
    this.#followBrowsedCursor()
    const plan = this.#plan()
    if (!plan.enabled) return
    if (plan.action === 'listen') {
      await this.#startListening(fromLoopStart)
      return
    }
    if (plan.action === 'play') {
      await this.#startPlay()
      return
    }
    // A changed selection may need browser sound that has yet to load.
    if (!this.#practiceSilent() && !this.#ensureOutputSync()) return this.#start(fromLoopStart)
    const t = this.#deps.clock()
    const lead = this.#leadIn
    if (lead && !lead.handedOver && this.#engine.mode === 'reading') {
      this.#ensureAccompaniment()
      this.#startLeadIn(t)
    } else if (plan.action === 'scored') {
      // A new run: the Repeat reset or ladder step that waited for the last pass's music is
      // taken over here, so nothing stale fires at the loop end.
      this.#pendingRepeat = false
      this.#secondOpeningBarOnWrap = false
      if (!this.#newRunAtLadderSpeed()) {
        const kind = this.#scoredKind()
        const timeline = this.#startTimeline()
        if (
          this.#engine.mode !== 'scored' ||
          this.#engine.transport !== kind.transport ||
          this.#engine.timeline !== timeline
        ) {
          this.#engine.reconfigure({ reason: 'mode-change', mode: 'scored', timeline, ...kind }, t)
        } else if (!ACTIVE.includes(this.#engine.state.phase)) {
          this.#engine.restart(t)
        }
        this.#ensureAccompaniment()
        this.#prepareAttempt(t)
      }
      this.#lastResult = null
      this.#streak = 0
    } else {
      if (this.#engine.mode !== 'reading') {
        this.#engine.reconfigure(
          { reason: 'mode-change', mode: 'reading', timeline: this.#timeline, transport: 'accompaniment' },
          t,
        )
      }
      this.#ensureAccompaniment()
      const phase = this.#engine.state.phase
      if (phase === 'completed') {
        this.#engine.restart(t)
        this.#accomp?.stop()
        this.#accomp?.play(t)
      } else if (phase === 'paused' || phase === 'interrupted') this.#engine.resume(t)
      if (this.#engine.state.phase === 'paused') this.#engine.resume(t)
      this.#readingStarted = true
      if (phase !== 'completed') this.#playAccompanimentFromCurrent(t)
    }
    this.#process(this.#deps.clock())
  }

  /** Start from the visible fixed cursor, then restore following in either score layout. */
  #followBrowsedCursor(): void {
    const strip = this.#strip
    if (!strip?.isBrowsing()) return
    const position = strip.browsedPosition?.()
    if (position) this.seekPosition(position)
    // A seek schedules the session frame. Update the view's cached position before returning
    // so it cannot briefly pan to the previous transport position.
    strip.setCursor(this.#cursorPosition(), { smooth: false })
    strip.returnToCurrent?.()
  }

  /** Pause: reading keeps progress; a scored attempt is interrupted (spec); Preview pauses. */
  pause(): void {
    const now = this.#deps.clock()
    // Pause is a stop intent also for a Start still loading sounds (an overlay, browsing, Stop sound),
    // and for the continuation a browse hold waits for (U95).
    this.#startGen++
    this.#browseHold = null
    if (this.#playThrough) {
      this.#pausePlay(now)
      this.#process(now)
      return
    }
    if (this.#listen) {
      if (this.#listen.playing) {
        this.#listen.transport.pause()
        this.#listen.playing = false
        this.#clearSounding()
      }
      this.#process(now)
      return
    }
    this.#cancelCountIn(now)
    this.#pauseTransports()
    this.#pendingRepeat = false
    this.#awaitPrepared = false
    this.#engine.pause(now)
    this.#saveResume(now, true)
    this.#process(now)
  }

  /** Start a fresh pass at the loop boundary, even when no transport has been started yet. */
  restartLoop(): Promise<void> {
    if (this.#disposed || !this.#computeUi().canRestartLoop) return Promise.resolve()
    if (this.#leadIn && this.#engine.mode === 'reading') this.#leaveLeadIn(this.#deps.clock())
    const strip = this.#strip
    if (strip?.isBrowsing()) {
      const { start } = passageRange(this.#model, this.#sel.range)
      strip.setCursor(toNumber(start), { smooth: false })
      strip.returnToCurrent?.()
    }
    return this.start({ fromLoopStart: true })
  }

  /** Restart passage / Repeat now: a running attempt is abandoned ('user-restart'). */
  restart(): void {
    const now = this.#deps.clock()
    // A completed Keep time pass still waiting for its last bar is recorded first, so Again goes on
    // from it as from any finished pass (its ladder step included).
    this.#releaseKeepTime()
    this.#clearCorrections()
    if (this.#playThrough) {
      // Play-through has no passage: back to the start of the piece, playing on if it played.
      this.seekPosition(ZERO)
      return
    }
    if (this.#listen) {
      const range = passageRange(this.#model, this.#sel.range)
      this.#listen.transport.seek(range.start)
      this.#clearSounding()
      this.#process(now)
      return
    }
    if (this.#rhythm && this.#engine.mode !== 'scored') {
      // A fresh Keep time attempt uses the loop or the chosen cursor position.
      void this.start()
      return
    }
    this.#cancelCountIn(now)
    this.#pauseTransports()
    this.#pendingRepeat = false
    if (this.#leadIn && this.#engine.mode === 'reading') {
      // Restart in Repeat mode is an attempt at the loop start, also from a lead-in.
      const plan = this.#plan()
      this.#leaveLeadIn(now)
      if (plan.enabled && plan.action === 'scored') {
        this.#engine.reconfigure(
          { reason: 'mode-change', mode: 'scored', timeline: this.#timeline, ...this.#scoredKind() },
          now,
        )
        this.#lastResult = null
        this.#streak = 0
        // A lead-in set up by a seek has no transport until Start: Ready needs the loop's.
        this.#ensureTransport((t) => this.#tryPrepared(t))
        this.#prepareAttempt(now)
      }
      this.#process(now)
      return
    }
    if (this.#newRunAtLadderSpeed()) {
      // Again / Restart is a new run, at the speed the ladder announced.
      this.#lastResult = null
      this.#streak = 0
      this.#process(now)
      return
    }
    this.#accomp?.stop()
    this.#engine.restart(now)
    if (this.#engine.mode === 'scored') {
      // Again / Restart is a new run of passes toward the target.
      this.#lastResult = null
      this.#streak = 0
      this.#ensureTransport((t) => this.#tryPrepared(t))
      this.#prepareAttempt(now)
    } else if (this.#readingStarted) {
      this.#playAccompanimentFromCurrent(now)
    } else {
      // Reading that was never started has no transport playing: back at the start, paused.
      this.#engine.pause(now)
    }
    this.#process(now)
  }

  /** Reading after an interruption: continue at the same position (fresh traversal). */
  resume(): void {
    if (this.#engine.mode !== 'reading' && !this.#playThrough) {
      this.restart()
      return
    }
    void this.start()
  }

  /** Move the reading position to a bar (overview scrub, tap on the strip). */
  seek(occ: number): void {
    const i = Math.max(0, Math.min(this.#model.occurrences.length - 1, occ))
    const o = this.#model.occurrences[i]
    if (!o) return
    // Selecting the loop's first bar lands on its exact start, including a mid-bar start.
    const range = this.#repeat ? this.#sel.range : null
    let position = o.start
    if (range && i === range.fromOcc) {
      const start = passageRange(this.#model, range).start
      if (lt(position, start)) position = start
    }
    this.seekPosition(position)
  }

  /**
   * Move the reading position to an exact position: the first onset at or after it (the dragged
   * playhead lands on a note, U23). Listen seeks its transport there. Keep time ends an active
   * attempt and moves the paused cursor to the chosen note. In gated Repeat mode any position
   * but the loop start sets up a lead-in there (the cursor and the stage move at once; Start
   * reads from it until the music next arrives at the loop start, where the attempt takes over;
   * a running attempt is interrupted, P6); the loop start itself keeps the attempt at the loop
   * start. Seeking while Repeat plays keeps it playing from there (U70); reading, Listen and
   * play-through also play on from the new position. A browse released while something played
   * (U95) arrives here through Start (`#followBrowsedCursor`). Returns false when nothing moved (a
   * scored attempt keeps its passage start, P6).
   */
  seekPosition(position: Rational): boolean {
    const now = this.#deps.clock()
    this.#clearCorrections()
    if (this.#play) return this.#seekPlay(position, now)
    if (this.#listen) {
      this.#listen.transport.seek(position)
      this.#lastSeek = { position }
      this.#clearSounding()
      this.#process(now)
      return true
    }
    // Gated Repeat can read into the loop from the chosen position.
    if (this.#repeat && this.#sel.range && this.#sel.hands !== 'none' && !this.#rhythm) {
      const p = lt(position, ZERO) ? ZERO : position
      if (!eq(p, passageRange(this.#model, this.#sel.range).start)) {
        const moved = this.#seekLeadIn(p, now)
        if (moved) this.#lastSeek = { position: p }
        return moved
      }
      // The loop start while Repeat plays (U70): a new attempt waits there, as the next pass does.
      if (this.#repeatPlaying()) {
        if (this.#engine.mode === 'scored') this.#engine.seek(0, now)
        this.restart()
        return false
      }
    }
    if (this.#leadIn) {
      const p = this.#engine.state.phase
      if (this.#engine.mode === 'reading') this.#leaveLeadIn(now)
      else if (p === 'preparing' || p === 'ready') {
        // Ready after a lead-in: the attempt waits at the loop start on the loop's own transport.
        this.#pauseTransports()
        this.#engine.restart(now)
        this.#prepareAttempt(now)
        this.#process(now)
        return false
      }
    }
    const keepTime = this.#rhythm && this.#sel.hands !== 'none'
    if (this.#engine.mode === 'scored' && !keepTime) {
      if (this.#engine.state.phase === 'running') {
        this.#pauseTransports()
        this.#engine.seek(0, now)
        this.#process(now)
      }
      return false
    }
    // The engine's own groups (the session's selection may be a hands hold, U27).
    let timeline = this.#engine.timeline
    // Navigation in Keep time covers the whole score, even after a partial attempt or in Repeat.
    if (keepTime && timeline.rangeSelected) {
      timeline = this.#repeat
        ? selectionTimeline(this.#model, this.#tempo, { ...this.#sel, range: null })
        : this.#timeline
    }
    const group = groupAtOrAfter(timeline, position)
    if (group >= timeline.groups.length) return false
    if (this.#engine.mode === 'scored' || timeline !== this.#engine.timeline) {
      // A completed pass still waiting for its last bar is recorded; the seek clears its marks too.
      if (this.#releaseKeepTime()) this.#clearCorrections()
      this.#cancelCountIn(now)
      this.#pauseTransports()
      this.#disposeAccompaniment()
      this.#awaitPrepared = false
      this.#pendingRepeat = false
      this.#ladderNext = null
      this.#engine.reconfigure(
        { reason: 'seek', mode: 'reading', timeline, transport: 'accompaniment', startGroup: group },
        now,
      )
      if (this.#engine.state.phase === 'running') this.#engine.pause(now)
      if (this.#engine.state.groupIndex !== group) this.#engine.seek(group, now)
      this.#readingStarted = false
    } else this.#engine.seek(group, now)
    const g = timeline.groups[group]
    if (g) this.#lastSeek = { position: g.position }
    if (this.#accomp && g) {
      this.#accomp.seek(g.position)
      this.#clearSounding()
    }
    this.#saveResume(now, true)
    this.#process(now)
    return true
  }

  // ── Lead-in (Repeat mode) ─────────────────────────────────────────────────────────────

  /**
   * A seek in Repeat mode anywhere but the loop start: a lead-in from `position`. It is set up
   * paused, or playing from there when Repeat was playing (U70); Start reads it like ordinary
   * reading with the same hands, tempo and gates, and the scored attempt over the loop takes over
   * the next time the music arrives at the loop start: at the loop start itself from before the
   * loop, after wrapping at the loop end from inside it, after wrapping at the piece end from
   * after it. Repeat mode and the loop stay as they are. `opts` (a loop changed while Repeat
   * played, U94): `play` overrides whether it plays at once, `reason` is what ends an attempt in
   * progress (default 'seek').
   */
  #seekLeadIn(
    position: Rational,
    now: number,
    opts: { readonly play?: boolean; readonly reason?: InterruptReason } = {},
  ): boolean {
    const loop = passageRange(this.#model, this.#sel.range)
    const start = lt(position, ZERO) ? ZERO : position
    const wrap = !lt(start, loop.start)
    const end = !wrap ? loop.start : lt(start, loop.end) ? loop.end : this.#model.totalDuration
    const passage = passageFromBounds(this.#model, start, end)
    const span = wrap ? passage : passageFromBounds(this.#model, start, loop.end)
    if (!passage || !span) return false
    const timeline = selectionTimeline(
      this.#model,
      this.#tempo,
      { ...this.#sel, range: passage },
      {
        reattackHeldAtStart: false,
      },
    )
    const keepPlaying = opts.play ?? (this.#isPlaying() || this.#pendingRepeat)
    this.#pauseTransports()
    this.#awaitPrepared = false
    this.#pendingRepeat = false
    // A new run: the ladder speed announced for the next pass is canceled, as by a selection change.
    this.#ladderNext = null
    this.#disposeAccompaniment()
    this.#leadInKeys.add(passageKey(timeline.context.passage))
    this.#leadIn = { start, passage, timeline, span, wrap, handedOver: false }
    this.#bothTimeline = null
    // An attempt in progress ends here ('seek'); one not yet started leaves no record.
    this.#engine.reconfigure(
      { reason: opts.reason ?? 'seek', mode: 'reading', timeline, transport: 'accompaniment', startGroup: 0 },
      now,
    )
    if (this.#engine.state.phase === 'running') this.#engine.pause(now)
    this.#readingStarted = false
    this.#applySelectionVisuals()
    if (keepPlaying) {
      this.#ensureAccompaniment()
      this.#startLeadIn(now)
    }
    this.#saveResume(now, true)
    this.#process(now)
    return true
  }

  /** Start or resume a lead-in (`start`): reading toward the loop with the transport. */
  #startLeadIn(now: number): void {
    const lead = this.#leadIn
    if (!lead) return
    const fresh = !this.#readingStarted
    if (fresh) {
      // A new run, as Start of an attempt is.
      this.#lastResult = null
      this.#streak = 0
    }
    this.#readingStarted = true
    const t = this.#accomp
    const phase = this.#engine.state.phase
    if (lead.wrap && (lead.timeline.groups.length === 0 || phase === 'completed')) {
      // Nothing (left) to read before the wrap: the music plays on (or resumes) to the passage
      // end, then wraps to the loop start (`#onAccompanimentEnd`); without a transport at once.
      if (!t) this.#wrapLeadIn(now)
      else if (fresh || t.state !== 'paused') {
        t.stop()
        t.play(now)
      } else t.play(now)
      return
    }
    if (lead.timeline.groups.length === 0) {
      // Nothing to play before the loop: the attempt is live at once and the lead-in plays as
      // its introduction (Ready starts the transport).
      this.#handOver(now)
      return
    }
    if (phase === 'paused' || phase === 'interrupted') this.#engine.resume(now)
    if (fresh && t && this.#engine.state.groupIndex === 0) {
      // From the lead-in position itself (a barline may come before the first note).
      t.stop()
      t.play(now)
    } else {
      this.#playAccompanimentFromCurrent(now)
    }
  }

  /**
   * The lead-in reached the loop: the scored attempt over the loop takes over at once, without
   * a stop or a wait. The lead-in transport plays on (its next gates are the loop's groups);
   * keys and pedals still held from the lead-in do not hold Ready; the clock starts with the
   * first press as in any attempt.
   */
  #handOver(now: number): void {
    const lead = this.#leadIn
    if (!lead || lead.handedOver) return
    if (!this.#timeline.scoredAllowed) {
      this.#leaveLeadIn(now)
      return
    }
    lead.handedOver = true
    this.#readingStarted = false
    if (this.#accompLead) this.#gateOffset = lead.timeline.groups.length
    // The transport is already running into the loop's first gate: its lateness counts.
    this.#engine.reconfigure(
      {
        reason: 'mode-change',
        mode: 'scored',
        timeline: this.#timeline,
        transport: 'accompaniment',
        runningStart: true,
      },
      now,
    )
    this.#engine.resetPhysical(now)
    this.#awaitPrepared = false
    this.#engine.markPrepared(now)
  }

  /**
   * A lead-in from inside or after the loop reached its passage end: the music wraps to the loop
   * start (the strip pans there, U35) and the scored attempt is live at once on the loop's own
   * transport, which waits at the loop's first gate for the first press as any Repeat pass does.
   * Keys and pedals still held from the lead-in do not hold Ready.
   */
  #wrapLeadIn(now: number): void {
    const lead = this.#leadIn
    if (!lead || lead.handedOver) return
    if (!this.#timeline.scoredAllowed) {
      this.#leaveLeadIn(now)
      return
    }
    this.#readingStarted = false
    this.#endLeadIn()
    this.#clearSounding()
    this.#flash?.clear()
    this.#engine.reconfigure(
      { reason: 'mode-change', mode: 'scored', timeline: this.#timeline, transport: 'accompaniment' },
      now,
    )
    this.#engine.resetPhysical(now)
    this.#awaitPrepared = false
    this.#engine.markPrepared(now)
    this.#strip?.wrapTo?.(this.#cursorPosition())
  }

  /**
   * Repeat is playing past a point a seek would stop it (U70): a running attempt, a finished pass
   * whose music plays on into the next, or a lead-in reading or playing on to the wrap.
   */
  #repeatPlaying(): boolean {
    if (this.#engine.mode === 'scored') return this.#engine.state.phase === 'running' || this.#pendingRepeat
    return this.#leadIn !== null && this.#isPlaying()
  }

  /** A lead-in from inside or after the loop is done reading and its music plays on to the wrap. */
  #leadInTail(): boolean {
    const lead = this.#leadIn
    return (
      lead !== null &&
      lead.wrap &&
      !lead.handedOver &&
      this.#readingStarted &&
      this.#engine.mode === 'reading' &&
      this.#engine.state.phase !== 'running' &&
      this.#accomp?.state === 'playing'
    )
  }

  /** The lead-in is over: the loop's own transport replaces the lead-in one. */
  #endLeadIn(): void {
    if (!this.#leadIn) return
    this.#leadIn = null
    this.#bothTimeline = null
    if (this.#accompLead) {
      this.#disposeAccompaniment()
      this.#ensureAccompaniment()
    }
    this.#applySelectionVisuals()
  }

  /** Drop a lead-in that has not reached the loop: reading paused at the loop start again. */
  #leaveLeadIn(now: number): void {
    if (!this.#leadIn) return
    const reading = this.#engine.mode === 'reading'
    this.#pauseTransports()
    this.#endLeadIn()
    if (!reading) return
    this.#engine.reconfigure(
      { reason: 'seek', mode: 'reading', timeline: this.#timeline, transport: 'accompaniment', startGroup: 0 },
      now,
    )
    if (this.#engine.state.phase === 'running') this.#engine.pause(now)
    this.#readingStarted = false
  }

  /**
   * Listen (Preview, both hands off): plays the loop in Repeat mode, else from the current
   * position, with no learner input. Reached only through Start with hands 'none' (U9); the
   * piano plays both hands (there is no left / right filter, U12). Plays where the sound
   * destination resolves now (S4); a destination that changed since the last Play rebuilds the
   * transport instead of resuming it.
   */
  async #startListening(fromLoopStart: boolean): Promise<void> {
    if (!hasTempo(this.#tempo)) return
    const key = outputKey(this.#settings, this.#destination())
    const position = this.#listen ? this.#listen.transport.positionNow() : null
    const seek = this.#lastSeek
    if (
      this.#listen &&
      !this.#listen.playing &&
      this.#listen.outputKey === key &&
      this.#output &&
      this.#outputKey === key
    ) {
      const listen = this.#listen
      if (this.#settings.metronome.enabled && this.#settings.metronome.outputId) {
        const gen = this.#startGen
        await this.#ensureMetronome()
        if (this.#startCanceled(gen) || this.#listen !== listen) return
      }
      if (fromLoopStart && this.#repeat) {
        listen.transport.seek(passageRange(this.#model, this.#sel.range).start)
        this.#clearSounding()
      }
      listen.transport.play()
      listen.playing = true
      this.#process(this.#deps.clock())
      return
    }
    // Another destination than last time: release the old transport before its output goes.
    if (this.#listen) this.#disposeListen()
    const gen = this.#startGen
    const output = await this.#ensureOutput()
    if (!output || this.#startCanceled(gen)) return
    await this.#ensureMetronome()
    if (this.#startCanceled(gen)) return
    // The selection may have changed while sounds loaded (a hand chosen, held hands given back):
    // Start honors the new plan instead (its own load is done, so it does not come back here).
    const plan = this.#plan()
    if (!plan.enabled) return
    if (plan.action !== 'listen') return this.#start(fromLoopStart)
    this.#followBrowsedCursor()
    const t = this.#deps.clock()
    // Leaving practice for Preview: a scored attempt is interrupted, reading pauses.
    this.#pauseTransports()
    if (this.#engine.mode === 'scored' && ACTIVE.includes(this.#engine.state.phase))
      this.#engine.interrupt('mode-change', t)
    else if (this.#engine.state.phase === 'running') this.#engine.pause(t)
    this.#awaitPrepared = false
    this.#pendingRepeat = false
    if (this.#listen) this.#disposeListen()
    const range = passageRange(this.#model, this.#sel.range)
    let start = range.start
    if (!fromLoopStart || !this.#repeat) {
      if (this.#lastSeek && this.#lastSeek !== seek) start = this.#lastSeek.position
      else if (position !== null) {
        start = seek && toNumber(seek.position) === position ? seek.position : this.#positionRational(position, range)
      } else {
        start = this.#engine.state.position ?? range.start
      }
    }
    this.#playListen(output, range, start)
    this.#process(this.#deps.clock())
  }

  /** A new Listen transport over `range` on `output`, playing from `start`. */
  #playListen(output: OutputBackend, range: ReturnType<typeof passageRange>, start: Rational): void {
    const events = buildPerformance(this.#model, {
      hands: 'none',
      range,
      sendPedals: true,
      accompanimentLevel: level(this.#settings.route.accompanimentLevel),
    })
    const transport = createTransport({
      clock: this.#deps.clock,
      timers: this.#deps.timers,
      tempo: this.#tempo,
      multiplier: this.#sel.multiplier,
      events,
      gates: null,
      range,
      backend: output,
      metronome: {
        sink: this.#metronomeSink,
        clicks: buildClickTrack(this.#model, range),
        enabled: this.#settings.metronome.enabled,
      },
      onRangeEnd: () => this.#onListenEnd(),
      onInterrupted: () => this.#onOutputLost(),
      onEmit: (ev, time) => this.#onEmit(ev, time),
    })
    transport.seek(start)
    transport.play()
    this.#listen = { transport, playing: true, outputKey: this.#outputKey }
  }

  /**
   * The loop changed while Listen played (U94): the transport is rebuilt over the new loop and
   * plays on from `from` when it lies inside it, else from the loop start. False when the output
   * it played on is gone (the caller stops Listen as before).
   */
  #replayListen(next: Selection, from: Rational | null, now: number): boolean {
    const l = this.#listen
    const output = this.#output
    if (!l || !output || this.#outputKey !== l.outputKey) return false
    this.#sel = next
    this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
    this.#bothTimeline = null
    const range = passageRange(this.#model, next.range)
    const start = from && !lt(from, range.start) && lt(from, range.end) ? from : range.start
    // The old transport goes first (its sounding notes are released), then the new one plays.
    this.#disposeListen()
    this.#playListen(output, range, start)
    this.#lastSeek = { position: start }
    this.#applySelectionVisuals()
    this.#process(now)
    return true
  }

  // ── Play-through (DECISIONS P12) ──────────────────────────────────────────────────────

  /**
   * Start or resume play-through: from the current cursor (the first learner group at or after
   * it) to the end of the piece, or from the start of the piece after reaching its end. Both
   * hands use a silent transport; one hand plays the other hand automatically (an output is
   * needed, as for reading). A destination that changed since the last Start rebuilds the
   * transport at the same group instead of resuming it.
   */
  async #startPlay(): Promise<void> {
    // Silent: both hands, or the microphone follows (it must never hear the app, DECISIONS P22).
    const silent = this.#playSilent()
    const mic = this.#micActive()
    const p = this.#play
    const key = silent ? '' : outputKey(this.#settings, this.#destination())
    const gen = this.#startGen
    if (
      p &&
      !p.playing &&
      p.mic === mic &&
      p.outputKey === key &&
      (silent || (this.#output !== null && this.#outputKey === key))
    ) {
      this.#followBrowsedCursor()
      if (this.#playMetronome() && this.#settings.metronome.outputId) {
        await this.#ensureMetronome()
        if (this.#startCanceled(gen) || this.#play !== p || p.playing) return
      }
      if (mic && !(await this.#startMic(p.follower.state.position ?? ZERO))) return
      // Canceled once the microphone opened: paused as by an ordinary pause (`#pausePlay`), kept open.
      if (this.#startCanceled(gen)) return this.#mic?.pause()
      if (this.#play !== p || p.playing) return
      this.#playFrom(this.#deps.clock())
      this.#process(this.#deps.clock())
      return
    }
    if (!silent) {
      const output = await this.#ensureOutput()
      if (!output || this.#startCanceled(gen)) return
    }
    await this.#ensureMetronome()
    if (this.#startCanceled(gen) || !this.#playThrough) return
    // The selection may have changed while sounds loaded.
    const plan = this.#plan()
    if (!plan.enabled || plan.action !== 'play') return
    if (!this.#playSilent() && !this.#ensureOutputSync()) return
    if (this.#play?.playing) return
    this.#followBrowsedCursor()
    const now = this.#deps.clock()
    const current = this.#play
    // Rebuilt for a new output at the follower's group; fresh at the engine's (reading) position.
    const position = current ? current.follower.state.position : this.#engine.state.position
    this.#buildPlay(position, now)
    const built = this.#play
    if (built?.mic) {
      if (!(await this.#startMic(built.follower.state.position ?? ZERO))) {
        this.#process(this.#deps.clock())
        return
      }
      // Canceled once the microphone opened: paused as by an ordinary pause (`#pausePlay`), kept open.
      if (this.#startCanceled(gen)) return this.#mic?.pause()
      if (this.#play !== built || built.playing) return
    }
    this.#playFrom(this.#deps.clock())
    this.#process(this.#deps.clock())
  }

  /** A Pause (or leaving) since a Start began: it must not start anything after its awaits. */
  #startCanceled(gen: number): boolean {
    return this.#disposed || gen !== this.#startGen
  }

  /**
   * The microphone follower for this play-through (DECISIONS P15): built and opened on the first
   * Start (the browser may ask for the microphone); later Starts reuse it. False, with the reason
   * in `ui.micStatus`, when it could not start: play-through stays on but does not play.
   */
  async #startMic(position: Rational): Promise<boolean> {
    const create = this.#deps.createMicFollower
    if (!create) return false
    if (this.#mic) return true
    // One hand: the follower listens for that hand's onset groups, the play timeline's (P22).
    const hands = this.#sel.hands === 'none' ? 'both' : this.#sel.hands
    const mic = create(
      this.#model,
      (e) => this.#onMicEstimate(mic, e),
      (reason) => this.#onMicLost(mic, reason),
      hands,
    )
    this.#mic = mic
    this.#setMicStatus(MIC_STARTING)
    try {
      await mic.start(position)
    } catch (e) {
      if (this.#mic === mic) {
        this.#mic = null
        this.#setMicStatus(e instanceof Error && e.message ? e.message : MIC_FAILED_TEXT)
      }
      mic.dispose()
      return false
    }
    if (this.#mic !== mic || this.#disposed) {
      mic.dispose()
      return false
    }
    this.#setMicStatus(MIC_LISTENING)
    return true
  }

  /**
   * A position estimate from the microphone: with enough confidence, the last group at or before
   * it is reached, so the follower releases every gate up to it (an estimate behind the current
   * group is noise and ignored). Nothing is judged.
   */
  #onMicEstimate(mic: MicFollowerLike, e: MicEstimate): void {
    const p = this.#play
    if (this.#disposed || mic !== this.#mic || !p?.playing || e.confidence < MIC_CONFIDENCE) return
    const i = p.follower.state.groupIndex
    if (i === null) return
    const g = groupReached(p.follower.timeline, e.position)
    if (g < i) return
    p.follower.audioReached(g, this.#deps.clock())
    this.#processPlay()
  }

  /**
   * The microphone stopped by itself (unplugged, taken by the system): play-through pauses with
   * the reason in the status line, and the next Start opens the microphone again.
   */
  #onMicLost(mic: MicFollowerLike, reason: string): void {
    if (this.#disposed || mic !== this.#mic) return
    const now = this.#deps.clock()
    this.#pausePlay(now)
    this.#mic = null
    mic.dispose()
    this.#setMicStatus(reason)
    this.#process(now)
  }

  #setMicStatus(status: string | null): void {
    if (status === this.#micStatus) return
    this.#micStatus = status
    if (!this.#disposed) this.#publishUi()
  }

  /** Closes the microphone (play-through off, hands changed, the setting off, dispose). */
  #disposeMic(): void {
    const mic = this.#mic
    this.#mic = null
    mic?.dispose()
    this.#setMicStatus(null)
  }

  /** A new play-through transport and follower at the first group at or after `position` (null: the start). */
  #buildPlay(position: Rational | null, now: number): void {
    this.#disposePlay(false)
    // Nothing plays with both hands, nor while the microphone follows (P22: no accompaniment).
    const silent = this.#playSilent()
    const mic = this.#micActive()
    const output = silent ? null : this.#output
    const timeline = this.#timeline
    const range = passageRange(this.#model, null)
    const route = this.#settings.route
    const events = silent
      ? []
      : buildPerformance(this.#model, {
          hands: this.#sel.hands,
          range,
          accompanimentLevel: level(route.accompanimentLevel),
          sendPedals: route.automaticPedalsInHandPractice,
        })
    const startGroup = position ? groupAtOrAfter(timeline, position) : 0
    const follower = new PlayFollower(timeline, { startGroup }, now)
    const transport = createTransport({
      clock: this.#deps.clock,
      timers: this.#deps.timers,
      tempo: this.#tempo,
      multiplier: this.#sel.multiplier,
      events,
      gates: transportGates(timeline),
      range,
      backend: output,
      metronome: {
        sink: this.#metronomeSink,
        clicks: buildClickTrack(this.#model, range),
        enabled: this.#playMetronome(),
      },
      // Re-entrant inside `releaseGate` when an early release fast-forwards (tolerated).
      onGateReached: (gate) => {
        const t = this.#deps.clock()
        follower.transportArrived(gate, t)
        this.#processPlay()
      },
      onRangeEnd: () => this.#onPlayEnd(),
      onInterrupted: () => this.#onOutputLost(),
      onEmit: (ev, time) => this.#onEmit(ev, time),
    })
    const g = timeline.groups[startGroup]
    if (g) transport.seek(g.position)
    this.#play = {
      transport,
      follower,
      timing: mic ? null : new PerformanceTiming(),
      playing: false,
      outputKey: silent ? '' : this.#outputKey,
      mic,
    }
    this.#playResumable = false
    this.#playVersion = -1
  }

  /** Play on from where play-through is; from the start of the piece once it reached the end. */
  #playFrom(now: number): void {
    const p = this.#play
    if (!p) return
    p.timing?.reset()
    if (p.follower.state.finished) {
      p.follower.seek(0, now)
      p.transport.stop()
    }
    if (p.follower.state.paused) p.follower.resume(now)
    p.playing = true
    p.transport.play(now)
    if (this.#mic) {
      // The estimate restarts at the current group: what was heard while paused is forgotten.
      this.#mic.reset(p.follower.state.position ?? ZERO)
      this.#mic.resume()
    }
  }

  /** Pause keeps the position; the patience clock stops with the music. */
  #pausePlay(now: number): void {
    const p = this.#play
    if (!p?.playing) return
    p.transport.pause()
    p.follower.pause(now)
    p.playing = false
    this.#mic?.pause()
    this.#clearSounding()
    this.#saveResume(now, true)
  }

  /** A seek: the first group at or after `position`, playing on if it played (U70 spirit). */
  #seekPlay(position: Rational, now: number): boolean {
    const p = this.#play
    if (!p) return false
    const timeline = p.follower.timeline
    const group = groupAtOrAfter(timeline, position)
    const g = timeline.groups[group]
    if (!g) return false
    p.timing?.reset()
    // The follower first: a playing transport reports the gate at the new position at once.
    p.follower.seek(group, now)
    p.transport.seek(g.position)
    this.#mic?.reset(g.position)
    this.#lastSeek = { position: g.position }
    this.#clearSounding()
    this.#processPlay()
    this.#saveResume(now, true)
    this.#process(now)
    return true
  }

  /**
   * Speed and hands while play-through runs. Speed applies live (the follower's patience follows
   * the new timeline); new hands rebuild the transport at the same group, playing on if it
   * played. Returns false for any other change (the ordinary path handles it).
   */
  #selectPlay(next: Selection, reason: InterruptReason, now: number): boolean {
    const p = this.#play
    if (!p) return false
    if (reason === 'tempo-change') {
      this.#sel = next
      this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
      this.#bothTimeline = null
      this.#engine.reconfigure({ reason, timeline: this.#timeline, transport: 'accompaniment' }, now)
      p.transport.setMultiplier(next.multiplier)
      p.follower.reconfigure(this.#timeline, now)
      p.timing?.reset()
      // The microphone follower knows no speed: it follows the order of the notes (P16).
      this.#processPlay()
      this.#process(now)
      return true
    }
    if (reason !== 'hand-change' || next.hands === 'none') return false
    const wasPlaying = p.playing
    const position = p.follower.state.position
    this.#sel = next
    this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
    this.#bothTimeline = null
    this.#disposePlay(false)
    this.#disposeAccompaniment()
    const startGroup = position ? groupAtOrAfter(this.#timeline, position) : 0
    this.#engine.reconfigure({ reason, timeline: this.#timeline, transport: 'accompaniment', startGroup }, now)
    if (this.#engine.state.phase === 'running') this.#engine.pause(now)
    this.#playResumable = position !== null
    this.#applySelectionVisuals()
    // Start builds the new transport from the engine's (now the follower's) position.
    if (wasPlaying) void this.start()
    this.#process(now)
    return true
  }

  /**
   * Drain the follower: gate releases go to the transport synchronously (a release before the
   * transport arrives fast-forwards and re-enters through `onGateReached`), wrong presses get the
   * gentle feedback in the next frame. O(events).
   */
  #processPlay(): void {
    const p = this.#play
    if (!p) return
    if (this.#playProcessing) {
      this.#playAgain = true
      return
    }
    this.#playProcessing = true
    try {
      for (let guard = 0; guard < 50; guard++) {
        this.#playAgain = false
        const events = p.follower.drainEvents()
        for (const ev of events) {
          if (ev.type === 'release') p.transport.releaseGate(ev.group)
          else if (ev.type === 'accepted' && p.playing)
            p.timing?.observe(p.follower.timeline.groups[ev.group]!, ev.time)
          else if (ev.type === 'wrong') {
            this.#wrongPending++
            this.#wrongReason = 'early'
          }
        }
        if (events.length === 0 && !this.#playAgain) break
      }
    } finally {
      this.#playProcessing = false
    }
    if (this.#disposed) return
    this.#scheduleFrame()
    this.#scheduleTick()
  }

  /** The transport played the piece's tail. Rewind and wait for Start. */
  #onPlayEnd(): void {
    const p = this.#play
    if (!p) return
    const now = this.#deps.clock()
    p.transport.stop()
    p.playing = false
    this.#mic?.pause()
    this.#clearSounding()
    this.#rewindPiece()
    this.#saveResume(now, true, null)
    this.#process(now)
  }

  /**
   * Drop the play-through transport and follower. `keepPosition`: the engine (paused reading)
   * moves to the follower's group so a later Start, or leaving the mode, continues there.
   */
  #disposePlay(keepPosition: boolean): void {
    const p = this.#play
    if (!p) return
    this.#play = null
    p.transport.stop()
    p.transport.dispose()
    this.#disposeMic()
    this.#clearSounding()
    this.#lastVersion = -1
    if (!keepPosition) return
    const now = this.#deps.clock()
    // After the end of the piece the next Start (or reading) begins at the start.
    const position = p.follower.state.position
    const group = position ? groupAtOrAfter(this.#engine.timeline, position) : 0
    if (group < this.#engine.timeline.groups.length) this.#engine.seek(group, now)
    this.#playResumable = position !== null
    // Records of the reading pass this ends are dropped (`#handle`), so drain while still on.
    this.#drain(now)
  }

  requestHint(): void {
    // Play-through has no hints (`canHint` false); the hint pedal reveals names instead.
    if (this.#playThrough) return
    const now = this.#deps.clock()
    this.#engine.requestHint(now)
    this.#process(now)
  }

  /**
   * Names the notes at the cursor (both hands' onset group there) for the hint lifetime, then
   * fades them out (Study mode, DECISIONS U72). The engine's hints need a running attempt;
   * this one works whenever the score is shown, paused or playing. Persistent labels stay; a
   * note already labeled keeps its label. Returns false when no note is at the cursor.
   */
  revealAtCursor(): boolean {
    const notes = this.#bothHandsAtCursor()
    if (notes.length === 0) return false
    const now = this.#deps.clock()
    const lifetime = this.#settings.hints.lifetime
    const seconds = lifetime === 'until-correct' ? REVEAL_FALLBACK_S : lifetime
    this.#reveal = { notes, until: now + seconds * 1000 + this.#settings.hints.fadeMs }
    this.#labelsDirty = true
    this.#frame(now, false)
    this.#scheduleTick()
    return true
  }

  /** Opacity of the revealed names at `now` (empty when none, or once they are gone). */
  #revealOpacity(now: number): ReadonlyMap<number, number> {
    const r = this.#reveal
    if (!r) return this.#lastReveal.size === 0 ? this.#lastReveal : new Map()
    const fadeMs = this.#settings.hints.fadeMs
    const fadeStart = r.until - fadeMs
    const v = now < fadeStart ? 1 : fadeOutOpacity(now - fadeStart, fadeMs)
    if (v <= 0) {
      this.#reveal = null
      return new Map()
    }
    const out = new Map<number, number>()
    for (const n of r.notes) out.set(n, v)
    return out
  }

  setKeyboardVisible(visible: boolean): void {
    const now = this.#deps.clock()
    this.#engine.setKeyboardVisible(visible, now)
    this.#process(now)
  }

  /**
   * Open or close Repeat mode (U10). Opening uses the remembered loop, or `at` (the bar under
   * the cursor line, the browsed bar while browsing) as a one-bar loop. Closing ends a running
   * scored attempt ('mode-change', P4) and returns to reading at the loop's start; nothing
   * starts by itself. The loop stays remembered.
   */
  setRepeatMode(open: boolean, at?: number): void {
    if (open === this.#repeat) return
    // Without a piano a hand plays through the microphone; Repeat (scored) needs the piano (P22).
    if (open && this.#playRequired()) return
    let loop = this.#loop
    if (open && !loop) {
      const occ = Math.max(0, Math.min(this.#model.occurrences.length - 1, at ?? this.progress.get().occ))
      loop = { fromOcc: occ, toOcc: occ }
    }
    this.#select({ hands: this.#sel.hands, multiplier: this.#sel.multiplier }, loop, open)
  }

  /**
   * Play-through mode (DECISIONS P12): a performance aid, not practice. On: Repeat mode closes
   * (the loop stays remembered), what plays stops (reading pauses at its position; a scored
   * attempt ends by closing Repeat) and Start plays through from the cursor with wrong notes
   * never blocking. Off: back to ordinary reading, paused at the same position. Unavailable
   * while the hands are off (Listen, also held without a piano). Nothing is persisted. Without a
   * piano it cannot go off while a hand is selected (DECISIONS P22: it is how a hand plays then).
   */
  setPlayThrough(on: boolean): void {
    if (this.#disposed) return
    if (on && this.#sel.hands === 'none') return
    if (!on && this.#playRequired()) return
    this.#playThroughChosen = on
    this.#setPlayThrough(on)
  }

  /** Switches the mode (the learner's choice, or the no-piano rule in `#syncPlayMode`). */
  #setPlayThrough(on: boolean): void {
    if (on === this.#playThrough || this.#disposed) return
    const now = this.#deps.clock()
    if (on) {
      if (this.#sel.hands === 'none') return
      if (this.#rhythm) {
        // Without a piano Keep time comes back with it; the piece keeps its choice meanwhile.
        const held = !this.#inputAvailable
        this.#setRhythm(false, !held)
        this.#rhythmHeld = held
      }
      if (this.#repeat) {
        // Without a piano Repeat comes back with it; the piece keeps it open meanwhile (U98). The
        // learner's own play-through choice (with a piano) closes it for good.
        if (this.#playRequired()) this.#repeatHeld = true
        this.setRepeatMode(false)
      }
      this.#stopListening()
      this.#pauseTransports()
      this.#awaitPrepared = false
      this.#pendingRepeat = false
      if (this.#engine.mode === 'scored' && ACTIVE.includes(this.#engine.state.phase))
        this.#engine.interrupt('mode-change', now)
      else if (this.#engine.state.phase === 'running') this.#engine.pause(now)
      if (this.#engine.mode === 'reading' && this.#engine.state.phase === 'paused') {
        // The reading pass so far is recorded before play-through drops what the engine ends:
        // the keep-progress path ends the traversal and continues a new one at the same target.
        this.#engine.reconfigure({ reason: 'mode-change' }, now)
        this.#drain(now)
      }
      this.#playThrough = true
      // The reading transport goes; Start in reading builds a new one from the engine's position.
      this.#disposeAccompaniment()
      this.#clearPreview()
      this.#clearCorrections()
      this.#lastResult = null
      this.#cue = null
      this.#flash?.clear()
      this.#playPedal = this.#hintPedal(this.#settings)
      this.#saveResume(now, true)
    } else {
      this.#disposePlay(true)
      this.#playThrough = false
      this.#playResumable = false
      this.#playPedal = null
      this.#lastVersion = -1
      this.#flash?.clear()
    }
    this.#lockState = ''
    this.#syncLock()
    this.#process(now)
    this.#publishUi()
  }

  /**
   * Keep time (rhythm mode, DECISIONS P13), saved on the piece. On: every Start is a scored
   * attempt on the strict transport after a count-in, over the loop in Repeat mode, else
   * from the cursor to the end; play-through goes off; needs a hand selected and a numerical
   * tempo. Switching either way ends an attempt in progress ('mode-change'); off returns to
   * ordinary reading, paused at the attempt's current position.
   */
  setRhythmMode(on: boolean): void {
    if (this.#disposed) return
    // Keep time needs a piano: without one a hand plays through the microphone (P22).
    if (on && this.#playRequired()) return
    this.#rhythmHeld = false
    this.#setRhythm(on, true)
  }

  /** `persist` false: switched off by the no-piano rule, so the piece keeps its choice. */
  #setRhythm(on: boolean, persist: boolean): void {
    if (on === this.#rhythm || this.#disposed) return
    if (on && (this.#sel.hands === 'none' || !hasTempo(this.#tempo))) return
    if (on && this.#playThrough) this.setPlayThrough(false)
    const now = this.#deps.clock()
    this.#cancelCountIn(now)
    this.#pauseTransports()
    this.#awaitPrepared = false
    this.#pendingRepeat = false
    this.#ladderNext = null
    if (this.#leadIn) {
      if (this.#engine.mode === 'reading') this.#leaveLeadIn(now)
      else this.#endLeadIn()
    }
    if (this.#engine.mode === 'scored') {
      const position = this.#engine.state.position
      const startGroup = !on && position ? groupAtOrAfter(this.#timeline, position) : 0
      this.#engine.reconfigure(
        {
          reason: 'mode-change',
          mode: 'reading',
          timeline: this.#timeline,
          transport: 'accompaniment',
          startGroup: Math.min(startGroup, Math.max(0, this.#timeline.groups.length - 1)),
        },
        now,
      )
      this.#readingStarted = false
    } else if (!samePassage(this.#engine.timeline.range, this.#timeline.range)) {
      // Keep time read across the whole score after a seek outside the loop: back to the loop start.
      this.#engine.reconfigure(
        { reason: 'mode-change', mode: 'reading', timeline: this.#timeline, transport: 'accompaniment', startGroup: 0 },
        now,
      )
      this.#readingStarted = false
    }
    if (this.#engine.state.phase === 'running') this.#engine.pause(now)
    // The next Start builds the transport for the new mode.
    this.#disposeAccompaniment()
    this.#rhythm = on
    this.#lastResult = null
    this.#clearCorrections()
    this.#cue = null
    this.#flash?.clear()
    if (persist) this.#deps.piece.save({ rhythm: on }, true)
    this.#lockState = ''
    this.#syncLock()
    this.#process(now)
    this.#publishUi()
  }

  #toleranceMs(settings: SessionSettings): number {
    return settings.rhythm?.toleranceMs ?? DEFAULT_RHYTHM_TOLERANCE_MS
  }

  #rhythmParams(settings = this.#settings): RhythmParams {
    return {
      toleranceMs: this.#toleranceMs(settings),
      // Playback at 0% plays nothing and counts as off for history.
      ...(playbackHeard(settings) ? { scorePlayback: true } : {}),
    }
  }

  /** The engine transport and rhythm parameters of a scored attempt (strict in Keep time). */
  #scoredKind(): { transport: TransportKind; rhythm?: RhythmParams } {
    return this.#rhythm ? { transport: 'strict', rhythm: this.#rhythmParams() } : { transport: 'accompaniment' }
  }

  /** Keep the loop selection independent of a one-off attempt from the visible cursor. */
  #startTimeline(): Timeline {
    if (!this.#rhythm || this.#repeat || this.#sel.hands === 'none') return this.#timeline
    if (this.#engine.transport === 'strict' && ACTIVE.includes(this.#engine.state.phase)) return this.#engine.timeline
    const browsed = this.#strip?.isBrowsing() ? this.#strip.browsedPosition?.() : null
    if (browsed) return this.#timelineFrom(browsed)
    if (this.#engine.state.phase === 'completed') return this.#timeline
    const start = this.#onsetAtOrAfter(this.#cursorPosition()) ?? this.#engine.state.position
    return this.#timelineFrom(start)
  }

  #timelineFrom(start: Rational | null): Timeline {
    if (!start || !lt(this.#timeline.start, start)) return this.#timeline
    if (this.#cursorPassage?.selection === this.#timeline && eq(this.#cursorPassage.timeline.start, start)) {
      return this.#cursorPassage.timeline
    }
    const range = passageFromBounds(this.#model, start, this.#timeline.end)
    const timeline = selectionTimeline(
      this.#model,
      this.#tempo,
      { ...this.#sel, range },
      { reattackHeldAtStart: false },
    )
    this.#cursorPassage = { selection: this.#timeline, timeline }
    return timeline
  }

  /**
   * Keep time: the engine is Ready, so count in from now (`countInPlan` at the passage
   * start): every click goes to the metronome sink at once (accent on the first), `ui.countIn`
   * counts the clicks down, and the attempt starts on the next pulse (`#endCountIn`).
   */
  #beginCountIn(now: number): void {
    this.#cancelCountIn(now)
    if (!this.#accomp || !hasTempo(this.#tempo)) return
    this.#timingDrift.prepare(this.#engine.timeline.groups)
    const start = this.#engine.timeline.start
    const plan = countInPlan(this.#model, this.#tempo, start, this.#sel.multiplier)
    for (let k = 0; k < plan.beats; k++) this.#metronomeSink.click(now + k * plan.beatMs, k === 0)
    this.#countIn = {
      start: now,
      beats: plan.beats,
      beatMs: plan.beatMs,
      remaining: plan.beats,
      timer: null,
      // A transport moving the music later only moves this window later: earlier presses never count.
      from: now + plan.beats * plan.beatMs - this.#toleranceMs(this.#settings),
      pressTimes: new Float64Array(COUNT_IN_PRESSES),
      pressNotes: new Uint8Array(COUNT_IN_PRESSES),
      pressVelocities: new Uint8Array(COUNT_IN_PRESSES),
      pressHead: 0,
      pressCount: 0,
    }
    this.#nextCountInBeat()
    this.#scheduleFrame()
  }

  /** One timer per beat: the shown number goes down, and after the last beat the attempt starts. */
  #nextCountInBeat(): void {
    const c = this.#countIn
    if (!c) return
    if (c.remaining <= 2 && this.#reviewing()) {
      this.#reviewReturnBy = c.start + c.beats * c.beatMs
      this.#scheduleFrame()
    }
    const k = c.beats - c.remaining + 1
    const at = c.start + k * c.beatMs
    c.timer = this.#deps.timers.setTimeout(
      () => {
        if (this.#countIn !== c) return
        c.timer = null
        if (k >= c.beats) {
          this.#endCountIn(at)
          return
        }
        c.remaining = c.beats - k
        this.#nextCountInBeat()
        this.#publishUi()
      },
      Math.max(0, at - this.#deps.clock()),
    )
  }

  /**
   * The count-in is over: the engine's clock starts and the transport plays from the passage start
   * with the same timestamp. Every gate is released first, so the music never holds; the
   * transport still reports each arrival (`onGateReached` → `transportArrived`).
   */
  #endCountIn(at: number): void {
    const c = this.#countIn
    this.#countIn = null
    const t = this.#accomp
    const s = this.#engine.state
    if (!t || this.#engine.mode !== 'scored' || this.#engine.transport !== 'strict' || s.phase !== 'ready') {
      this.#publishUi()
      return
    }
    // Every way to a new pass hands on the last one first; a record still waiting is kept here too.
    this.#releaseKeepTime()
    this.#setCorrectionsVisible(false)
    this.#watchKeepTimeActivity(at)
    this.#capture.begin(at)
    this.#engine.startRunning(at)
    for (let g = 0; g < this.#engine.timeline.groups.length; g++) t.releaseGate(g + this.#gateOffset)
    t.play(at)
    if (c && c.pressCount > 0) this.#replayCountIn(c, at)
    this.#process(this.#deps.clock())
  }

  /**
   * Presses from the count-in's last stretch, now that the attempt runs and the transport plays:
   * those from the music's downbeat (the transport may have moved it later) minus the tolerance on
   * are the first downbeat played early, or on time before the count-in's end reached the session.
   * Each goes, at its own time, where a press during the pass goes: the first bar's silent-bar and
   * opening checks, the captured pass, the live timing cue and the engine (`countInPress`).
   */
  #replayCountIn(c: CountIn, at: number): void {
    const now = this.#deps.clock()
    // The downbeat's own engine events go first (the phase change resets the live cue).
    this.#drain(now)
    const shift = this.#keepTimeShift()
    const downbeat = at + shift
    const tolerance = this.#toleranceMs(this.#settings)
    for (let i = 0; i < c.pressCount; i++) {
      const k = (c.pressHead + i) % COUNT_IN_PRESSES
      const time = c.pressTimes[k]!
      if (time < downbeat - tolerance) continue
      const note = c.pressNotes[k]!
      const activity = this.#keepTimeActivity
      if (activity) this.#creditKeepTimePress(activity, note, time - shift)
      if (this.#engine.state.phase !== 'running') continue
      this.#capture.add(time, note, c.pressVelocities[k]!, this.#engine.state.groupIndex ?? -1)
      this.#timingDrift.attack(note, time, downbeat, tolerance)
      this.#engine.countInPress(note, time)
      this.#drain(now)
    }
  }

  #watchKeepTimeActivity(downbeat: number): void {
    const timeline = this.#engine.timeline
    const first = timeline.groups[0]?.occ
    if (first === undefined) return
    const secondBar = this.#secondOpeningBarOnWrap
    this.#secondOpeningBarOnWrap = false
    const openingOcc = secondBar ? first : Math.min(first + 1, timeline.range.toOcc)
    const bars: { start: number; end: number }[] = []
    let position = timeline.start
    let time = downbeat
    let openingEnd = downbeat
    for (const measure of timeline.measures) {
      const bar = this.#model.occurrences[measure.occ]!
      const barEnd = add(bar.start, bar.duration)
      const end = lt(barEnd, timeline.end) ? barEnd : timeline.end
      const start = time
      time += secondsBetween(timeline.tempo, position, end, timeline.multiplier) * 1000
      position = end
      if (measure.groups.length > 0) bars.push({ start, end: time })
      if (measure.occ === openingOcc) openingEnd = time
    }
    let opening: RepeatOpening | null = null
    if (this.#repeat) {
      const pitches = new Set<number>()
      for (const group of timeline.groups) {
        if (group.occ > openingOcc) break
        for (const pitch of group.pitches) pitches.add(pitch)
      }
      opening = { end: openingEnd, pitches, waitAnotherPass: !secondBar && openingOcc === first }
    }
    this.#keepTimeActivity = {
      bars,
      played: new Uint8Array(bars.length),
      bar: 0,
      // The tolerance the engine accepts an early note with in this attempt (a change interrupts it).
      early: this.#toleranceMs(this.#settings),
      opening,
      completed: null,
    }
  }

  /**
   * Real milliseconds the transport moved the music later than the schedule fixed at the downbeat
   * (a late count-in timer, main-thread stalls), so the bar windows and the timing cue judge on the
   * clock the engine grades against (it takes each arrival from the transport). Kept from when the
   * transport last played: the last bar's check can outlast it by the grace. O(1).
   */
  #keepTimeShift(): number {
    const t = this.#accomp
    if (t?.state === 'playing') this.#shift = t.shiftMs
    return this.#shift
  }

  /**
   * Judge the bars that ended at least `#keepTimeGrace` before `now` (on the music's clock): an
   * unplayed one stops the pass (U112), as does an opening check still unmet at its end.
   */
  #checkKeepTimeActivity(now: number): void {
    const activity = this.#keepTimeActivity
    if (!activity) return
    const due = now - this.#keepTimeShift() - this.#keepTimeGrace
    const { bars, played } = activity
    while (activity.bar < bars.length && due >= bars[activity.bar]!.end) {
      if (!played[activity.bar]) {
        this.#stopInactiveKeepTime()
        return
      }
      activity.bar++
    }
    const opening = activity.opening
    if (opening && due >= opening.end) {
      if (!opening.waitAnotherPass) {
        this.#stopInactiveKeepTime()
        return
      }
      // For a one-bar loop, the next traversal provides the second bar of playing.
      this.#secondOpeningBarOnWrap = true
      activity.opening = null
    }
    this.#finishKeepTimeActivity(activity)
  }

  /** O(1), in the input path: a key press during the count-in or a Keep time pass (U112). */
  #keepTimePress(note: number, time: number, velocity: number): void {
    const activity = this.#keepTimeActivity
    if (!activity) {
      // The count-in's last stretch may hold the first downbeat played early (`#endCountIn`);
      // earlier presses are count-in noodling and never count.
      const c = this.#countIn
      if (c && time >= c.from) {
        const full = c.pressCount === COUNT_IN_PRESSES
        const k = full ? c.pressHead : (c.pressHead + c.pressCount) % COUNT_IN_PRESSES
        c.pressTimes[k] = time
        c.pressNotes[k] = note
        c.pressVelocities[k] = velocity
        if (full) c.pressHead = (c.pressHead + 1) % COUNT_IN_PRESSES
        else c.pressCount++
      }
      return
    }
    this.#creditKeepTimePress(activity, note, time - this.#keepTimeShift())
    // A late timer can leave bars due; this press cannot belong to them (they ended before it).
    this.#checkKeepTimeActivity(time)
  }

  /**
   * A press at `t` (on the music's clock) counts for every bar k with t in [start k − tolerance,
   * end k): an early downbeat counts for its own bar and for the bar it fell in. The opening check
   * takes a pitch from the same early start of the first bar on. Walks only the bars not judged yet
   * that the press can reach (one or two).
   */
  #creditKeepTimePress(activity: KeepTimeActivity, note: number, t: number): void {
    const { bars, early } = activity
    const opening = activity.opening
    if (opening && opening.pitches.has(note) && t >= bars[0]!.start - early && t < opening.end) activity.opening = null
    for (let k = activity.bar; k < bars.length; k++) {
      const bar = bars[k]!
      if (t < bar.start - early) return
      if (t < bar.end) activity.played[k] = 1
    }
  }

  /** U112: the unattended pass stops and is dropped, also one the engine already completed. */
  #stopInactiveKeepTime(): void {
    this.#keepTimeActivity = null
    this.#reviewReturnBy = null
    this.#setCorrectionsVisible(true)
    this.#discarding = true
    try {
      this.pause()
    } finally {
      this.#discarding = false
    }
  }

  /** A completed pass goes on once no bar left can be judged silent: every remaining bar was played. */
  #finishKeepTimeActivity(activity: KeepTimeActivity): void {
    if (!activity.completed || activity.opening) return
    for (let k = activity.bar; k < activity.bars.length; k++) if (!activity.played[k]) return
    this.#keepTimeActivity = null
    this.#onRecord(activity.completed)
    this.#completedPending = true
  }

  /**
   * The pass is left before its silent-bar check ended (a pause, seek, selection or mode change,
   * a lost input or output, Again, leaving the view). A completed record still waiting for its last
   * bars is kept, as if they had been played, once the Repeat opening check has seen someone play.
   * While that check is still pending the pass shows no sign of a player, so it is dropped as the
   * unattended stop drops it (U112): no record, the previous result and its review come back. No
   * Repeat reset follows (`#completedPending` stays): what cleared the activity decides what plays
   * next. Returns whether a record was handed on.
   */
  #releaseKeepTime(): boolean {
    const activity = this.#keepTimeActivity
    if (!activity) return false
    this.#keepTimeActivity = null
    if (!activity.completed) return false
    if (this.#openingPending(activity)) {
      this.#reviewReturnBy = null
      this.#setCorrectionsVisible(true)
      return false
    }
    this.#onRecord(activity.completed)
    return true
  }

  /**
   * The Repeat opening check (U112) has not seen a learner pitch yet. In the first traversal of a
   * loop inside one bar the check carries to the next traversal (`waitAnotherPass`): there the bar
   * having been played is the evidence its end would accept, and an unplayed bar is the silent bar
   * its end would stop.
   */
  #openingPending(activity: KeepTimeActivity): boolean {
    const opening = activity.opening
    if (!opening) return false
    if (!opening.waitAnotherPass) return true
    for (let k = 0; k < activity.bars.length; k++) if (!activity.played[k]) return true
    return false
  }

  /**
   * Click the count-in's beats after `now` again: a Metronome switch turned off meanwhile
   * canceled the sink (`setMetronomeEnabled(false)`), but the count-in always clicks (P20).
   */
  #reclickCountIn(now: number): void {
    const c = this.#countIn
    if (!c) return
    for (let k = 0; k < c.beats; k++) {
      const time = c.start + k * c.beatMs
      if (time > now) this.#metronomeSink.click(time, k === 0)
    }
  }

  /** Cancel a count-in in progress: its timer and its clicks still to come (through the sink). */
  #cancelCountIn(now: number): void {
    const c = this.#countIn
    if (!c) return
    this.#countIn = null
    if (c.timer !== null) this.#deps.timers.clearTimeout(c.timer)
    this.#metronomeSink.cancel(now)
    this.#scheduleFrame()
  }

  /**
   * The cursor's repeat button (U14): opens Repeat mode with a fresh one-bar loop at `occ` (the
   * cursor's bar), replacing a remembered loop.
   */
  repeatFrom(occ: number): void {
    if (this.#playRequired()) return
    const at = Math.max(0, Math.min(this.#model.occurrences.length - 1, Math.trunc(occ)))
    this.#select({ hands: this.#sel.hands, multiplier: this.#sel.multiplier }, { fromOcc: at, toOcc: at }, true)
  }

  /**
   * The cursor's repeat button, pressed (U14): pauses what plays, then opens Repeat mode with a
   * one-bar loop at the bar the button was over: `occ` when the view reports one (the strip's
   * cursor line is fixed on screen, so while browsing the music under it is another bar than
   * the cursor's), else the cursor's bar. It is never shown in Repeat mode, so there is no toggle.
   */
  repeatAtCursor(occ?: number): void {
    const at = occ ?? occAt(this.#model, this.#cursorPosition())
    if (this.#isPlaying() || this.#browseHold) this.pause()
    this.repeatFrom(at)
  }

  /**
   * The learner started browsing the score (U41: "I should be able to scroll the stage sheet back
   * even in play mode, just discard that attempt"; U95). While something plays (the main button
   * shows Pause, Ready and a finished pass's music playing on included), sound holds while the
   * finger is down, and the attempt or reading pass in progress ends unrecorded: a scored attempt
   * is interrupted; a reading pass pauses where it was and starts over from that note; Listen and
   * play-through pause. The release (`browseReleased`) then continues from the note under the
   * fixed cursor line. Nothing happens when nothing plays, nor in the page layout, whose cursor
   * moves with the notation (`browsedPosition()` null): scrolling there moves no position (U52),
   * so playback goes on.
   */
  browseStarted(): void {
    const strip = this.#strip
    if (strip?.browsedPosition && strip.isBrowsing() && strip.browsedPosition() === null) return
    if (!this.#isPlaying() && !this.#pendingRepeat) return
    const hold = { from: this.#continueFrom() }
    if (this.#playThrough) {
      // Play-through pauses where it is; nothing is recorded to discard.
      this.pause()
      this.#browseHold = hold
      this.#publishUi()
      return
    }
    const now = this.#deps.clock()
    this.#discarding = true
    try {
      this.pause()
      const group = this.#engine.state.groupIndex
      if (!this.#listen && this.#engine.mode === 'reading' && group !== null) {
        // A paused reading pass would go on later as the same pass: end it here, unrecorded, and
        // wait at the same note.
        this.#engine.seek(group, now)
      }
      this.#drain(now)
    } finally {
      this.#discarding = false
    }
    this.#browseHold = hold
    this.#process(now)
  }

  /**
   * The browse gesture was released (the finger lifted, the pointer was canceled, or the wheel
   * went idle; `StripOptions.onBrowseRelease`, U95). When it began while something played,
   * playback continues from the note under the fixed cursor line, exactly as Start after browsing
   * does (`#followBrowsedCursor`), and following is restored. Otherwise nothing happens. Resolves
   * when that Start has.
   */
  browseReleased(): Promise<void> {
    if (!this.#browseHold || this.#disposed) return Promise.resolve()
    return this.start()
  }

  /**
   * Where playback is now, exact, for continuing after a loop change (U94): the next note of a
   * running attempt or lead-in, the onset at or after the cursor while Listen plays or music plays
   * on (a finished pass, a lead-in's tail); null for an attempt waiting at its start (Ready).
   */
  #continueFrom(): Rational | null {
    if (this.#play) return this.#play.follower.state.position ?? null
    if (this.#listen) return this.#onsetAtOrAfter(this.#listen.transport.positionNow())
    const s = this.#engine.state
    if (s.phase === 'running') return s.position ?? null
    if (this.#pendingRepeat || this.#leadInTail()) return this.#onsetAtOrAfter(this.#cursorPosition())
    return null
  }

  /** The first onset of the current hands at or after a float position (null past the last). */
  #onsetAtOrAfter(position: number): Rational | null {
    const onsets = this.snapOnsets
    const at = position - 1e-9
    let lo = 0
    let hi = onsets.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (toNumber(onsets[mid]!) < at) lo = mid + 1
      else hi = mid
    }
    return onsets[lo] ?? null
  }

  /**
   * The view's chrome is revealed (true) or faded into focus mode (false, U13). While playing,
   * the cursor's repeat button shows only with the chrome revealed (U14).
   */
  setChromeRevealed(revealed: boolean): void {
    if (revealed === this.#chromeRevealed) return
    this.#chromeRevealed = revealed
    this.#syncLock()
    this.#strip?.flushFrame?.()
  }

  /**
   * Whether a piano input is connected (U27, DECISIONS P22). Without one a hand plays through the
   * microphone: play-through is on while a hand is selected and follows the microphone. Only when
   * this browser cannot use a microphone either do the hands go off (Listen) without touching the
   * piece's remembered hands; they come back with the piano. A play-through that followed the
   * piano pauses (the next Start opens the microphone), and the reverse when the piano returns.
   */
  setInputAvailable(available: boolean): void {
    if (available === this.#inputAvailable) {
      this.#syncHeldHands()
      return
    }
    this.#inputAvailable = available
    this.#syncHeldHands()
    this.#syncPlayMode()
    if (available && this.#repeatHeld) this.#returnHeldRepeat()
    if (available && this.#rhythmHeld) {
      this.#rhythmHeld = false
      if (!this.#playThrough && this.#sel.hands !== 'none') this.#setRhythm(true, false)
    }
    this.#syncFollowSource()
    this.#publishUi()
  }

  /**
   * The piano came back while Repeat was held closed by the no-piano rule (DECISIONS U98): Repeat
   * reopens over the remembered loop, paused at its start (nothing starts by itself). When it
   * cannot (play-through stayed on by the learner's choice, or no loop), the piece's stored
   * Repeat is closed so storage matches the screen.
   */
  #returnHeldRepeat(): void {
    this.#repeatHeld = false
    if (this.#repeat) return
    if (!this.#playThrough && this.#loop) this.setRepeatMode(true)
    if (!this.#repeat) this.#deps.piece.save({ repeatOpen: false }, true)
  }

  /**
   * Without a piano, play-through is how a hand plays (DECISIONS P22): on while a hand is selected,
   * whatever the learner chose; with the piano, the learner's choice.
   */
  #syncPlayMode(): void {
    if (this.#disposed) return
    const want = this.#playRequired() || (this.#playThroughChosen && this.#sel.hands !== 'none')
    if (want !== this.#playThrough) this.#setPlayThrough(want)
  }

  /**
   * What the play-through follows changed (a piano came or went, the Follow choice): a started
   * play-through pauses where it is and is rebuilt for the new source on the next Start (the
   * microphone opens or closes then; one hand gets or loses its accompaniment).
   */
  #syncFollowSource(): void {
    const p = this.#play
    if (!p || p.mic === this.#micActive()) return
    this.#pausePlay(this.#deps.clock())
    this.#disposePlay(true)
    this.#process(this.#deps.clock())
  }

  /** The hands are held off while no piano is connected and no microphone can stand in (U27, P22). */
  #syncHeldHands(): void {
    const available = this.#inputAvailable || this.#micPossible()
    if (available === (this.#heldHands === null)) {
      this.#publishUi()
      return
    }
    const multiplier = this.#sel.multiplier
    if (available) {
      const hands = this.#heldHands ?? this.#sel.hands
      this.#heldHands = null
      this.#select({ hands, multiplier }, this.#loop, this.#repeat, false)
    } else {
      this.#heldHands = this.#sel.hands
      this.#select({ hands: 'none', multiplier }, this.#loop, this.#repeat, false)
    }
    this.#publishUi()
  }

  /** Consecutive clean passes after which Repeat stops restarting (null: no limit). */
  setRepeatTarget(target: number | null): void {
    if (target === this.#repeatTarget) return
    this.#repeatTarget = target
    this.#deps.piece.save({ repeatTarget: target }, true)
    this.#publishUi()
  }

  /**
   * The speed ladder (Repeat mode; null = off), persisted like the Repeat target. The 100% preset
   * can set an opening speed of 75% when the user selects it.
   */
  setLadder(ladder: LadderSettings | null): void {
    if (sameLadder(ladder, this.#ladderSettings)) return
    const speed = this.#sel.multiplier
    const startAt = ladder?.goal === LADDER_FULL_SPEED_GOAL ? fullSpeedLadderStart(speed) : speed
    this.#ladderSettings = ladder
    this.#ladder = ladder ? startLadder(ladder, startAt) : null
    this.#ladderNext = null
    this.#deps.piece.save({ ladder }, true)
    // Both piece updates are coalesced by the saver. The new speed takes the manual tempo-change path.
    if (startAt !== speed) this.#select({ hands: this.#sel.hands, multiplier: startAt }, this.#loop, this.#repeat)
    this.#publishUi()
  }

  /**
   * What the expanded result card ranks (DECISIONS U99): the last result's record with the
   * records before it, its timeline and its correction marks per group. Built on demand (the
   * learner expands the card), never in the MIDI input path; null when there is no result, or its
   * record is gone.
   */
  resultDetails(): ResultDetails | null {
    const result = this.#lastResult
    const latest = this.#resultRecords.at(-1)
    const timeline = this.#resultTimeline
    if (!result || !latest || latest.id !== result.id || !timeline) return null
    const marks = correctionMarksByGroup(latest, timeline, this.#model, this.#settings.naming)
    return { attemptId: result.id, records: this.#resultRecords, timeline, marks }
  }

  /** Opening Keep time details makes room for bar playback by stopping the tail or next count-in. */
  openResultDetails(attemptId: string): void {
    if (this.#lastResult?.id !== attemptId || this.#engine.transport !== 'strict') return
    const phase = this.#engine.state.phase
    const finishing = phase === 'completed' && this.#accomp?.state === 'playing'
    if (!finishing && !this.#pendingRepeat && !this.#countIn && phase !== 'preparing') return
    this.#reviewReturnBy = null
    this.pause()
  }

  /**
   * Why a mistake snippet cannot play now (U100), or null when it can: something is playing or
   * counting in, the microphone follows (P22), there is nowhere to send sound, the result is gone,
   * or (What you played) no key of that bar was captured.
   */
  snippetBlocked(attemptId: string, occ: number, kind: SnippetKind): string | null {
    if (this.#lastResult?.id !== attemptId || !this.#resultTimeline) return msg('This pass is over.')
    if (this.#play?.mic) return msg('Not while the microphone follows.')
    if (
      this.#engine.state.phase === 'running' ||
      this.#countIn ||
      this.#listen?.playing ||
      this.#play?.playing ||
      // A gated transport waiting at the next pass's first note plays nothing: not "playing".
      (this.#accomp?.state === 'playing' && this.#accomp.holdingGate === null)
    )
      return msg('Plays once the music stops.')
    if (!this.#destination()) return msg('No sound output: connect the piano or allow this device to play.')
    if (kind === 'played' && this.#playedSnippet(attemptId, occ).notes.length === 0)
      return msg('No keys were captured in this bar.')
    return null
  }

  /**
   * Plays bar `occ` of the last pass (U100): `played`, the learner's own presses replayed;
   * `written`, the bar from the score at the pass's speed. Through the same destination as Listen;
   * on a piano not verified echo-free its notes coming back are kept from the input while they
   * sound. Never touches the position, the loop, the records or the result. Resolves with why it
   * did not play, or null.
   */
  async playSnippet(attemptId: string, occ: number, kind: SnippetKind): Promise<string | null> {
    this.#stopSnippet()
    const blocked = this.snippetBlocked(attemptId, occ, kind)
    if (blocked) return blocked
    const output = await this.#ensureOutput()
    if (!output) return msg('No sound output: connect the piano or allow this device to play.')
    // The tap's await may have let the next pass start.
    const again = this.snippetBlocked(attemptId, occ, kind)
    if (again) return again
    const snippet =
      kind === 'played'
        ? this.#playedSnippet(attemptId, occ)
        : writtenSnippet(this.#model, this.#tempo, this.#resultMultiplier(), occ)
    if (snippet.notes.length === 0) return msg('Nothing to play in this bar.')
    const echo = output.kind === 'midi' && this.#settings.route.echo !== 'none'
    const player = new SnippetPlayer(snippet, output, this.#deps.clock, this.#deps.timers, () => {
      if (this.#snippet?.player !== player) return
      this.#snippet = null
      this.snippet.set(null)
    })
    this.#snippet = { player, echo }
    this.snippet.set({ occ, kind, shortened: snippet.shortened })
    return null
  }

  /** Stops the mistake snippet at once (the card folds, the result ends, a key is pressed). */
  stopSnippet(): void {
    this.#stopSnippet()
  }

  #stopSnippet(): void {
    const s = this.#snippet
    if (!s) return
    this.#snippet = null
    s.player.stop()
    this.snippet.set(null)
  }

  #playedSnippet(attemptId: string, occ: number) {
    const pass = this.#capture.pass(attemptId)
    const timeline = this.#resultTimeline
    if (!pass || !timeline) return { notes: [], pedals: [], length: 0, shortened: false }
    const groups = new Set<number>()
    for (const g of timeline.groups) if (g.occ === occ) groups.add(g.index)
    return playedSnippet(pass.keys, groups, pass.pedals, this.#lastResult?.timing !== undefined)
  }

  /** The speed the last result's pass ran at (its record's), else the current one. */
  #resultMultiplier(): number {
    return this.#resultRecords.at(-1)?.context.multiplier ?? this.#sel.multiplier
  }

  /** Dismiss the compact result card. */
  dismissResult(): void {
    this.#lastResult = null
    this.#clearCorrections()
    this.#publishUi()
    // The strip's review ends in the next frame (U97).
    this.#scheduleFrame()
  }

  // ── Selection ─────────────────────────────────────────────────────────────────────────

  /**
   * Hands, passage or speed changed. A scored attempt in progress is interrupted and, when the
   * new selection still allows it, a fresh attempt is prepared (new comparison context);
   * reading continues from the current position; Preview reschedules speed live. A loop changed
   * while Repeat plays keeps playing (U94, `#select`).
   */
  setSelection(patch: Partial<Selection>): void {
    const speed = patch.multiplier
    if (this.#ladder && speed !== undefined && Math.abs(speed - this.#sel.multiplier) > 1e-9) {
      this.#ladder = startLadder(this.#ladder, speed)
      this.#publishUi()
    }
    let loop = this.#loop
    let repeat = this.#repeat
    if (patch.range !== undefined) {
      loop = clampPassage(this.#model, patch.range)
      // Clearing the loop (Clear passage, the strip's ✕) leaves Repeat mode (U10).
      if (!loop) repeat = false
    }
    this.#select(
      { hands: patch.hands ?? this.#sel.hands, multiplier: patch.multiplier ?? this.#sel.multiplier },
      loop,
      repeat,
    )
    // Without a piano a hand chosen means play-through (DECISIONS P22).
    this.#syncPlayMode()
  }

  /**
   * `persist` false: a selection the session imposes (hands held without a piano), not the
   * learner's. `ladder`: the speed ladder's step after a completed attempt: the result card and
   * its marks stay, and a fresh attempt is prepared at the new speed.
   *
   * A loop changed while Repeat plays (U94; the main button shows Pause, or a browse hold waits)
   * keeps playing over the new loop from where it played when that lies inside the new loop, else
   * from its start: Listen rebuilds its transport there; with a hand on, an attempt in progress
   * ends as interrupted ('range-change', never a result; the streak starts over), then a lead-in
   * plays from there (U70), or the next attempt waits at the loop start at Ready (always so in
   * Keep time, and for an attempt that was still waiting at Ready). Paused, interrupted or never
   * started, a loop change only moves the loop, as before.
   */
  #select(
    base: Omit<Selection, 'range'>,
    loop: PassageRange | null,
    repeat: boolean,
    persist = true,
    ladder = false,
  ): void {
    // Any selection change cancels a ladder speed waiting for the Repeat reset.
    this.#ladderNext = null
    // Repeat mode and Listen (hands off, also held without a piano) are not play-through. Without a
    // piano, choosing a hand in Repeat mode turns it back on and closes Repeat (`#syncPlayMode`).
    if (this.#playThrough && (repeat || base.hands === 'none')) {
      this.#playThroughChosen = false
      this.#setPlayThrough(false)
    }
    const next: Selection = { ...base, range: repeat ? loop : null }
    const prev = this.#sel
    const modeChanged = repeat !== this.#repeat
    // While the hands are held without a piano (U27) the learner's own hands are saved, never 'none'.
    const handsChanged = this.#heldHands === null && base.hands !== prev.hands
    const loopChanged = !samePassage(loop, this.#loop)
    // Repeat closed by the no-piano rule stays open on the piece until the piano returns (U98).
    const heldClose = modeChanged && !repeat && this.#repeatHeld
    if (repeat || !loop) this.#repeatHeld = false
    // Repeat opened or closed, or the loop cleared, is saved on the piece (U98).
    const saveMode = (modeChanged && !heldClose) || (loopChanged && !loop)
    if (persist && (handsChanged || base.multiplier !== prev.multiplier || loopChanged || saveMode)) {
      // The learner's own change comes from a tap or a drag (never the MIDI path) and a reload
      // right after must find it: written at once (the saver coalesces). Only the speed ladder's
      // step stays debounced: it runs from the MIDI path, which never starts a write.
      this.#deps.piece.save(
        {
          lastHands: this.#heldHands ?? base.hands,
          lastPassage: loop,
          lastMultiplier: base.multiplier,
          ...(saveMode ? { repeatOpen: repeat } : {}),
        },
        !ladder,
      )
    }
    this.#loop = loop
    this.#repeat = repeat
    if (!repeat) this.#pendingRepeat = false
    if (sameSelection(next, prev)) {
      if (modeChanged) this.#process(this.#deps.clock())
      return
    }
    // A completed Keep time pass still waiting for its last bar is recorded; the change then ends
    // its result and its ladder step as for any finished pass.
    if (this.#releaseKeepTime()) this.#ladderNext = null
    // The result card goes with its corrections (U39), unless the ladder set the speed after it.
    if (!ladder) {
      this.#lastResult = null
      this.#clearCorrections()
    }
    const now = this.#deps.clock()
    // Whether something plays (the main button shows Pause), read before anything changes (U94).
    const hold = this.#browseHold
    const playing = hold !== null || this.#isPlaying() || this.#pendingRepeat
    this.#cancelCountIn(now)
    const reason: InterruptReason =
      next.hands !== prev.hands
        ? 'hand-change'
        : modeChanged
          ? 'mode-change'
          : !samePassage(next.range, prev.range)
            ? 'range-change'
            : 'tempo-change'
    // The loop changed while Repeat played (U94): it plays on over the new loop, from where it
    // played when that lies inside the new loop, else from the loop start.
    const keepLoop = playing && reason === 'range-change' && next.range !== null
    const from = keepLoop ? (hold ? hold.from : this.#continueFrom()) : null
    if (keepLoop && hold) {
      // Changed during a browse hold (a handle drag that scrolled the strip, U95): the loop change
      // decides where playback goes on, and the strip follows it again.
      this.#browseHold = null
      this.#strip?.returnToCurrent?.()
    }

    if (this.#play && this.#selectPlay(next, reason, now)) return

    if (this.#listen) {
      if (reason === 'tempo-change') {
        this.#sel = next
        this.#listen.transport.setMultiplier(next.multiplier)
        this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
        this.#bothTimeline = null
        this.#process(now)
        return
      }
      if (keepLoop && this.#replayListen(next, from, now)) return
      this.#stopListening()
    }

    const lead = this.#leadIn
    if (lead && !lead.handedOver && reason === 'tempo-change' && this.#engine.mode === 'reading') {
      // A lead-in keeps going at the new speed (its gates do not move).
      this.#sel = next
      this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
      lead.timeline = selectionTimeline(
        this.#model,
        this.#tempo,
        { ...next, range: lead.passage },
        {
          reattackHeldAtStart: false,
        },
      )
      this.#bothTimeline = null
      this.#engine.reconfigure({ reason, timeline: lead.timeline, transport: 'accompaniment' }, now)
      this.#accomp?.setMultiplier(next.multiplier)
      this.#process(now)
      return
    }

    if (reason === 'tempo-change' && this.#engine.mode === 'reading') {
      // Keep the musical clock between gates; rebuilding at the next target would jump ahead.
      this.#sel = next
      this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
      this.#bothTimeline = null
      // Keep time reads across the whole score after a seek outside the loop: the new speed returns
      // to the loop at its start (the position outside it has no group there).
      const elsewhere = !samePassage(this.#engine.timeline.range, this.#timeline.range)
      this.#engine.reconfigure(
        { reason, timeline: this.#timeline, transport: 'accompaniment', ...(elsewhere ? { startGroup: 0 } : {}) },
        now,
      )
      this.#accomp?.setMultiplier(next.multiplier)
      this.#process(now)
      return
    }

    const phase = this.#engine.state.phase
    if (!persist && phase === 'interrupted' && this.#engine.state.interruptReason === 'disconnect') {
      // The hands held while the piano is away (U27), or given back: the attempt's disconnect
      // interruption stays for the piano's return (U32). The engine keeps the learner's timeline
      // and transport; only the session's selection follows the hold.
      this.#pauseTransports()
      this.#sel = next
      this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
      this.#bothTimeline = null
      this.#applySelectionVisuals()
      this.#process(now)
      return
    }
    // A loop change while Repeat plays with a hand on goes on as a new run (U94): an attempt in
    // progress ends ('range-change'), then the next attempt waits at the loop start at Ready, or a
    // lead-in plays from where it played (below).
    const keepScored = keepLoop && next.hands !== 'none'
    const scoredActive = (this.#engine.mode === 'scored' && (ladder || ACTIVE.includes(phase))) || keepScored
    // Any other change ends a lead-in: the session stops where Repeat mode would (P4).
    const leadReading = lead !== null && this.#engine.mode === 'reading'
    const leadPosition = leadReading ? (this.#engine.state.position ?? lead.start) : null
    const readingRunning = !leadReading && this.#engine.mode === 'reading' && phase === 'running'
    const keepCursor = this.#rhythm && !repeat && !prev.range && this.#engine.transport === 'strict'
    const cursor = keepCursor ? this.#cursorPosition() : null
    this.#pauseTransports()
    this.#disposeAccompaniment()
    this.#leadIn = null
    if (leadReading) this.#readingStarted = false
    this.#awaitPrepared = false
    this.#pendingRepeat = false
    this.#sel = next
    this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
    this.#bothTimeline = null
    const cursorOnset = cursor === null ? null : this.#onsetAtOrAfter(cursor)
    const attemptTimeline = this.#timelineFrom(scoredActive ? cursorOnset : null)
    const plan = this.#plan(attemptTimeline)
    // A new passage reads from its start; closing Repeat mode reads on from the loop's start (or
    // from where a lead-in was).
    const startGroup =
      prev.range && !next.range
        ? groupAtOrAfter(this.#timeline, leadPosition ?? passageRange(this.#model, prev.range).start)
        : cursorOnset
          ? groupAtOrAfter(this.#timeline, cursorOnset)
          : 0

    if (keepScored && from && plan.action === 'scored' && plan.enabled && !this.#rhythm) {
      // Inside the new loop but not at its start, or before it while a lead-in read toward the
      // loop: a lead-in from there that plays at once, as a seek while Repeat plays (U70). Past the
      // loop, or at its start: the attempt at the loop start below. Keep time has no lead-ins.
      const bounds = passageRange(this.#model, next.range)
      if (!eq(from, bounds.start) && lt(from, bounds.end) && (leadReading || !lt(from, bounds.start))) {
        this.#seekLeadIn(from, now, { play: true, reason })
        return
      }
    }

    if (this.#engine.mode === 'scored' || scoredActive) {
      if (scoredActive && plan.action === 'scored' && plan.enabled) {
        this.#engine.reconfigure({ reason, timeline: attemptTimeline, mode: 'scored', ...this.#scoredKind() }, now)
        this.#streak = 0
        this.#ensureTransport((t) => this.#tryPrepared(t))
        this.#prepareAttempt(now)
      } else {
        this.#engine.reconfigure(
          { reason, timeline: this.#timeline, mode: 'reading', transport: 'accompaniment', startGroup },
          now,
        )
        if (this.#engine.state.phase === 'running') this.#engine.pause(now)
        this.#readingStarted = false
      }
    } else {
      const rangeChanged = !samePassage(next.range, prev.range)
      this.#engine.reconfigure(
        { reason, timeline: this.#timeline, transport: 'accompaniment', ...(rangeChanged ? { startGroup } : {}) },
        now,
      )
      if (readingRunning && plan.enabled && plan.action !== 'listen') {
        this.#ensureTransport((t) => {
          if (this.#engine.mode === 'reading' && this.#engine.state.phase === 'running')
            this.#playAccompanimentFromCurrent(t)
        })
        this.#playAccompanimentFromCurrent(now)
      } else if (this.#engine.state.phase === 'running') {
        this.#engine.pause(now)
      }
    }
    this.#applySelectionVisuals()
    this.#process(now)
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────

  /**
   * `onBeforeApplyLabels`: runs before the new labels exist, so a scored attempt is interrupted
   * first (spec "Persistent score labels", DECISIONS A2, E10).
   */
  beforeApplyLabels(next: SessionSettings['labels']): void {
    const now = this.#deps.clock()
    this.#engine.updateSettings({ labelSettings: labelSnapshot(next) }, now)
    this.#process(now)
  }

  updateSettings(next: SessionSettings): void {
    const prev = this.#settings
    if (prev === next) return
    this.#settings = next
    const now = this.#deps.clock()
    if (prev.naming !== next.naming && this.#labels.setNaming(next.naming)) {
      this.#strip?.setLabels(this.#labels.texts)
      this.#lastVersion = -1
    }
    if (prev.hints !== next.hints) {
      this.#labels.setFadeMs(next.hints.fadeMs)
      this.#engine.updateSettings({ hints: next.hints }, now)
      if (!next.hints.damageFlash) this.#flash?.clear()
    }
    if (prev.labels !== next.labels) {
      this.#engine.updateSettings({ labelSettings: labelSnapshot(next.labels) }, now)
      if (this.#labels.setLabels(next.labels, now)) {
        this.#labelsDirty = true
        this.#lastVersion = -1
      }
    }
    const playbackChanged = (prev.rhythm?.scorePlayback ?? false) !== (next.rhythm?.scorePlayback ?? false)
    if (this.#toleranceMs(prev) !== this.#toleranceMs(next)) {
      const was = this.#engine.state.phase
      this.#engine.updateSettings({ rhythm: this.#rhythmParams(next) }, now)
      if (was !== 'interrupted' && this.#engine.state.phase === 'interrupted') {
        this.#cancelCountIn(now)
        this.#interruptText = msg('The Keep time tolerance changed, so the attempt stopped.')
      }
    }
    const muteChanged = playbackAudible(prev) !== playbackAudible(next)
    if ((playbackChanged || muteChanged) && this.#accomp && this.#engine.transport === 'strict') {
      const transport = this.#accomp
      if (
        this.#playbackHeard() &&
        !accompanimentAllowed(next, this.#deps.midi.output(), this.#browserSoundPossible())
      ) {
        this.#soundStatus = this.#plan().reason
      } else if (this.#practiceSilent() || this.#ensureOutputSync()) {
        this.#soundStatus = null
        this.#ensureAccompaniment(true)
      } else {
        void this.#ensureOutput().then((output) => {
          if (output && !this.#disposed && this.#accomp === transport) this.#ensureAccompaniment(true)
        })
      }
    }
    if (prev.pedal !== next.pedal) {
      if (this.#playThrough) this.#playPedal = this.#hintPedal(next)
      this.#engine.updateSettings(
        { hintPedal: this.#hintPedal(next), hintPedalAction: next.pedal.hintPedalAction },
        now,
      )
    }
    if (this.#output && outputKey(next, this.#destination()) !== this.#outputKey) {
      this.#destinationChanged()
    } else if (performanceKey(prev) !== performanceKey(next) && !this.#isPlaying()) {
      this.#disposeAccompaniment()
      // A paused one-hand play-through is rebuilt with the new automatic part on Start.
      if (this.#play && this.#play.outputKey !== '') this.#disposePlay(true)
    }
    if ((prev.mic?.follow ?? false) !== (next.mic?.follow ?? false)) {
      // The Follow choice (P22): a started play-through pauses and is rebuilt for the new source.
      this.#syncFollowSource()
      this.#play?.transport.setMetronomeEnabled(this.#playMetronome())
      this.#publishUi()
    }
    // Volumes apply live to sound already loaded (Settings over Practice).
    if (prev.sound.browserVolume !== next.sound.browserVolume) this.#browser?.setVolume(next.sound.browserVolume)
    if (prev.metronome.volume !== next.metronome.volume) this.#metronome?.setVolume(next.metronome.volume)
    const outputChanged = prev.metronome.outputId !== next.metronome.outputId
    if (outputChanged) void this.#ensureMetronome(this.#countIn !== null)
    if (prev.metronome.enabled !== next.metronome.enabled || prev.metronome.keepTime !== next.metronome.keepTime) {
      // Each transport by its own rule (DECISIONS P20). Switching a click off cancels the sink,
      // which also holds the count-in's beats: those still to come are clicked again.
      if (!outputChanged) void this.#ensureMetronome()
      const cancels = this.#sinkCancels
      this.#accomp?.setMetronomeEnabled(this.#practiceClick())
      this.#listen?.transport.setMetronomeEnabled(next.metronome.enabled)
      this.#play?.transport.setMetronomeEnabled(this.#playMetronome())
      if (this.#sinkCancels !== cancels) this.#reclickCountIn(now)
    }
    this.#process(now)
  }

  /**
   * The layout is being re-prepared (label width, label room, rotation): an explicit layout
   * operation. `keepStrip`: the current view stays on screen until the new one attaches (a
   * respacing glide, R3 revised), so it keeps receiving label fades meanwhile.
   */
  layoutChanging(keepStrip = false): void {
    const now = this.#deps.clock()
    if (this.#engine.mode === 'scored' && ACTIVE.includes(this.#engine.state.phase)) {
      this.#pauseTransports()
      this.#engine.interrupt('layout-change', now)
    }
    if (!keepStrip) this.#strip = null
    this.#process(now)
  }

  /**
   * Zoom or orientation changed. Spacing never changes with them (CSS scale, R2) and timing is
   * not affected, so nothing is interrupted, not even a running scored attempt (DECISIONS P5
   * revised). Kept as the view's hook for these changes.
   */
  viewChanged(): void {
    this.#scheduleFrame()
  }

  /** Page hidden / app switched: save progress while playback and practice keep running. */
  suspend(): void {
    this.#saveResume(this.#deps.clock(), true)
  }

  /**
   * An overlay opened over Practice (Settings, Connection): pause and keep keys away from the
   * engine. On release, forget keys pressed meanwhile so held keys never become attacks.
   */
  holdInput(held: boolean): void {
    if (held === this.#inputHeld || this.#disposed) return
    this.#inputHeld = held
    if (held) {
      this.pause()
      return
    }
    const now = this.#deps.clock()
    this.#engine.resetPhysical(now)
    this.#play?.follower.resetPhysical(now)
    this.#processPlay()
    this.#process(now)
  }

  /** Leaving the view: a running attempt is a user stop, a paused reading pass is recorded; output is cleaned up. */
  dispose(): void {
    if (this.#disposed) return
    const now = this.#deps.clock()
    // A completed Keep time pass still waiting for its last bar is stored (leaving is not an
    // unattended stop); nothing plays or publishes after this.
    this.#releaseKeepTime()
    if (
      this.#engine.state.phase === 'running' ||
      (this.#engine.mode === 'scored' && ACTIVE.includes(this.#engine.state.phase))
    ) {
      this.#engine.interrupt('user-stop', now)
    }
    this.#cancelCountIn(now)
    this.#saveResume(now, true)
    // A paused reading pass is recorded too (per-bar history, ST2). 'suspend' abandons nothing:
    // pausing and leaving is not giving up at that bar.
    if (this.#engine.mode === 'reading' && this.#engine.state.phase === 'paused') {
      this.#engine.interrupt('suspend', now)
    }
    this.#drain(now)
    this.#disposed = true
    this.#browseHold = null
    this.#stopListening()
    this.#disposePlay(false)
    this.#disposeAccompaniment()
    this.#disposeOutput()
    for (const off of this.#unsubs.splice(0)) off()
    if (this.#frameHandle !== null) this.#deps.frames.cancel(this.#frameHandle)
    if (this.#tickHandle !== null) this.#deps.timers.clearTimeout(this.#tickHandle)
    this.#frameHandle = null
    this.#tickHandle = null
    this.#clearCorrections()
    this.#stopSnippet()
    this.#capture.clear()
    this.#strip = null
  }

  // ── MIDI input path (O(small)) ────────────────────────────────────────────────────────

  #onMidi(ev: MidiInputEvent): void {
    if (this.#disposed) return
    // A mistake snippet (U100): on a piano that may echo, its own notes and pedals (U101) coming
    // back are not the learner; any other press stops it at once and is then handled as always.
    const snippet = this.#snippet
    if (snippet) {
      if ((ev.kind === 'noteon' || ev.kind === 'noteoff') && snippet.echo && snippet.player.sounds(ev.note, ev.time))
        return
      if (ev.kind === 'cc' && snippet.echo && snippet.player.drivesPedal(ev.controller)) return
      if (ev.kind === 'noteon') this.#stopSnippet()
    }
    this.#midiBackend?.humanInput(ev)
    // The monitor hears releases under an overlay too, so no key or pedal stays down in it.
    this.#monitor?.(ev)
    if (this.#inputHeld) return
    // Echoes of Preview output on an echoing route must never reach the engine (spec).
    if (this.#listen && this.#settings.route.echo === 'echo-detected' && this.#outputKind === 'midi') return
    // Play-through: the hint pedal names the notes at the cursor; once started, the follower
    // has the keys (the engine stays paused where it was).
    if (this.#playThrough && this.#playPedal?.feed(ev)) this.revealAtCursor()
    const play = this.#play
    if (play) {
      // The microphone has the cursor (P22): the piano's keys never move it, so nothing counts twice.
      if (play.mic) return
      play.follower.input(ev)
      this.#processPlay()
      return
    }
    if (ev.kind === 'noteon' && ev.velocity > 0) this.#keepTimePress(ev.note, ev.time, ev.velocity)
    // Judged before the input: a press never changes the group or phase while nothing plays.
    const group = this.#previewGroupNow()
    this.#captureKey(ev)
    if (this.#engine.transport === 'strict' && ev.kind === 'noteon' && ev.velocity > 0) {
      const { phase, clockStartedAt } = this.#engine.state
      if (phase === 'running' && clockStartedAt !== null) {
        // The written onsets move with the music when a stall shifted it (the engine grades so too).
        const start = clockStartedAt + this.#keepTimeShift()
        this.#timingDrift.attack(ev.note, ev.time, start, this.#toleranceMs(this.#settings))
      }
    }
    this.#engine.input(ev)
    if (group !== null) this.#previewInput(ev, group)
    else this.#clearPreview()
    this.#process(ev.time)
  }

  /**
   * O(1): the key and pedal events of a scored pass, for "What you played" (U100, U101). A press
   * at Ready starts a pass; releases and pedal moves after the pass ended still land on it (its
   * last chord's keys and the pedal come up later). The hint pedal is never kept: it is no sound.
   */
  #captureKey(ev: MidiInputEvent): void {
    if (ev.kind === 'cc') {
      if (!SNIPPET_PEDALS.includes(ev.controller)) return
      const hint = this.#settings.pedal.hintPedal
      if (hint && hint.controller === ev.controller && (hint.channel === null || hint.channel === ev.channel)) return
      this.#capture.pedal(ev.time, ev.controller, ev.value, this.#engine.mode === 'scored')
      return
    }
    if (this.#engine.mode !== 'scored') return
    const phase = this.#engine.state.phase
    const velocity = ev.kind === 'noteon' ? ev.velocity : 0
    if (phase === 'ready' && velocity > 0) this.#capture.begin(ev.time)
    if (phase === 'ready' || phase === 'running') {
      if (velocity > 0 || phase === 'running')
        this.#capture.add(ev.time, ev.note, velocity, this.#engine.state.groupIndex ?? -1)
      else this.#capture.release(ev.time, ev.note)
    } else if (velocity === 0) this.#capture.release(ev.time, ev.note)
  }

  /** The group presses are previewed against (U31): nothing plays, not Listen, a group exists. */
  #previewGroupNow(): number | null {
    if (this.#listen || this.#sel.hands === 'none' || this.#isPlaying()) return null
    return this.#engine.state.groupIndex
  }

  /** O(1) per event: one set update; the strip and guide follow in the next frame. */
  #previewInput(ev: MidiInputEvent, group: number): void {
    this.#syncPreview(group)
    if (ev.kind === 'noteon' && ev.velocity > 0) {
      // The engine's timeline: a lead-in's groups during a lead-in.
      const required = this.#engine.timeline.groups[group]?.pitches.includes(ev.note) ?? false
      ;(required ? this.#previewAccepted : this.#previewWrong).add(ev.note)
      this.#previewDirty = true
    } else if (ev.kind === 'cc') {
      if (ev.controller === CC_ALL_NOTES_OFF) this.#clearPreview()
    } else if (this.#previewAccepted.delete(ev.note) || this.#previewWrong.delete(ev.note)) {
      this.#previewDirty = true
    }
  }

  /** The preview belongs to one group of one timeline: a seek or a new selection clears it. */
  #syncPreview(group: number | null): void {
    const timeline = this.#engine.timeline
    if (this.#previewTimeline === timeline && this.#previewGroup === group) return
    this.#clearPreview()
    this.#previewTimeline = timeline
    this.#previewGroup = group
  }

  #clearPreview(): void {
    if (this.#previewAccepted.size === 0 && this.#previewWrong.size === 0) return
    this.#previewAccepted.clear()
    this.#previewWrong.clear()
    this.#previewDirty = true
  }

  /**
   * Per frame, only while preview keys exist: Start, Listen, a seek or a new selection clears
   * them, and keys released without a Note Off reaching the session (an overlay, a disconnect)
   * are dropped by the engine's held keys.
   */
  #maintainPreview(s: EngineState): void {
    if (this.#previewAccepted.size === 0 && this.#previewWrong.size === 0) return
    const group = this.#previewGroupNow()
    if (group === null) {
      this.#clearPreview()
      return
    }
    this.#syncPreview(group)
    for (const set of [this.#previewAccepted, this.#previewWrong]) {
      for (const pitch of set) {
        if (!s.heldKeys.includes(pitch)) {
          set.delete(pitch)
          this.#previewDirty = true
        }
      }
    }
  }

  /** The engine's accepted notes plus the notes of previewed required pitches. */
  #acceptedNotes(s: EngineState): readonly number[] {
    if (this.#previewAccepted.size === 0 || s.groupIndex === null) return s.acceptedNotes
    const g = this.#engine.timeline.groups[s.groupIndex]
    if (!g) return s.acceptedNotes
    const notes = [...s.acceptedNotes]
    for (const pitch of this.#previewAccepted) {
      const k = g.pitches.indexOf(pitch)
      if (k >= 0 && !s.acceptedPitches.includes(pitch)) notes.push(...(g.notesByPitch[k] ?? []))
    }
    return notes
  }

  #onRoute(ev: MidiRouteEvent): void {
    const now = this.#deps.clock()
    switch (ev.kind) {
      case 'input-disconnected': {
        // Nothing continues when a browse is released (U95).
        this.#browseHold = null
        this.#inputDisconnected = true
        if (this.#playThrough) {
          // Play-through pauses (not while the microphone follows); nothing is interrupted or recorded.
          if (!this.#play?.mic) this.#pausePlay(now)
          this.#play?.follower.resetPhysical(now)
          this.#engine.resetPhysical(now)
          break
        }
        const phase = this.#engine.state.phase
        const active =
          this.#engine.mode === 'scored' ? ACTIVE.includes(phase) : this.#readingStarted && phase !== 'completed'
        this.#pauseTransports()
        this.#awaitPrepared = false
        this.#pendingRepeat = false
        if (active) this.#engine.interrupt('disconnect', now)
        else this.#engine.resetPhysical(now)
        this.#saveResume(now, true)
        break
      }
      case 'input-reconnected':
        this.#inputDisconnected = false
        this.#engine.resetPhysical(now)
        this.#play?.follower.resetPhysical(now)
        this.#midiBackend?.resetHuman()
        break
      case 'output-disconnected':
        this.#onOutputLost()
        return
      case 'output-reconnected': {
        if (this.#outputKind === 'browser' && this.#destination() === 'midi') {
          // Auto: a piano came (back) while this device plays. Stop cleanly; the next Start or
          // Play uses the piano (no hot swap mid-play).
          this.#destinationChanged()
        }
        const out = this.#deps.midi.output()
        if (out && this.#midiBackend) this.#midiBackend.reconnect(out, now)
        this.#soundStatus = null
        break
      }
    }
    this.#process(now)
  }

  /** A new sound destination: stop what plays now; the next Start builds the new backend. */
  #destinationChanged(): void {
    if (this.#play && this.#play.outputKey !== '') {
      // A one-hand play-through is rebuilt for the new destination on the next Start.
      this.#disposePlay(true)
    }
    if (this.#playsNothing() && !this.#listen) {
      this.#disposeOutput()
      return
    }
    if (this.#isPlaying()) this.pause()
    this.#stopListening()
    this.#disposeAccompaniment()
    this.#disposeOutput()
  }

  #onOutputLost(): void {
    if (this.#outputKind !== 'midi') return
    if (this.#playsNothing() && !this.#listen) {
      this.#midiBackend?.disconnected()
      this.#disposeOutput()
      this.#soundStatus = null
      return
    }
    const now = this.#deps.clock()
    // Nothing continues when a browse is released (U95).
    this.#browseHold = null
    this.#accomp?.interrupt()
    this.#listen?.transport.interrupt()
    if (this.#listen) this.#listen.playing = false
    if (this.#play) {
      // The next Start rebuilds play-through for the new destination at the same group.
      this.#play.transport.interrupt()
      this.#play.playing = false
      this.#play.follower.pause(now)
    }
    this.#midiBackend?.disconnected()
    // Auto continues through this device on the next Start / Play (S4).
    const onDevice = this.#destination() === 'browser'
    this.#soundStatus = !onDevice
      ? msg('The piano output was disconnected. Reconnect it to hear playback.')
      : this.#listen
        ? msg('The piano output was disconnected. Press Play to keep listening through this device.')
        : msg('The piano output was disconnected. Press Start to continue through this device.')
    if (
      this.#engine.transport !== 'free' &&
      (this.#engine.state.phase === 'running' || ACTIVE.includes(this.#engine.state.phase))
    ) {
      this.#awaitPrepared = false
      this.#pendingRepeat = false
      this.#engine.interrupt('disconnect', now)
    }
    this.#pauseTransports()
    this.#process(now)
  }

  #stopSound(): void {
    // Stuck-note recovery: stop app playback; a scored attempt cannot continue without it.
    if (this.#listen?.playing || this.#play?.playing) this.pause()
    else if (this.#engine.transport !== 'free' && this.#isPlaying()) this.pause()
    this.#accomp?.stopSound()
    this.#listen?.transport.stopSound()
    this.#play?.transport.stopSound()
    this.#clearSounding()
  }

  // ── Engine events ─────────────────────────────────────────────────────────────────────

  /** Drain and route engine events, then schedule the frame and the next engine tick. */
  #process(now: number): void {
    this.#drain(now)
    if (this.#disposed) return
    this.#scheduleFrame()
    this.#scheduleTick()
  }

  #drain(now: number): void {
    if (this.#processing) {
      this.#again = true
      return
    }
    this.#processing = true
    try {
      for (let guard = 0; guard < 50; guard++) {
        this.#again = false
        const events = this.#engine.drainEvents()
        for (const ev of events) this.#handle(ev, now)
        // Decide Repeat only after the whole batch, so the attempt record has been seen.
        if (this.#completedPending) {
          this.#completedPending = false
          this.#afterAttempt(Math.max(now, this.#deps.clock()))
        }
        if (events.length === 0 && !this.#again) break
      }
    } finally {
      this.#processing = false
    }
  }

  #handle(ev: EngineEvent, now: number): void {
    switch (ev.type) {
      case 'accepted':
        if (this.#engine.transport !== 'strict') {
          const group = this.#engine.timeline.groups[ev.group]
          if (group) this.#practiceTiming.observe(group, ev.time)
        }
        if (ev.pitch === this.#cue?.target) this.#cue = null
        this.#resultPlayed(ev.group)
        break
      case 'input-complete':
        this.#cue = null
        // Keep time: the music never waits, and releasing a gate early would move it ahead.
        if (this.#engine.transport !== 'strict') {
          this.#accomp?.releaseGate(ev.group + this.#gateOffset)
        } else if (ev.onsetOffsetMs !== undefined) {
          this.#timingDrift.observe(ev.onsetOffsetMs, this.#toleranceMs(this.#settings))
        } else {
          this.#timingDrift.miss()
        }
        break
      case 'missed':
        // A miss ends the scored trend and still gets its usual soft wash.
        this.#missedPending++
        this.#cue = null
        this.#timingDrift.miss()
        break
      case 'wrong':
        if (ev.reason === 'tie-end' || ev.reason === 'late') break
        if (ev.reason === 'early' && this.#engine.transport !== 'strict') this.#practiceTiming.earlyPress(ev.time)
        this.#wrongPending++
        this.#wrongReason = ev.reason === 'early' ? 'early' : 'wrong'
        // A chord slip (P24) belongs to the group just completed: no cue toward the current one.
        this.#cue =
          ev.reason === 'early' || ev.group !== this.#engine.state.groupIndex
            ? null
            : (this.#octaveCorrection(ev.group, ev.pitch) ?? this.#accidentalCorrection(ev.group, ev.pitch))
        break
      case 'phase':
        this.#cue = null
        this.#timingDrift.reset()
        this.#practiceTiming.reset()
        this.#onPhase(ev.phase, now)
        break
      case 'attempt-ended':
        // Play-through records nothing: the reading before it was recorded when it went on;
        // what the engine ends during play-through (and when it goes off) stays unrecorded.
        if (this.#discarding || this.#playThrough) break
        if (this.#keepTimeActivity && ev.record.completion === 'completed') {
          this.#keepTimeActivity.completed = ev.record
          this.#finishKeepTimeActivity(this.#keepTimeActivity)
        } else this.#onRecord(ev.record)
        break
      case 'abandon':
        if (this.#playThrough) break
        // Leaving during a lead-in (user stop) abandons nothing: it is not recorded.
        if (this.#leadIn && !this.#leadIn.handedOver && this.#engine.mode === 'reading') break
        this.#deps.history.queueAbandon(ev.event)
        break
      case 'exposure-reset':
        // A seek or a speed change can begin another traversal while the phase stays running.
        this.#practiceTiming.reset()
        this.#reportVisibleLabels(now)
        break
      case 'advanced':
        this.#cue = null
        this.#lastVersion = -1
        this.#resultAdvanced(ev.to)
        break
      default:
        break
    }
  }

  /**
   * O(1), in the input path: a correct note of the next pass while the last result shows (U101).
   * Wrong keys leave the result as it was (full strength, the strip reviewing the loop). The first
   * correct note ends the review (the strip zooms back in the next frame, the marks go): the
   * result dims until the cursor leaves that bar, or goes at once when the loop is one bar.
   */
  #resultPlayed(group: number): void {
    if (this.#lastResult === null || this.#resultPlayedIn !== null) return
    if (this.#engine.mode !== 'scored' || this.#engine.state.phase !== 'running') return
    const timeline = this.#engine.timeline
    const occ = timeline.groups[group]?.occ
    if (occ === undefined) return
    if (timeline.measures.length <= 1) {
      this.#endResultByPlay()
      return
    }
    this.#resultPlayedIn = occ
    this.#clearCorrections()
  }

  /** O(1): the cursor moved on; leaving the bar of the next pass's first correct note ends the result. */
  #resultAdvanced(to: number | null): void {
    const occ = this.#resultPlayedIn
    if (occ === null || this.#lastResult === null) return
    if (to !== null && this.#engine.timeline.groups[to]?.occ === occ) return
    this.#endResultByPlay()
  }

  /** The next pass played past the result (U101): it slides away (`resultExit`). */
  #endResultByPlay(): void {
    this.#lastResult = null
    this.#resultPlayedIn = null
    this.#resultExit = 'played'
    this.#clearCorrections()
  }

  /** Pitches of `group` the learner has accepted so far. */
  #acceptedIn(group: number): readonly number[] {
    const state = this.#engine.state
    return state.groupIndex === group ? state.acceptedPitches : []
  }

  /** Nearest still-missing pitch of the same pitch class; a tie favors the lower target. */
  #octaveCorrection(group: number, pitch: number): { target: number; cue: StageCue } | null {
    const accepted = this.#acceptedIn(group)
    let target: number | null = null
    for (const required of this.#engine.timeline.groups[group]?.pitches ?? []) {
      if (required === pitch || (required - pitch) % 12 !== 0 || accepted.includes(required)) continue
      if (
        target === null ||
        Math.abs(required - pitch) < Math.abs(target - pitch) ||
        (Math.abs(required - pitch) === Math.abs(target - pitch) && required < target)
      )
        target = required
    }
    return target === null ? null : { target, cue: { kind: 'octave', direction: target > pitch ? 'up' : 'down' } }
  }

  /**
   * A still-missing pitch one semitone from the pressed key on the same letter: pressed F for F♯,
   * F♯ / G♭ for F♮ or G♮ (a white key has its own letter, a black key both neighbors'). The cue
   * names the target as the score spells it (naming settings, key and measure context), always
   * with its accidental, which is emphasized; a natural target gets ♮ even where its label omits it.
   */
  #accidentalCorrection(group: number, pitch: number): { target: number; cue: StageCue } | null {
    const g = this.#engine.timeline.groups[group]
    if (!g) return null
    const accepted = this.#acceptedIn(group)
    const naming = this.#settings.naming
    const letters = new Set([labelForMidi(pitch, naming, 'sharp').name, labelForMidi(pitch, naming, 'flat').name])
    const shown = { ...naming, alwaysShowEffectiveAccidentals: true }
    for (let k = 0; k < g.pitches.length; k++) {
      const required = g.pitches[k]!
      if (Math.abs(required - pitch) !== 1 || accepted.includes(required)) continue
      const note = this.#model.notes[g.notesByPitch[k]?.[0] ?? -1]
      if (!note) continue
      const label = labelFor(note, shown)
      if (!letters.has(label.name)) continue
      const accidental = label.accidental || NATURAL
      return {
        target: required,
        cue: { kind: 'accidental', text: `${label.name}${accidental}${label.octave ?? ''}`, accidental },
      }
    }
    return null
  }

  #onPhase(phase: Phase, now: number): void {
    const t = Math.max(now, this.#deps.clock())
    // Leaving Ready ends a count-in (pause, seek, selection change, interruption, a new attempt).
    if (phase !== 'ready') this.#cancelCountIn(t)
    if (phase !== 'interrupted') this.#interruptText = null
    if (phase === 'ready') {
      // The automatic part may start (an introduction plays); the clock waits for the first press.
      if (this.#accomp && this.#engine.transport === 'accompaniment') this.#accomp.play(t)
      // Keep time: count in, then the clock and the music start together.
      else if (this.#engine.transport === 'strict' && this.#engine.mode === 'scored') this.#beginCountIn(t)
    } else if (phase === 'completed') {
      if (this.#engine.mode === 'scored') this.#completedPending = this.#keepTimeActivity === null
      else if (this.#leadIn && !this.#leadIn.handedOver) {
        // From inside or after the loop the music plays on to the wrap (`#onAccompanimentEnd`).
        if (!this.#leadIn.wrap) this.#handOver(t)
        else if (this.#accomp?.state !== 'playing') this.#wrapLeadIn(t)
      } else this.#saveResume(t, true, null)
    } else if (phase === 'interrupted') {
      this.#pauseTransports()
      this.#flash?.clear()
    }
  }

  #onRecord(record: AttemptRecord): void {
    // A lead-in only leads into the attempt: nothing read in it is recorded.
    if (record.kind === 'reading' && this.#leadInKeys.has(passageKey(record.context.passage))) return
    this.#deps.history.queueAttempt(record)
    if (record.kind === 'scored') this.#rememberScored(record)
    if (record.kind !== 'scored' || record.completion !== 'completed') return
    this.#capture.finish(record.id)
    this.#streak = record.passed ? this.#streak + 1 : 0
    this.#ladderNext = null
    let ladder: AttemptSummary['ladder'] | undefined
    if (this.#repeat && this.#ladder) {
      const step = ladderAfterAttempt(
        this.#ladder,
        this.#sel.multiplier,
        record.passed,
        this.#streak,
        this.#repeatTarget ?? LADDER_DEFAULT_TARGET,
      )
      this.#ladder = step.ladder
      this.#ladderNext = step.next ?? null
      ladder = step.note
    }
    // A climb keeps Repeat going: the target applies again at the new speed.
    const climbing = ladder?.climbedTo !== undefined
    const targetReached = !climbing && this.#repeatTarget !== null && this.#streak >= this.#repeatTarget
    this.#resultPlayedIn = null
    this.#reviewReturnBy = null
    this.#resultExit = 'dismissed'
    this.#lastResult = {
      id: record.id,
      passed: record.passed,
      wrongAttacks: record.wrongAttacks,
      groupsFirstPass: record.groupsFirstPass,
      groupsTotal: record.groupsTotal,
      completionTimeSec: record.completionTimeSec ?? null,
      expectedTimeSec: record.expectedTimeSec,
      assistance: record.assistance.level,
      persistentLabels: record.assistance.persistentLabelNotes.length > 0,
      streak: this.#streak,
      targetReached,
      ...(ladder ? { ladder } : {}),
      ...timingSummary(record),
    }
    const timeline = [this.#engine.timeline, this.#timeline].find(
      (t) =>
        contextKey(
          comparisonContextOf(t, record.context.transport, record.context.matchingRules, record.context.scorePlayback),
        ) === record.contextKey,
    )
    this.#corrections = timeline ? correctionMarks(record, timeline, this.#model, this.#settings.naming) : []
    this.#correctionsVisible = true
    this.#strip?.setCorrections?.(this.#corrections)
    // Repeated mistakes are worked out in the next UI publish, outside the input path.
    this.#repeatedPending = timeline ? { id: record.id, timeline } : null
    this.#resultRecords = this.#recentScored.slice()
    this.#resultTimeline = timeline ?? null
  }

  /** O(1): keeps the last few scored records of the current comparison context (P24). */
  #rememberScored(record: AttemptRecord): void {
    const recent = this.#recentScored
    if (recent.length > 0 && recent[recent.length - 1]!.contextKey !== record.contextKey) recent.length = 0
    recent.push(record)
    if (recent.length > REPEATED_MISTAKE_HISTORY) recent.shift()
  }

  /** The result card's summary, with the latest pass's repeated mistakes once they are worked out. */
  #resultForUi(): AttemptSummary | null {
    const pending = this.#repeatedPending
    const result = this.#lastResult
    if (pending && result?.id === pending.id) {
      this.#repeatedPending = null
      const found = repeatedMistakes(this.#resultRecords, pending.timeline, this.#model)
      if (found.length > 0) this.#lastResult = { ...result, repeatedMistakes: found }
    }
    return this.#lastResult
  }

  #setCorrectionsVisible(visible: boolean): void {
    if (this.#corrections.length === 0 || this.#correctionsVisible === visible) return
    this.#correctionsVisible = visible
    this.#strip?.setCorrections?.(visible ? this.#corrections : [])
  }

  /** Discard marks when their result is dismissed or the first correct note ends its review. */
  #clearCorrections(): void {
    this.#stopSnippet()
    if (this.#corrections.length === 0) return
    this.#setCorrectionsVisible(false)
    this.#corrections = []
    // `ui.corrections` follows in the next frame (never a UI publish in the input path).
    this.#scheduleFrame()
  }

  /** Scored attempt completed: Repeat finishes the automatic part, cleans up, then resets to Ready. */
  #afterAttempt(now: number): void {
    const target = this.#lastResult?.targetReached ?? false
    if (!this.#repeat || target) {
      // Target reached (Repeat mode stays open; Start begins a new run) or no Repeat: the
      // automatic part still finishes to the passage boundary, then stops.
      if (!this.#accomp || this.#accomp.state !== 'playing') this.#accomp?.stop()
      return
    }
    if (this.#accomp && this.#accomp.state === 'playing') {
      this.#pendingRepeat = true
      return
    }
    this.#repeatReset(now)
  }

  #repeatReset(now: number): void {
    const speed = this.#ladderNext
    if (speed !== null && this.#repeat) {
      const secondBar = this.#secondOpeningBarOnWrap
      this.#ladderStep(speed)
      this.#secondOpeningBarOnWrap = secondBar
      return
    }
    this.#pendingRepeat = false
    this.#accomp?.stop()
    this.#clearSounding()
    this.#engine.restart(now, { continueRepeat: true })
    this.#prepareAttempt(now)
    // Back to the loop start: the strip pans there quickly instead of scrolling backward.
    this.#strip?.wrapTo?.(this.#cursorPosition())
  }

  /**
   * The speed ladder's climb, at the Repeat reset: the same path as a speed change
   * (`setSelection({ multiplier })`, saved as the piece's last speed; the streak starts over) but
   * the result card stays and the fresh attempt is prepared at the new speed.
   */
  #ladderStep(speed: number): void {
    this.#pendingRepeat = false
    this.#accomp?.stop()
    this.#clearSounding()
    this.#select({ hands: this.#sel.hands, multiplier: speed }, this.#loop, true, true, true)
    this.#strip?.wrapTo?.(this.#cursorPosition())
  }

  /**
   * Start or Again while a ladder speed still waits for the Repeat reset (the last pass's music
   * plays on): the step is taken now, so the new run's first attempt is prepared at the speed the
   * card announced. False when no step waits.
   */
  #newRunAtLadderSpeed(): boolean {
    const speed = this.#ladderNext
    // Only while the pass that announced it is the engine's finished attempt (its tail, also paused).
    if (speed === null || !this.#repeat || this.#engine.mode !== 'scored' || this.#engine.state.phase !== 'completed')
      return false
    this.#ladderStep(speed)
    return true
  }

  #onAccompanimentEnd(): void {
    const now = this.#deps.clock()
    const lead = this.#leadIn
    if (lead?.wrap && !lead.handedOver && this.#engine.mode === 'reading') {
      // A lead-in from inside or after the loop reached its end: wrap into the attempt.
      this.#wrapLeadIn(now)
    } else if (this.#pendingRepeat) {
      this.#repeatReset(now)
    } else {
      this.#accomp?.stop()
      this.#clearSounding()
      if (this.#repeat) this.#accomp?.seek(this.#timeline.end)
      else {
        // A Keep time pass from the cursor (U128) has its transport stop at that start, not at zero:
        // it goes, so the cursor reads the piece's start (U126). Start then counts in from the top;
        // Again builds it again from the finished pass's start (the engine keeps that timeline).
        if (this.#accomp && this.#accomp.positionNow() > 1e-9) this.#disposeAccompaniment()
        this.#rewindPiece()
      }
    }
    this.#process(now)
  }

  #onListenEnd(): void {
    const now = this.#deps.clock()
    const l = this.#listen
    if (!l) return
    if (this.#repeat && this.#sel.range) {
      l.transport.seek(passageRange(this.#model, this.#sel.range).start)
      l.transport.play()
    } else {
      l.transport.stop()
      l.playing = false
      this.#rewindPiece()
    }
    this.#clearSounding()
    this.#process(now)
  }

  /**
   * Back to position zero after the piece's tail (U126): the caller's transport is stopped at zero
   * (or gone), so the cursor and the progress read zero. Animate the view without starting another
   * pass.
   */
  #rewindPiece(): void {
    this.#lastVersion = -1
    this.#playVersion = -1
    this.#strip?.wrapTo?.(0, { rewind: true })
  }

  /**
   * Scored preparation: transports back to the passage start, then `markPrepared` once the
   * strip is ready and persistent-label fades have finished (spec: "Before marking a new
   * scored attempt Ready, finish any outgoing label fades"). The engine itself waits for
   * released keys and sound-retaining pedals and for temporary-hint fades.
   */
  #prepareAttempt(now: number): void {
    // Reset the transport to the start of this attempt's passage.
    this.#endLeadIn()
    this.#accomp?.stop()
    this.#clearSounding()
    this.#flash?.clear()
    this.#awaitPrepared = true
    this.#tryPrepared(now)
  }

  #tryPrepared(now: number): void {
    if (!this.#awaitPrepared || this.#engine.state.phase !== 'preparing') return
    if (!this.#strip) return
    if (this.#engine.transport !== 'free' && !this.#accomp) return
    if (this.#labels.fadingUntil() > now) return
    this.#awaitPrepared = false
    this.#engine.markPrepared(now)
  }

  #reportVisibleLabels(now: number): void {
    const strip = this.#strip
    if (!strip) return
    const visible = strip.visibleLabels().filter((n) => this.#labels.isEligible(n))
    if (visible.length) this.#engine.recordPersistentLabelExposure(visible, now)
  }

  // ── Transports ────────────────────────────────────────────────────────────────────────

  /** Where app playback goes now (S4): the piano, this device, or nowhere. */
  #destination(): PlaybackKind | null {
    return playbackDestination(this.#settings, this.#deps.midi.output(), this.#browserSoundPossible())
  }

  /** The current output when it matches the destination; builds a MIDI backend synchronously. */
  #ensureOutputSync(): OutputBackend | null {
    const kind = this.#destination()
    const key = outputKey(this.#settings, kind)
    if (this.#output && key === this.#outputKey) return this.#output
    // Browser sound is loaded asynchronously after a gesture (#ensureOutput).
    if (kind !== 'midi') return null
    const out = this.#deps.midi.output()
    if (!out) return null
    if (this.#output) this.#disposeOutput()
    const make = this.#deps.createMidiBackend ?? defaultMidiBackend(this.#deps.clock)
    const backend = make(out, this.#settings.route.outputChannel, humanGuardEnabled(this.#settings))
    this.#midiBackend = backend
    this.#output = backend
    this.#outputKey = key
    this.#outputKind = 'midi'
    return backend
  }

  /**
   * The playback destination; browser sound is loaded only here, after a user gesture (Start or
   * Play), so use with a connected piano never fetches the sample bank (S4).
   */
  async #ensureOutput(): Promise<OutputBackend | null> {
    const kind = this.#destination()
    if (kind !== 'browser') return this.#ensureOutputSync()
    const key = outputKey(this.#settings, kind)
    if (this.#output && key === this.#outputKey) return this.#output
    if (this.#outputLoading) return this.#outputLoading
    const load = this.#deps.loadBrowserAudio
    if (!load) return null
    // A lost piano backend goes first: no stuck notes.
    if (this.#output) this.#disposeOutput()
    this.#soundStatus = msg('Loading piano sounds…')
    this.#publishUi()
    this.#outputLoading = load()
      .then((m) => {
        if (this.#disposed) return null
        const backend = m.createBrowserAudio({ clock: this.#deps.clock, volume: this.#settings.sound.browserVolume })
        this.#output = backend
        this.#browser = backend
        this.#outputKey = key
        this.#outputKind = 'browser'
        this.#monitor = (ev) => {
          if (this.#settings.sound.monitorInput) backend.monitor(ev)
        }
        this.#soundStatus = null
        return backend as OutputBackend
      })
      .catch(() => {
        this.#soundStatus = msg('Browser sound could not be loaded.')
        return null
      })
      .finally(() => {
        this.#outputLoading = null
        this.#publishUi()
      })
    return this.#outputLoading
  }

  /** Can browser sound be used at all (Web Audio and the lazy loader)? */
  #browserSoundPossible(): boolean {
    if (!this.#deps.loadBrowserAudio) return false
    return this.#deps.hasWebAudio?.() ?? true
  }

  /**
   * Load the metronome when a click is wanted: the general setting, the current mode's (Keep
   * time's own, DECISIONS P20), or `force` (the Keep time count-in clicks anyway).
   */
  async #ensureMetronome(force = false): Promise<void> {
    const load = this.#deps.loadMetronome
    if (!load || this.#deps.hasWebAudio?.() === false) return
    if (!this.#metronome && !force && !this.#settings.metronome.enabled && !this.#practiceClick()) return
    // Overlapping requests (a metronome setting changed while Start loads) queue instead of
    // canceling each other: each returns once a metronome exists, so a count-in never schedules
    // its clicks into nothing; the later one then moves it to the output set by then.
    const previous = this.#metronomeLoading
    const request = previous ? previous.then(() => this.#loadMetronome(load)) : this.#loadMetronome(load)
    this.#metronomeLoading = request
    try {
      await request
    } finally {
      if (this.#metronomeLoading === request) this.#metronomeLoading = null
    }
  }

  /** One metronome request, for the output set when it runs (`#ensureMetronome`). Never rejects. */
  async #loadMetronome(load: NonNullable<SessionDeps['loadMetronome']>): Promise<void> {
    try {
      const module = this.#metronome ? null : await load()
      if (this.#disposed) return
      const output = metronomeAudioOutput(this.#settings.metronome.outputId)
      const { context } = output instanceof Promise ? await output : output
      if (this.#disposed) return
      if (this.#metronome) this.#metronome.setContext(context)
      else if (module) {
        this.#metronome = new module.WebAudioMetronome({
          context,
          clock: this.#deps.clock,
          volume: this.#settings.metronome.volume,
        })
      }
    } catch {
      // Practice is available if browser audio cannot start.
    }
  }

  /** Every practice mode uses the same transport for its gates, clock, click and score sound. */
  #ensureAccompaniment(updateSound = false): void {
    if (this.#sel.hands === 'none' || !hasTempo(this.#tempo)) return
    const scorePlayback = this.#scorePlayback()
    const scoreVolume = scorePlayback ? level(this.#settings.rhythm?.scorePlaybackVolume ?? 1) : 1
    // At 0% nothing is played (P27), so no echo-free route is needed.
    if (
      this.#playbackHeard() &&
      !accompanimentAllowed(this.#settings, this.#deps.midi.output(), this.#browserSoundPossible())
    )
      return
    const silent = this.#practiceSilent()
    // Follow human-held MIDI keys from the count-in, even if Playback is first enabled mid-note.
    if (silent && this.#rhythm && this.#destination() === 'midi') this.#ensureOutputSync()
    const output = silent ? null : this.#ensureOutputSync()
    if (!silent && !output) return
    // Record the choice once its audio is available. Loading or a blocked route leaves grading alone.
    const strict = this.#engine.transport === 'strict'
    if (strict) this.#engine.updateSettings({ rhythm: this.#rhythmParams() }, this.#deps.clock())
    // A lead-in that has not reached the loop plays on one transport into the loop: its gates are
    // the lead-in's groups, then the loop's (engine group i = gate i + `#gateOffset`). One from
    // inside or after the loop has only its own gates: at its end the music wraps (`#wrapLeadIn`).
    const lead = this.#leadIn && !this.#leadIn.handedOver ? this.#leadIn : null
    const timeline = strict ? this.#engine.timeline : this.#timeline
    const key = `${performanceKey(this.#settings)}|${this.#outputKey}|${scorePlayback}|${scoreVolume === 0}|${passageKey(timeline.range)}${lead ? `|lead ${ratKey(lead.start)}` : ''}`
    if (this.#accomp && this.#accompKey === key) return
    const range = passageRange(this.#model, lead ? lead.span : timeline.range)
    const route = this.#settings.route
    const sendPedals = route.automaticPedalsInHandPractice || (scorePlayback && this.#outputKind === 'browser')
    const events =
      silent || scoreVolume === 0
        ? []
        : buildPerformance(this.#model, {
            hands: scorePlayback ? 'none' : this.#sel.hands,
            range,
            accompanimentLevel: strict && route.accompanimentLevel > 0 ? 1 : level(route.accompanimentLevel),
            sendPedals,
            reattackHeldAtStart: lead === null && timeline === this.#timeline,
          })
    if (updateSound && this.#accomp) {
      this.#clearSounding()
      this.#accomp.replacePerformance(events, output)
      this.#accompKey = key
      return
    }
    this.#disposeAccompaniment()
    const gates = !lead
      ? transportGates(timeline)
      : lead.wrap
        ? transportGates(lead.timeline)
        : [...transportGates(lead.timeline), ...transportGates(this.#timeline)]
    const leadGroups = lead ? lead.timeline.groups.length : 0
    const transport = createTransport({
      clock: this.#deps.clock,
      timers: this.#deps.timers,
      tempo: this.#tempo,
      multiplier: this.#sel.multiplier,
      ...(strict
        ? {
            velocityScale: () =>
              level(this.#settings.route.accompanimentLevel) *
              (this.#scorePlayback() ? level(this.#settings.rhythm?.scorePlaybackVolume ?? 1) : 1),
          }
        : {}),
      events,
      gates,
      range,
      backend: output,
      metronome: {
        sink: this.#metronomeSink,
        clicks: buildClickTrack(this.#model, range),
        enabled: this.#practiceClick(),
      },
      onGateReached: (gate) => {
        const t = this.#deps.clock()
        // Before the hand-over only the lead-in's gates belong to the (reading) engine.
        const early = lead !== null && !lead.handedOver && gate >= leadGroups
        if (!early && gate >= this.#gateOffset) this.#engine.transportArrived(gate - this.#gateOffset, t)
        // Keep time: the music never holds (already released at the count-in's end: a no-op).
        if (this.#engine.transport === 'strict') transport.releaseGate(gate)
        this.#process(t)
      },
      onRangeEnd: () => this.#onAccompanimentEnd(),
      onInterrupted: () => this.#onOutputLost(),
      onEmit: (ev, time) => this.#onEmit(ev, time),
    })
    this.#accomp = transport
    this.#accompKey = key
    this.#accompLead = lead !== null
    this.#gateOffset = 0
    this.#engine.updateSettings(
      { transportEta: (g, at) => transport.msUntilGate(g + this.#gateOffset, at) },
      this.#deps.clock(),
    )
  }

  /**
   * Build the practice transport, loading browser sound first if the automatic part needs it.
   */
  #ensureTransport(then: (now: number) => void): void {
    this.#ensureAccompaniment()
    if (this.#accomp || this.#practiceSilent() || this.#sel.hands === 'none' || !this.#plan().enabled) return
    void this.#ensureOutput().then(() => {
      if (this.#disposed) return
      this.#ensureAccompaniment()
      const t = this.#deps.clock()
      then(t)
      this.#process(t)
    })
  }

  /** Reading with accompaniment: the transport continues from the current learner group. */
  #playAccompanimentFromCurrent(now: number): void {
    const t = this.#accomp
    if (!t) return
    const pos = this.#engine.state.position
    if (t.state !== 'paused' || pos === null) {
      t.stop()
      if (pos) t.seek(pos)
    }
    t.play(now)
  }

  #pauseTransports(): void {
    this.#releaseKeepTime()
    this.#secondOpeningBarOnWrap = false
    if (this.#accomp && this.#accomp.state === 'playing') this.#accomp.pause()
    this.#clearSounding()
  }

  #stopListening(): void {
    if (!this.#listen) return
    this.#disposeListen()
    this.#lastVersion = -1
  }

  #disposeListen(): void {
    const l = this.#listen
    if (!l) return
    this.#listen = null
    l.transport.stop()
    l.transport.dispose()
    this.#clearSounding()
  }

  #disposeAccompaniment(): void {
    const t = this.#accomp
    if (!t) return
    this.#accomp = null
    this.#accompKey = ''
    this.#accompLead = false
    this.#gateOffset = 0
    t.stop()
    t.dispose()
    this.#engine.updateSettings({ transportEta: null }, this.#deps.clock())
  }

  #disposeOutput(): void {
    const o = this.#output
    this.#output = null
    this.#outputKey = ''
    this.#outputKind = null
    this.#midiBackend = null
    this.#browser = null
    this.#monitor = null
    if (!o) return
    try {
      o.cleanup(this.#deps.clock())
    } catch {
      // The destination is gone; nothing to release.
    }
    ;(o as { dispose?: () => void }).dispose?.()
  }

  #onEmit(ev: NoteOnEvent | NoteOffEvent | ControlEvent | ClickEvent, time: number): void {
    if (ev.kind !== 'on' && ev.kind !== 'off') return
    this.#emitQueue.push({ time, ev })
    this.#scheduleFrame()
  }

  #clearSounding(): void {
    this.#emitQueue = []
    if (this.#sounding.size) {
      this.#sounding.clear()
      this.#soundingDirty = true
      this.#scheduleFrame()
    }
  }

  // ── Frames and ticks ──────────────────────────────────────────────────────────────────

  #scheduleFrame(): void {
    if (this.#frameHandle !== null || this.#disposed) return
    this.#frameHandle = this.#deps.frames.request(() => {
      this.#frameHandle = null
      this.#frame(this.#deps.clock(), false)
    })
  }

  /**
   * One visual update: strip classes, cursor, labels, flash, octave cue, keyboard guide, progress.
   * O(changed notes) plus the label maps only while labels change.
   */
  #frame(now: number, force: boolean): void {
    if (this.#disposed) return
    if (this.#play) {
      this.#framePlay(now, force, this.#play)
      return
    }
    const strip = this.#strip
    const s = this.#engine.state
    this.#maintainPreview(s)
    const previewChanged = this.#previewDirty
    this.#previewDirty = false
    const versionChanged = s.version !== this.#lastVersion || force
    // Listen mode (both hands off, U9) shows no targets, even before Play.
    const quiet = this.#listen !== null || this.#sel.hands === 'none'
    const timingEnabled = this.#timingRowEnabled()
    const timing = this.#engine.transport === 'strict' ? this.#timingDrift : this.#practiceTiming
    strip?.setTimingCue?.(timingEnabled && s.phase === 'running' ? timing.directionAt(now) : null, timingEnabled)
    if (versionChanged || previewChanged) {
      this.#lastVersion = s.version
      if (strip) {
        strip.setTargets(quiet ? [] : s.targetNotes)
        strip.setAccepted(quiet ? [] : this.#acceptedNotes(s))
        strip.setOttavaEmphasis(quiet ? [] : s.ottavaWarning)
        if (!this.#listen && !this.#accomp) strip.setCursor(this.#cursorPosition())
      }
    }
    if (this.#wrongPending > 0) {
      this.#wrongPending = 0
      this.#pulse++
      if (this.#settings.hints.damageFlash) {
        this.#flash?.hit(now, s.wrongFeedbackUntil, this.#wrongReason === 'early' ? { soft: true } : undefined)
      }
    }
    if (this.#missedPending > 0) {
      this.#missedPending = 0
      // A group the music passed (Keep time): the gentle wash, no pulse, marker or cue.
      if (this.#settings.hints.damageFlash) this.#flash?.hit(now, now + DEFAULT_WRONG_FEEDBACK_MS, { soft: true })
    }
    // The cue stays until its target is accepted or another wrong attack replaces it.
    const showing = !quiet && s.phase !== 'interrupted' && s.groupHasError && s.lastWrongReason !== 'tie-end'
    this.feedback.set({
      visible: showing,
      reason: s.lastWrongReason === 'early' ? 'early' : 'wrong',
      pulse: this.#pulse,
      cue: showing ? (s.retryGroup ? RETRY_CUE : (this.#cue?.cue ?? null)) : null,
    })

    const labelsChanging = this.#frameLabels(now, strip, s)

    // The notes follow musical time in Listen and practice, holding at an unreleased gate.
    if ((this.#listen || this.#accomp) && strip) strip.setCursor(this.#cursorPosition(), { smooth: false })

    this.#applyDueNotes(now)
    // The keyboard guide follows the group, the held keys and what playback sounds (U15).
    if (s.keyboardVisible && (versionChanged || previewChanged || this.#soundingDirty)) this.#updateGuide(quiet)
    this.#soundingDirty = false

    this.progress.set(this.#computeProgress())
    if (this.#engine.mode === 'reading' && s.phase === 'running' && now - this.#lastResumeSave >= RESUME_SAVE_MS) {
      this.#saveResume(now, false)
    }
    this.#syncLock()
    this.#publishUi()
    // Show this frame's strip changes now, not in the strip's own rAF one frame later (PF2).
    strip?.flushFrame?.()

    const more =
      (this.#listen?.playing ?? false) ||
      labelsChanging ||
      this.#labels.fading ||
      this.#emitQueue.length > 0 ||
      (this.#accomp?.state === 'playing' && this.#accomp.holdingGate === null)
    if (more) this.#scheduleFrame()
    this.#tryPrepared(now)
  }

  /**
   * Labels: temporary hints (engine, eased) combined with persistent labels by max, and names
   * revealed at the cursor on request. Returns true while they change (frames keep running).
   */
  #frameLabels(now: number, strip: StripSink | null, s: EngineState): boolean {
    const temp = this.#engine.temporaryLabelOpacity(now)
    const persistent = this.#labels.opacity(now)
    // Temporary labels keep frames running while they fade (completion, dismissal, expiry).
    let tempChanging = false
    if (temp.size > 0) {
      const hint = s.hint
      if (!hint || temp.size > hint.notes.length) tempChanging = true
      else if (hint.expiresAt !== null && now >= hint.expiresAt - this.#settings.hints.fadeMs) tempChanging = true
      else for (const v of temp.values()) if (v < 1) tempChanging = true
    }
    // Names revealed at the cursor on request (Study mode) are a third source, merged the same way.
    const reveal = this.#revealOpacity(now)
    const revealFading = this.#reveal !== null && now >= this.#reveal.until - this.#settings.hints.fadeMs
    if (
      strip &&
      (this.#labelsDirty ||
        persistent !== this.#lastPersistent ||
        !sameOpacity(temp, this.#lastTemp) ||
        !sameOpacity(reveal, this.#lastReveal))
    ) {
      strip.setLabelOpacity(mergeOpacity(mergeOpacity(persistent, temp), reveal))
      this.#labelsDirty = false
      this.#lastPersistent = persistent
      this.#lastTemp = temp
      this.#lastReveal = reveal
    }
    return tempChanging || revealFading
  }

  /** Playback events due by now update the keyboard guide. */
  #applyDueNotes(now: number): void {
    if (this.#emitQueue.length === 0) return
    const due = this.#emitQueue.filter((e) => e.time <= now)
    if (due.length === 0) return
    this.#emitQueue = this.#emitQueue.filter((e) => e.time > now)
    for (const { ev } of due) {
      if (ev.kind === 'on') this.#sounding.set(ev.voice, ev.notes)
      else this.#sounding.delete(ev.voice)
    }
    this.#soundingDirty = true
  }

  /**
   * The play-through frame (DECISIONS P12): the follower's targets, accepted marks and keys,
   * the timing cue, the cursor at the transport position, and the resume position.
   */
  #framePlay(now: number, force: boolean, p: PlayThrough): void {
    const strip = this.#strip
    const s = this.#engine.state
    const f = p.follower.state
    const changed = force || f.version !== this.#playVersion
    // The row stays while paused too (`#timingRowEnabled`); the cue follows live MIDI timing while playing.
    const timingEnabled = this.#timingRowEnabled()
    const timing = timingEnabled && p.playing ? p.timing : null
    strip?.setTimingCue?.(timing?.directionAt(now) ?? null, timingEnabled)
    if (changed) {
      this.#playVersion = f.version
      if (strip) {
        strip.setTargets(f.targetNotes)
        strip.setAccepted(f.acceptedNotes)
        strip.setOttavaEmphasis([])
      }
    }
    if (this.#wrongPending > 0) {
      this.#wrongPending = 0
      if (this.#settings.hints.damageFlash) this.#flash?.hit(now, f.wrongFeedbackUntil, { soft: true })
    }
    this.feedback.set({ visible: false, reason: 'early', pulse: this.#pulse, cue: null })
    const labelsChanging = this.#frameLabels(now, strip, s)
    strip?.setCursor(p.transport.positionNow(), { smooth: false })
    this.#applyDueNotes(now)
    if (s.keyboardVisible && (changed || this.#soundingDirty)) this.#updateGuide(false, f)
    this.#soundingDirty = false
    this.progress.set(this.#computeProgress())
    if (p.playing && now - this.#lastResumeSave >= RESUME_SAVE_MS) this.#saveResume(now, false)
    this.#syncLock()
    this.#publishUi()
    strip?.flushFrame?.()
    const more =
      labelsChanging ||
      this.#labels.fading ||
      this.#emitQueue.length > 0 ||
      (p.playing && p.transport.holdingGate === null)
    if (more) this.#scheduleFrame()
  }

  /**
   * The cue row above the score is reserved whenever live timing feedback is on (DECISIONS U122):
   * the setting, a hand practiced (not Listen), and in play-through a piano to time (the microphone
   * gives no live timing, P22). It does not follow the phase, so the score stays put on Start,
   * Pause and each new pass; the cue itself shows only while the music runs.
   */
  #timingRowEnabled(): boolean {
    if (!this.#settings.hints.showTimingCues || this.#listen !== null || this.#sel.hands === 'none') return false
    return !this.#playThrough || !this.#micActive()
  }

  /** Wake for engine deadlines (pending presses, hint expiry and fades), label fades before Ready. */
  #scheduleTick(): void {
    if (this.#disposed) return
    const now = this.#deps.clock()
    let at = this.#engine.nextDeadline() ?? Infinity
    const activity = this.#keepTimeActivity
    if (activity) {
      // A stall moving the music later re-runs this after the early wake-up (`#checkKeepTimeActivity`).
      const delay = this.#keepTimeShift() + this.#keepTimeGrace
      at = Math.min(
        at,
        (activity.bars[activity.bar]?.end ?? Infinity) + delay,
        (activity.opening?.end ?? Infinity) + delay,
      )
    }
    const patience = this.#play?.follower.nextDeadline() ?? null
    if (patience !== null) at = Math.min(at, patience)
    const playCueUntil = this.#play?.timing?.cueUntil
    if (this.#play?.playing && playCueUntil !== undefined && playCueUntil > now) at = Math.min(at, playCueUntil)
    if (this.#practiceTiming.cueUntil > now) at = Math.min(at, this.#practiceTiming.cueUntil)
    const hint = this.#engine.state.hint
    if (hint?.expiresAt != null) {
      const fadeStart = hint.expiresAt - this.#settings.hints.fadeMs
      if (fadeStart > now) at = Math.min(at, fadeStart)
    }
    if (this.#awaitPrepared) {
      const f = this.#labels.fadingUntil()
      if (f > now) at = Math.min(at, f)
    }
    if (this.#reveal) {
      const fadeStart = this.#reveal.until - this.#settings.hints.fadeMs
      if (fadeStart > now) at = Math.min(at, fadeStart)
    }
    if (at === this.#tickAt && this.#tickHandle !== null) return
    if (this.#tickHandle !== null) this.#deps.timers.clearTimeout(this.#tickHandle)
    this.#tickHandle = null
    this.#tickAt = at
    if (at === Infinity) return
    this.#tickHandle = this.#deps.timers.setTimeout(
      () => {
        this.#tickHandle = null
        this.#tickAt = Infinity
        const t = Math.max(this.#deps.clock(), at)
        this.#checkKeepTimeActivity(t)
        this.#engine.tick(t)
        if (this.#play) {
          this.#play.follower.tick(t)
          this.#processPlay()
        }
        this.#tryPrepared(t)
        this.#process(t)
      },
      Math.max(0, at - now),
    )
  }

  // ── Derived state ─────────────────────────────────────────────────────────────────────

  #plan(timeline = this.#timeline.scoredAllowed ? this.#timeline : this.#startTimeline()) {
    const out = this.#deps.midi.output()
    const browser = this.#browserSoundPossible()
    return startPlan(
      timeline,
      this.#sel,
      {
        hasOutput: hasSoundOutput(this.#settings, out, browser),
        noOutputReason: noPlaybackReason(this.#settings, out, browser),
        accompanimentAllowed: accompanimentAllowed(this.#settings, out, browser),
        hasTempo: hasTempo(this.#tempo),
        hasInput: this.#inputAvailable,
        micSupported: this.#micPossible(),
      },
      {
        playThrough: this.#playThrough,
        rhythm: this.#rhythm,
        scorePlayback: this.#playbackHeard(),
        mic: this.#micActive(),
      },
    )
  }

  /** This app can follow the microphone here: a follower to build and a browser that can open one (P22). */
  #micPossible(): boolean {
    return this.#deps.createMicFollower !== undefined && (this.#deps.micSupported?.() ?? true)
  }

  /**
   * What a play-through follows is the microphone (DECISIONS P22): always without a piano, and with
   * one when `settings.mic.follow` (the Practice menu's Follow choice) says so.
   */
  #followsMic(): boolean {
    return this.#micPossible() && (!this.#inputAvailable || this.#settings.mic?.follow === true)
  }

  /**
   * The microphone follows this play-through (any hand, P22): the app then plays nothing, neither
   * the other hand nor the metronome, since the microphone must never hear the app's own sound.
   */
  #micActive(): boolean {
    return this.#followsMic() && this.#sel.hands !== 'none'
  }

  /** No piano and a hand selected: play-through is how that hand plays, on and locked (P22). */
  #playRequired(): boolean {
    return !this.#inputAvailable && this.#sel.hands !== 'none'
  }

  /** Keep time's Playback switch is on (the score's sound follows it, P27: none at 0%). */
  #scorePlayback(): boolean {
    return this.#rhythm && this.#sel.hands !== 'none' && this.#settings.rhythm?.scorePlayback === true
  }

  /**
   * Playback is on above 0%. At 0% it counts as off: no Playback comparison context, no
   * echo-free output needed, both hands practice silently; raising the volume mid-pass is switching
   * it on mid-pass.
   */
  #playbackHeard(): boolean {
    return this.#rhythm && this.#sel.hands !== 'none' && playbackHeard(this.#settings)
  }

  #practiceSilent(): boolean {
    return this.#sel.hands === 'both' && !this.#playbackHeard()
  }

  /** Whether a route change can remove the backend without stopping the active transport. */
  #playsNothing(): boolean {
    return this.#practiceSilent() || (this.#playThrough && this.#micActive())
  }

  /** The play-through transport plays nothing: both hands, or the microphone follows. */
  #playSilent(): boolean {
    return this.#sel.hands === 'both' || this.#micActive()
  }

  /**
   * The metronome clicks in play-through unless the microphone follows: the clicks come out of
   * this device right beside its microphone, louder there than the piano (DECISIONS P16).
   */
  #playMetronome(): boolean {
    return this.#settings.metronome.enabled && !this.#micActive()
  }

  /** Which Metronome preference the current mode uses (DECISIONS P20; `ui.metronomeScope`). */
  #metronomeScope(): MetronomeScope {
    return metronomeScope(this.#rhythm, this.#sel.hands)
  }

  /** The gated practice transport's click: Keep time's own preference in its attempts, else the general one. */
  #practiceClick(): boolean {
    return metronomeOn(this.#settings.metronome, this.#metronomeScope())
  }

  /**
   * Create or resume the click's AudioContext inside the Start tap (DECISIONS P20). iPadOS
   * needs the user gesture, which can be gone by the time `#ensureMetronome` runs.
   */
  #unlockAudio(): void {
    if (!this.#deps.loadMetronome || !(this.#deps.hasWebAudio?.() ?? true)) return
    try {
      const plan = this.#plan()
      if (!plan.enabled) return
      const click =
        plan.action === 'play'
          ? this.#playMetronome()
          : plan.action === 'listen'
            ? this.#settings.metronome.enabled
            : // The Keep time count-in always clicks.
              (this.#rhythm && plan.action === 'scored') || this.#practiceClick()
      if (click) void Promise.resolve(metronomeAudioOutput(this.#settings.metronome.outputId)).catch(() => undefined)
    } catch {
      // No Web Audio: the Start goes on without a click.
    }
  }

  #isPlaying(): boolean {
    if (this.#playThrough) return this.#play?.playing ?? false
    if (this.#listen) return this.#listen.playing
    const phase = this.#engine.state.phase
    if (this.#engine.mode === 'scored') return ACTIVE.includes(phase) || this.#keepTimeActivity !== null
    return phase === 'running' || this.#leadInTail()
  }

  #activity(): Activity {
    if (this.#playThrough) return 'playing'
    if (this.#listen) return 'listening'
    if (this.#engine.mode === 'scored') return 'scored'
    return this.#readingStarted ? 'reading' : 'idle'
  }

  #interruption(): Interruption | null {
    const s = this.#engine.state
    if (s.phase !== 'interrupted' || this.#listen || this.#playThrough) return null
    const reason = s.interruptReason ?? 'pause'
    // No "Paused" banner: the main button reads Resume / Start (user, 2026-10-31).
    if (reason === 'mode-change' || reason === 'user-stop' || reason === 'pause') return null
    return {
      reason,
      text: this.#interruptText ?? msg(INTERRUPT_TEXT[reason]),
      canResume: this.#engine.mode === 'reading',
    }
  }

  /** The play-through UI (DECISIONS P12): no attempt states, results, interruptions or hints. */
  #computePlayUi(s: EngineState, plan: StartPlan): SessionUi {
    const p = this.#play
    const phase: Phase | null = p
      ? p.playing
        ? 'running'
        : p.follower.state.finished
          ? 'completed'
          : 'paused'
      : this.#playResumable
        ? 'paused'
        : null
    return {
      activity: 'playing',
      phase,
      // A browse hold reads Pause until the release continues (U95).
      playing: (p?.playing ?? false) || this.#browseHold !== null,
      hands: this.#sel.hands,
      handsAvailable: this.#heldHands === null,
      range: this.#sel.range,
      multiplier: this.#sel.multiplier,
      startAction: plan.action,
      startEnabled: plan.enabled,
      startReason: plan.reason,
      waiting: null,
      hintVisible: s.hint !== null,
      keyboardVisible: s.keyboardVisible,
      canHint: false,
      repeat: this.#repeat,
      canRestartLoop: false,
      leadIn: false,
      repeatTarget: this.#repeatTarget,
      ladder: this.#ladder,
      lastResult: null,
      resultDimmed: false,
      resultExit: this.#resultExit,
      reviewing: false,
      corrections: 0,
      interruption: null,
      soundStatus: this.#soundStatus,
      inputDisconnected: this.#inputDisconnected,
      playThrough: true,
      micStatus: this.#micStatus,
      ...this.#followUi(),
      rhythm: false,
      countIn: null,
      metronomeScope: this.#metronomeScope(),
      metronomeMuted: this.#micActive(),
      finished: false,
    }
  }

  /** The Follow choice and the no-piano lock (DECISIONS P22, U92). */
  #followUi(): Pick<SessionUi, 'follow' | 'pianoConnected' | 'micSupported' | 'playThroughLocked'> {
    return {
      follow: this.#followsMic() ? 'mic' : 'piano',
      pianoConnected: this.#inputAvailable,
      micSupported: this.#micPossible(),
      playThroughLocked: !this.#inputAvailable && this.#micPossible(),
    }
  }

  #computeUi(): SessionUi {
    const s = this.#engine.state
    const plan = this.#plan()
    if (this.#playThrough) return this.#computePlayUi(s, plan)
    let waiting: string | null = null
    if (s.phase === 'preparing') {
      if (s.readyBlockers.includes('keys-held')) {
        waiting = msg('Release the keys to begin.')
      } else if (s.readyBlockers.includes('not-prepared')) {
        waiting = this.#strip ? msg('Getting ready…') : msg('Preparing the score…')
      }
    }
    const leadIn = this.#leadIn !== null && !this.#leadIn.handedOver && this.#engine.mode === 'reading'
    // A browse hold reads Pause until the release continues (U95).
    const playing = this.#isPlaying() || this.#browseHold !== null
    return {
      activity: this.#activity(),
      phase: s.phase,
      playing,
      hands: this.#sel.hands,
      handsAvailable: this.#heldHands === null,
      range: this.#sel.range,
      multiplier: this.#sel.multiplier,
      startAction: plan.action,
      startEnabled: plan.enabled,
      startReason: plan.reason,
      waiting,
      hintVisible: s.hint !== null,
      keyboardVisible: s.keyboardVisible,
      canHint:
        s.groupIndex !== null &&
        !s.inputComplete &&
        s.phase !== 'completed' &&
        s.phase !== 'interrupted' &&
        !this.#listen,
      repeat: this.#repeat,
      canRestartLoop: this.#repeat && !playing && !this.#inputHeld && plan.enabled && this.#accomp?.state !== 'playing',
      leadIn,
      repeatTarget: this.#repeatTarget,
      ladder: this.#ladder,
      lastResult: this.#resultForUi(),
      resultDimmed: this.#lastResult !== null && this.#resultPlayedIn !== null,
      resultExit: this.#resultExit,
      reviewing: this.#reviewing(),
      corrections: this.#correctionsVisible ? this.#corrections.length : 0,
      interruption: this.#interruption(),
      soundStatus: this.#soundStatus,
      inputDisconnected: this.#inputDisconnected,
      playThrough: false,
      micStatus: null,
      ...this.#followUi(),
      rhythm: this.#rhythm,
      countIn: this.#countIn?.remaining ?? null,
      metronomeScope: this.#metronomeScope(),
      metronomeMuted: false,
      // A lead-in that read to its end is not the end of the piece: it wraps into the attempt.
      finished: this.#engine.mode === 'reading' && s.phase === 'completed' && !leadIn,
    }
  }

  /** Recompute the current controls without changing the musical session. */
  refreshLanguage(): void {
    this.#publishUi()
  }

  #publishUi(): void {
    if (this.#disposed) return
    this.ui.set(this.#computeUi())
  }

  #cursorPosition(): number {
    if (this.#play) return this.#play.transport.positionNow()
    if (this.#listen) return this.#listen.transport.positionNow()
    if (this.#accomp) return this.#accomp.positionNow()
    const s = this.#engine.state
    if (s.position) return toNumber(s.position)
    return toNumber(s.phase === 'completed' && this.#repeat ? this.#timeline.end : this.#timeline.start)
  }

  #computeProgress(): SessionProgress {
    const position = this.#listen ? this.#listen.transport.positionNow() : this.#cursorPosition()
    return { position, occ: occAt(this.#model, position) }
  }

  #positionRational(pos: number, range: { start: Rational; end: Rational }): Rational {
    // The transport reports floats; resume from the bar containing it (exact positions only).
    const occ = this.#model.occurrences[occAt(this.#model, pos)]
    const start = occ?.start ?? range.start
    return toNumber(start) < toNumber(range.start) ? range.start : start
  }

  /**
   * The 88-key guide (U15, U20): both hands' notes at the cursor whatever hands are selected
   * (the learner's targets keep their accepted state), what playback sounds and the held keys,
   * named with the naming settings. While Listen plays it shows what sounds. Published only when
   * something visible changed.
   */
  #updateGuide(quiet: boolean, s: GuideSource = this.#engine.state): void {
    const current = (this.#listen?.playing ?? false) ? [] : this.#bothHandsAtCursor()
    const targets = quiet ? current : [...s.targetNotes, ...current]
    let roll: 'up' | 'down' | undefined
    for (const n of targets) {
      const a = this.#model.notes[n]?.arpeggio
      if (a !== undefined) roll = this.#model.arpeggios[a]?.direction ?? roll
    }
    const naming = this.#settings.naming
    // Previewed keys (U31) read as accepted or wrong like played ones.
    const keys = buildGuideKeys({
      notes: this.#model.notes,
      targetNotes: targets,
      acceptedPitches: this.#previewAccepted.size
        ? [...s.acceptedPitches, ...this.#previewAccepted]
        : s.acceptedPitches,
      sounding: this.#sounding.values(),
      heldKeys: s.heldKeys,
      heldWrongKeys: quiet
        ? []
        : this.#previewWrong.size
          ? [...s.heldWrongKeys, ...this.#previewWrong]
          : s.heldWrongKeys,
      noteLabel: (n) => this.#labels.texts.get(n),
      keyLabel: (midi) => labelForMidi(midi, naming).text,
    })
    this.guide.set({ keys, rollDirection: roll })
  }

  /** Notes of both hands in the first onset group at or after the cursor (U20). */
  #bothHandsAtCursor(): readonly number[] {
    const lead = this.#leadIn
    this.#bothTimeline ??= selectionTimeline(
      this.#model,
      this.#tempo,
      { ...this.#sel, hands: 'both', range: lead ? lead.span : this.#sel.range },
      { reattackHeldAtStart: lead === null },
    )
    const groups = this.#bothTimeline.groups
    // Prefer the learner target while reading. At completion, follow the transport instead.
    const target = this.#play ? this.#play.follower.state.position : this.#engine.state.position
    const at = (!this.#listen && target ? toNumber(target) : this.#cursorPosition()) - 1e-9
    let lo = 0
    let hi = groups.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (toNumber(groups[mid]!.position) < at) lo = mid + 1
      else hi = mid
    }
    return groups[lo]?.notes ?? []
  }

  /**
   * Note onsets the strip snaps the playhead and loop edges to (U19): the learner's hands, all
   * onsets in Listen. Cached per hand selection so the strip rebuilds its knots only on a change.
   */
  get snapOnsets(): readonly Rational[] {
    const hands = this.#sel.hands
    if (this.#snaps?.hands !== hands) this.#snaps = { hands, onsets: onsetPositions(this.#model, hands) }
    return this.#snaps.onsets
  }

  /** Strip state that depends on the selection only. */
  #applySelectionVisuals(): void {
    const strip = this.#strip
    if (!strip) return
    strip.setSnapPositions(this.snapOnsets)
    strip.setLoop(this.#sel.range)
    this.#lastVersion = -1
  }

  /**
   * The strip reviews the passage while a completed pass's result shows (U97): it zooms out to the
   * whole loop when the result appears. It zooms back in at count 2 in Keep time (U103), on the
   * first correct note in waiting practice (U101), or when the result is dismissed. Called from
   * the frame, never from the input path; the strip animates in its own frames.
   */
  #syncReview(): void {
    const strip = this.#strip
    if (!strip?.setReview) return
    const on = this.#reviewing()
    if (on === this.#reviewShown) return
    this.#reviewShown = on
    strip.setReview(on, this.#reviewReturnBy ?? undefined)
  }

  /** Whether the completed pass is still shown in the review frame (`#syncReview`, `ui.reviewing`). */
  #reviewing(): boolean {
    return (
      this.#lastResult !== null &&
      this.#resultPlayedIn === null &&
      this.#reviewReturnBy === null &&
      this.#sel.range !== null &&
      !this.#playThrough
    )
  }

  /** Loop handles, drag inspection and the cursor's repeat button by state. */
  #syncLock(): void {
    const strip = this.#strip
    if (!strip) return
    this.#syncReview()
    // A lead-in that read to its end still plays on to the wrap: as running.
    const running = this.#engine.state.phase === 'running' || this.#leadInTail()
    // Loop handles only in Repeat mode (U10), never while an attempt (or a lead-in into it) runs
    // or Listen plays.
    const editable = this.#repeat && !running && !this.#listen?.playing
    // The score can always be browsed; browsing while something plays holds it (U41, U95).
    const browse = true
    // The repeat button on the cursor (U14) opens Repeat at the cursor's bar: never in Repeat
    // mode, and while playing only with the chrome revealed (it goes with focus mode). The
    // playhead can be dragged only while paused outside Repeat mode (U23): there every pass
    // starts at the loop start.
    const playing = this.#isPlaying() || this.#browseHold !== null
    // Play-through covers the whole piece: no repeat button (P12).
    const cursorAction =
      this.#cursorActionAllowed && !this.#repeat && !this.#playThrough && (!playing || this.#chromeRevealed)
    const draggable = !this.#repeat && !playing
    const key = `${editable}|${browse}|${cursorAction}|${draggable}`
    if (key === this.#lockState) return
    this.#lockState = key
    strip.setLoopEditable(editable)
    strip.setBrowseEnabled(browse)
    strip.setCursorAction(cursorAction)
    strip.setCursorDraggable(draggable)
  }

  #saveResume(now: number, immediate: boolean, override?: null): void {
    if (this.#engine.mode !== 'reading' && override === undefined) return
    this.#lastResumeSave = now
    if (override === null) {
      this.#deps.piece.save({ resume: null }, immediate)
      return
    }
    // Play-through saves where the follower is, as reading saves where the engine is.
    const s = this.#play ? this.#play.follower.state : this.#engine.state
    if (!s.position || s.groupIndex === null) return
    const g = (this.#play ? this.#play.follower.timeline : this.#engine.timeline).groups[s.groupIndex]
    this.#deps.piece.save(
      {
        resume: {
          occ: g?.occ ?? occAt(this.#model, toNumber(s.position)),
          position: s.position,
          group: s.groupIndex,
          hands: this.#sel.hands,
          multiplier: this.#sel.multiplier,
          savedAt: Math.round((this.#deps.timeOrigin ?? 0) + now),
        },
      },
      immediate,
    )
  }

  #hintPedal(settings: SessionSettings): HintPedalTrigger | null {
    const m = settings.pedal.hintPedal
    return m ? new HintPedalTrigger(m) : null
  }
}

/** The timing summary of a Keep time record (`timingAccuracy`); nothing for any other record. */
function timingSummary(record: AttemptRecord): Pick<AttemptSummary, 'timing'> {
  const t = timingAccuracy(record)
  return t ? { timing: { groups: t.groups, onTime: t.onTime, early: t.early, late: t.late, missed: t.missed } } : {}
}

/** Stored settings are not clamped (normalizeSettings falls back per field only): keep 0..1. */
function level(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
}

/** Keep time's Playback volume is above 0%. */
function playbackAudible(settings: SessionSettings): boolean {
  return level(settings.rhythm?.scorePlaybackVolume ?? 1) > 0
}

/** Keep time's Playback is switched on above 0% (at 0% it counts as off). */
function playbackHeard(settings: SessionSettings): boolean {
  return settings.rhythm?.scorePlayback === true && playbackAudible(settings)
}

/** Bar index containing a float performance position. */
export function occAt(model: ScoreModel, position: number): number {
  const occs = model.occurrences
  let lo = 0
  let hi = occs.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (toNumber(occs[mid]!.start) <= position + 1e-9) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
