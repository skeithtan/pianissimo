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
 */
import {
  PracticeEngine,
  groupAtOrAfter,
  transportGates,
  type EngineEvent,
  type EngineState,
  type Phase,
  type Timeline,
} from '../../core/engine'
import { HintPedalTrigger } from '../../core/midi/hintPedal'
import { NATURAL, labelFor, labelForMidi } from '../../core/naming'
import type { MidiRouteEvent } from '../../core/midi/adapter'
import { CC_ALL_NOTES_OFF, type MidiInputEvent } from '../../core/midi/types'
import { onsetPositions, passageFromBounds, passageKey, samePassage } from '../../core/model/passage'
import type { AttemptRecord, InterruptReason, PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { type Rational, ZERO, eq, key as ratKey, lt, toNumber } from '../../core/music/rational'
import { hasTempo, type TempoMapData } from '../../core/music/tempo'
import {
  buildClickTrack,
  buildPerformance,
  createTransport,
  passageRange,
  type ClickEvent,
  sharedAudioContext,
  type BrowserAudioModule,
  type ControlEvent,
  type MetronomeModule,
  type MetronomeSink,
  type NoteOffEvent,
  type NoteOnEvent,
  type OutputBackend,
  type Transport,
} from '../../core/playback'
import { PersistentLabels, labelSnapshot, mergeOpacity, sameOpacity } from './labels'
import {
  accompanimentAllowed,
  defaultMidiBackend,
  hasSoundOutput,
  noPlaybackReason,
  outputKey,
  performanceKey,
  playbackDestination,
  type PlaybackKind,
} from './output'
import { clampPassage, sameSelection, selectionTimeline, startPlan, type Selection } from './selection'
import { buildGuideKeys, sameGuideKeys } from './guide'
import { correctionMarks, type CorrectionMark } from './corrections'
import { Store, shallowEqual } from './store'
import type {
  Activity,
  AttemptSummary,
  FeedbackState,
  FlashSink,
  GuideState,
  Interruption,
  MidiBackendLike,
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
  /**
   * Open with Repeat mode on (a preset passage, DECISIONS U10). `selection.range` is the loop;
   * without one the loop starts at the first bar. Default: closed (reading), loop remembered.
   */
  readonly repeat?: boolean
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

const RESUME_SAVE_MS = 5000
const ACTIVE: readonly Phase[] = ['preparing', 'ready', 'running']

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
  /** Click schedules exist from the start; sound can be enabled later without rebuilding time. */
  readonly #metronomeSink: MetronomeSink = {
    click: (time, accent) => this.#metronome?.click(time, accent),
    cancel: (now) => this.#metronome?.cancel(now),
  }
  /** Listen (both hands off): its transport and the output it was built for. */
  #listen: { transport: Transport; playing: boolean; outputKey: string } | null = null

  // Lifecycle
  #readingStarted = false
  #awaitPrepared = false
  #pendingRepeat = false
  /** Repeat mode (U10): loop controls shown, Start = scored attempts over `#loop`, repeated. */
  #repeat = false
  /** The loop, remembered while Repeat mode is closed (saved as `lastPassage`). */
  #loop: PassageRange | null = null
  #repeatTarget: number | null
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
  /** Teacher's marks of the last completed scored attempt, shown on the strip (`#clearCorrections`). */
  #corrections: readonly CorrectionMark[] = []
  #inputDisconnected = false
  /** The learner's hands, held while no piano input is connected (the session is in Listen, U27). */
  #heldHands: HandSelection | null = null
  #soundStatus: string | null = null
  #completedPending = false
  #lockState = ''

  // Frame and timers
  #frameHandle: unknown = null
  #tickHandle: unknown = null
  #tickAt = Infinity
  #lastVersion = -1
  #wrongPending = 0
  #wrongReason: 'wrong' | 'early' = 'wrong'
  /** The correction cue at the cursor and the missing pitch it points to (U30 revised). */
  #cue: { target: number; cue: StageCue } | null = null
  /** The chrome is revealed (not in focus mode): the cursor's repeat button may show while playing. */
  #chromeRevealed = true
  #pulse = 0
  #lastPersistent: ReadonlyMap<number, number> | null = null
  #lastTemp: ReadonlyMap<number, number> = new Map()
  #labelsDirty = true
  #emitQueue: { time: number; ev: NoteOnEvent | NoteOffEvent }[] = []
  readonly #sounding = new Map<number, readonly number[]>()
  #highlightsDirty = false
  #lastResumeSave = -Infinity
  #processing = false
  #again = false
  #disposed = false
  /** An overlay (Settings, Connection) is open: keys go to it, never to the engine. */
  #inputHeld = false
  /** The Start in progress (`start`): sounds may be loading. */
  #starting: Promise<void> | null = null
  /** Both hands' onset groups for the keyboard guide (U20); rebuilt on first use per selection. */
  #bothTimeline: Timeline | null = null
  /** Snap onsets of the current hands for the strip (U19), rebuilt when the hands change. */
  #snaps: { hands: HandSelection; onsets: readonly Rational[] } | null = null
  /**
   * Key feedback while nothing plays (DECISIONS U31): held keys judged against the current group
   * by the session alone (the engine ignores presses outside running phases). Required pitches
   * show as accepted, others as the red cursor tint; nothing is recorded, counted or advanced.
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
    this.#loop = clampPassage(options.model, options.selection.range)
    this.#repeat = options.repeat === true
    if (this.#repeat && !this.#loop) this.#loop = { fromOcc: 0, toOcc: 0 }
    this.#sel = { ...options.selection, range: this.#repeat ? this.#loop : null }
    this.#repeatTarget = options.repeatTarget ?? null
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
    this.#lastVersion = -1
    this.#lockState = ''
    this.#lastPersistent = null
    this.#labelsDirty = true
    strip.setLabels(this.#labels.texts)
    if (this.#corrections.length) strip.setCorrections?.(this.#corrections)
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
    if (this.#isPlaying()) this.pause()
    else void this.start()
  }

  /**
   * Start reading, a scored attempt or Preview, per the selection. One Start at a time: a second
   * one while sounds load joins the first (it would otherwise stop the transport the first one
   * started at Ready).
   */
  start(): Promise<void> {
    this.#starting ??= this.#start().finally(() => (this.#starting = null))
    return this.#starting
  }

  async #start(): Promise<void> {
    const first = this.#plan()
    if (!first.enabled) return
    this.#clearCorrections()
    if (first.action === 'listen') {
      await this.#startListening()
      return
    }
    if (this.#listen) this.#stopListening()
    if (this.#sel.hands !== 'both') {
      const output = await this.#ensureOutput()
      if (!output || this.#disposed) return
    }
    await this.#ensureMetronome()
    if (this.#disposed) return
    // The selection may have changed while sounds loaded (the loop cleared, the hands changed).
    const plan = this.#plan()
    if (!plan.enabled) return
    if (plan.action === 'listen') {
      await this.#startListening()
      return
    }
    // One hand chosen meanwhile on browser sound not loaded yet: load it first.
    if (this.#sel.hands !== 'both' && !this.#ensureOutputSync()) return this.#start()
    this.#ensureAccompaniment()
    const t = this.#deps.clock()
    const lead = this.#leadIn
    if (lead && !lead.handedOver && this.#engine.mode === 'reading') {
      this.#startLeadIn(t)
    } else if (plan.action === 'scored') {
      if (this.#engine.mode !== 'scored') {
        this.#engine.reconfigure(
          { reason: 'mode-change', mode: 'scored', timeline: this.#timeline, transport: 'accompaniment' },
          t,
        )
      } else if (!ACTIVE.includes(this.#engine.state.phase)) {
        this.#engine.restart(t)
      }
      this.#lastResult = null
      this.#streak = 0
      this.#prepareAttempt(t)
    } else {
      if (this.#engine.mode !== 'reading') {
        this.#engine.reconfigure(
          { reason: 'mode-change', mode: 'reading', timeline: this.#timeline, transport: 'accompaniment' },
          t,
        )
      }
      const phase = this.#engine.state.phase
      if (phase === 'completed') {
        this.#engine.restart(t)
        this.#accomp?.stop()
      } else if (phase === 'paused' || phase === 'interrupted') this.#engine.resume(t)
      if (this.#engine.state.phase === 'paused') this.#engine.resume(t)
      this.#readingStarted = true
      this.#playAccompanimentFromCurrent(t)
    }
    this.#process(this.#deps.clock())
  }

  /** Pause: reading keeps progress; a scored attempt is interrupted (spec); Preview pauses. */
  pause(): void {
    const now = this.#deps.clock()
    if (this.#listen) {
      if (this.#listen.playing) {
        this.#listen.transport.pause()
        this.#listen.playing = false
        this.#clearHighlights()
      }
      this.#process(now)
      return
    }
    this.#pauseTransports()
    this.#pendingRepeat = false
    this.#awaitPrepared = false
    this.#engine.pause(now)
    this.#saveResume(now, true)
    this.#process(now)
  }

  /** Restart passage / Repeat now: a running attempt is abandoned ('user-restart'). */
  restart(): void {
    const now = this.#deps.clock()
    this.#clearCorrections()
    if (this.#listen) {
      const range = passageRange(this.#model, this.#sel.range)
      this.#listen.transport.seek(range.start)
      this.#clearHighlights()
      this.#process(now)
      return
    }
    this.#pauseTransports()
    this.#pendingRepeat = false
    if (this.#leadIn && this.#engine.mode === 'reading') {
      // Restart in Repeat mode is an attempt at the loop start, also from a lead-in.
      const plan = this.#plan()
      this.#leaveLeadIn(now)
      if (plan.enabled && plan.action === 'scored') {
        this.#engine.reconfigure(
          { reason: 'mode-change', mode: 'scored', timeline: this.#timeline, transport: 'accompaniment' },
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
    if (this.#engine.mode !== 'reading') {
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
    // In Repeat mode the loop's first bar is the loop start, also when the loop starts inside it
    // (an attempt at the loop start); any other bar is a lead-in from that bar (`seekPosition`).
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
   * playhead lands on a note, U23). Listen seeks its transport there. In Repeat mode any position
   * but the loop start sets up a lead-in there (the cursor and the stage move at once; Start
   * reads from it until the music next arrives at the loop start, where the attempt takes over;
   * a running attempt is interrupted, P6); the loop start itself keeps the attempt at the loop
   * start. Returns false when nothing moved (a scored attempt keeps its passage start, P6).
   */
  seekPosition(position: Rational): boolean {
    const now = this.#deps.clock()
    this.#clearCorrections()
    if (this.#listen) {
      this.#listen.transport.seek(position)
      this.#clearHighlights()
      this.#process(now)
      return true
    }
    if (this.#repeat && this.#sel.range && this.#sel.hands !== 'none') {
      const p = lt(position, ZERO) ? ZERO : position
      if (!eq(p, passageRange(this.#model, this.#sel.range).start)) return this.#seekLeadIn(p, now)
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
    const phase = this.#engine.state.phase
    if (this.#engine.mode === 'scored') {
      // A seek during a running attempt interrupts it; otherwise the attempt stays at its start.
      if (phase === 'running') {
        this.#pauseTransports()
        this.#engine.seek(0, now)
        this.#process(now)
      }
      return false
    }
    // The engine's own groups (the session's selection may be a hands hold, U27).
    const timeline = this.#engine.timeline
    const group = groupAtOrAfter(timeline, position)
    if (group >= timeline.groups.length) return false
    this.#engine.seek(group, now)
    const g = timeline.groups[group]
    if (this.#accomp && g) {
      this.#accomp.seek(g.position)
      this.#clearHighlights()
    }
    this.#saveResume(now, true)
    this.#process(now)
    return true
  }

  // ── Lead-in (Repeat mode) ─────────────────────────────────────────────────────────────

  /**
   * A seek in Repeat mode anywhere but the loop start: a lead-in from `position`. It is set up
   * paused (a lead-in that was playing keeps playing from there); Start reads it like ordinary
   * reading with the same hands, tempo and gates, and the scored attempt over the loop takes over
   * the next time the music arrives at the loop start: at the loop start itself from before the
   * loop, after wrapping at the loop end from inside it, after wrapping at the piece end from
   * after it. Repeat mode and the loop stay as they are.
   */
  #seekLeadIn(position: Rational, now: number): boolean {
    const loop = passageRange(this.#model, this.#sel.range)
    const start = lt(position, ZERO) ? ZERO : position
    const wrap = !lt(start, loop.start)
    const end = !wrap ? loop.start : lt(start, loop.end) ? loop.end : this.#model.totalDuration
    const passage = passageFromBounds(this.#model, start, end)
    const span = wrap ? passage : passageFromBounds(this.#model, start, loop.end)
    if (!passage || !span) return false
    const timeline = selectionTimeline(this.#model, this.#tempo, { ...this.#sel, range: passage })
    const lead = this.#leadIn
    const keepPlaying =
      lead !== null &&
      !lead.handedOver &&
      this.#engine.mode === 'reading' &&
      (this.#engine.state.phase === 'running' || this.#leadInTail())
    this.#pauseTransports()
    this.#awaitPrepared = false
    this.#pendingRepeat = false
    this.#disposeAccompaniment()
    this.#leadInKeys.add(passageKey(timeline.context.passage))
    this.#leadIn = { start, passage, timeline, span, wrap, handedOver: false }
    this.#bothTimeline = null
    // An attempt in progress ends here ('seek'); one not yet started leaves no record.
    this.#engine.reconfigure(
      { reason: 'seek', mode: 'reading', timeline, transport: 'accompaniment', startGroup: 0 },
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
    this.#clearHighlights()
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
  async #startListening(): Promise<void> {
    if (!hasTempo(this.#tempo)) return
    const now = this.#deps.clock()
    const key = outputKey(this.#settings, this.#destination())
    const position = this.#listen ? this.#listen.transport.positionNow() : null
    if (
      this.#listen &&
      !this.#listen.playing &&
      this.#listen.outputKey === key &&
      this.#output &&
      this.#outputKey === key
    ) {
      this.#listen.transport.play()
      this.#listen.playing = true
      this.#process(now)
      return
    }
    // Another destination than last time: release the old transport before its output goes.
    if (this.#listen) this.#disposeListen()
    const output = await this.#ensureOutput()
    if (!output || this.#disposed) return
    await this.#ensureMetronome()
    if (this.#disposed) return
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
    let start = range.start
    if (position !== null) start = this.#positionRational(position, range)
    else if (!this.#sel.range) {
      const g = this.#engine.state.position
      if (g) start = g
    }
    transport.seek(start)
    transport.play()
    this.#listen = { transport, playing: true, outputKey: this.#outputKey }
    this.#process(this.#deps.clock())
  }

  requestHint(): void {
    const now = this.#deps.clock()
    this.#engine.requestHint(now)
    this.#process(now)
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
    let loop = this.#loop
    if (open && !loop) {
      const occ = Math.max(0, Math.min(this.#model.occurrences.length - 1, at ?? this.progress.get().occ))
      loop = { fromOcc: occ, toOcc: occ }
    }
    this.#select({ hands: this.#sel.hands, multiplier: this.#sel.multiplier }, loop, open)
  }

  /**
   * The cursor's repeat button (U14): opens Repeat mode with a fresh one-bar loop at `occ` (the
   * cursor's bar), replacing a remembered loop.
   */
  repeatFrom(occ: number): void {
    const at = Math.max(0, Math.min(this.#model.occurrences.length - 1, Math.trunc(occ)))
    this.#select({ hands: this.#sel.hands, multiplier: this.#sel.multiplier }, { fromOcc: at, toOcc: at }, true)
  }

  /**
   * The cursor's repeat button, pressed (U14): pauses what plays, then opens Repeat mode with a
   * one-bar loop at the cursor's bar. It is never shown in Repeat mode, so there is no toggle.
   */
  repeatAtCursor(): void {
    const occ = occAt(this.#model, this.#cursorPosition())
    if (this.#isPlaying()) this.pause()
    this.repeatFrom(occ)
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
   * Whether a piano input is connected (U27). Without one the learner cannot play a hand, so
   * the hands go off (Listen) without touching the piece's remembered hands; they come back when
   * the piano does.
   */
  setInputAvailable(available: boolean): void {
    if (available === (this.#heldHands === null)) return
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
    this.#deps.piece.save({ repeatTarget: target })
    this.#publishUi()
  }

  /** Dismiss the compact result card. */
  dismissResult(): void {
    this.#lastResult = null
    this.#clearCorrections()
    this.#publishUi()
  }

  // ── Selection ─────────────────────────────────────────────────────────────────────────

  /**
   * Hands, passage or speed changed. A scored attempt in progress is interrupted and, when the
   * new selection still allows it, a fresh attempt is prepared (new comparison context);
   * reading continues from the current position; Preview reschedules speed live.
   */
  setSelection(patch: Partial<Selection>): void {
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
  }

  /** `persist` false: a selection the session imposes (hands held without a piano), not the learner's. */
  #select(base: Omit<Selection, 'range'>, loop: PassageRange | null, repeat: boolean, persist = true): void {
    const next: Selection = { ...base, range: repeat ? loop : null }
    const prev = this.#sel
    const modeChanged = repeat !== this.#repeat
    // While the hands are held without a piano (U27) the learner's own hands are saved, never 'none'.
    const handsChanged = this.#heldHands === null && base.hands !== prev.hands
    if (persist && (handsChanged || base.multiplier !== prev.multiplier || !samePassage(loop, this.#loop))) {
      this.#deps.piece.save({
        lastHands: this.#heldHands ?? base.hands,
        lastPassage: loop,
        lastMultiplier: base.multiplier,
      })
    }
    this.#loop = loop
    this.#repeat = repeat
    if (!repeat) this.#pendingRepeat = false
    if (sameSelection(next, prev)) {
      if (modeChanged) this.#process(this.#deps.clock())
      return
    }
    // The result card goes with its corrections (U39).
    this.#lastResult = null
    this.#clearCorrections()
    const now = this.#deps.clock()
    const reason: InterruptReason =
      next.hands !== prev.hands
        ? 'hand-change'
        : modeChanged
          ? 'mode-change'
          : !samePassage(next.range, prev.range)
            ? 'range-change'
            : 'tempo-change'

    if (this.#listen) {
      if (reason === 'tempo-change') {
        this.#sel = next
        this.#listen.transport.setMultiplier(next.multiplier)
        this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
        this.#bothTimeline = null
        this.#process(now)
        return
      }
      this.#stopListening()
    }

    const lead = this.#leadIn
    if (lead && !lead.handedOver && reason === 'tempo-change' && this.#engine.mode === 'reading') {
      // A lead-in keeps going at the new speed (its gates do not move).
      this.#sel = next
      this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
      lead.timeline = selectionTimeline(this.#model, this.#tempo, { ...next, range: lead.passage })
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
      this.#engine.reconfigure({ reason, timeline: this.#timeline, transport: 'accompaniment' }, now)
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
    const scoredActive = this.#engine.mode === 'scored' && ACTIVE.includes(phase)
    // Any other change ends a lead-in: the session stops where Repeat mode would (P4).
    const leadReading = lead !== null && this.#engine.mode === 'reading'
    const leadPosition = leadReading ? (this.#engine.state.position ?? lead.start) : null
    const readingRunning = !leadReading && this.#engine.mode === 'reading' && phase === 'running'
    this.#pauseTransports()
    this.#disposeAccompaniment()
    this.#leadIn = null
    if (leadReading) this.#readingStarted = false
    this.#awaitPrepared = false
    this.#pendingRepeat = false
    this.#sel = next
    this.#timeline = selectionTimeline(this.#model, this.#tempo, next)
    this.#bothTimeline = null
    const plan = this.#plan()
    // A new passage reads from its start; closing Repeat mode reads on from the loop's start (or
    // from where a lead-in was).
    const startGroup =
      prev.range && !next.range
        ? groupAtOrAfter(this.#timeline, leadPosition ?? passageRange(this.#model, prev.range).start)
        : 0

    if (this.#engine.mode === 'scored' || scoredActive) {
      if (scoredActive && plan.action === 'scored' && plan.enabled) {
        this.#engine.reconfigure({ reason, timeline: this.#timeline, mode: 'scored', transport: 'accompaniment' }, now)
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
    if (prev.pedal !== next.pedal) {
      this.#engine.updateSettings(
        { hintPedal: this.#hintPedal(next), hintPedalAction: next.pedal.hintPedalAction },
        now,
      )
    }
    if (this.#output && outputKey(next, this.#destination()) !== this.#outputKey) {
      this.#destinationChanged()
    } else if (performanceKey(prev) !== performanceKey(next) && !this.#isPlaying()) {
      this.#disposeAccompaniment()
    }
    // Volumes apply live to sound already loaded (Settings over Practice).
    if (prev.sound.browserVolume !== next.sound.browserVolume) this.#browser?.setVolume(next.sound.browserVolume)
    if (prev.metronome.volume !== next.metronome.volume) this.#metronome?.setVolume(next.metronome.volume)
    if (prev.metronome.enabled !== next.metronome.enabled) {
      if (next.metronome.enabled) void this.#ensureMetronome()
      this.#accomp?.setMetronomeEnabled(next.metronome.enabled)
      this.#listen?.transport.setMetronomeEnabled(next.metronome.enabled)
    }
    this.#process(now)
  }

  /** The layout is being re-prepared (label width changed): an explicit layout operation. */
  layoutChanging(): void {
    const now = this.#deps.clock()
    if (this.#engine.mode === 'scored' && ACTIVE.includes(this.#engine.state.phase)) {
      this.#pauseTransports()
      this.#engine.interrupt('layout-change', now)
    }
    this.#strip = null
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
    this.#process(now)
  }

  /** Leaving the view: a running attempt is a user stop; output is cleaned up. */
  dispose(): void {
    if (this.#disposed) return
    const now = this.#deps.clock()
    if (
      this.#engine.state.phase === 'running' ||
      (this.#engine.mode === 'scored' && ACTIVE.includes(this.#engine.state.phase))
    ) {
      this.#engine.interrupt('user-stop', now)
    }
    this.#saveResume(now, true)
    this.#drain(now)
    this.#disposed = true
    this.#stopListening()
    this.#disposeAccompaniment()
    this.#disposeOutput()
    for (const off of this.#unsubs.splice(0)) off()
    if (this.#frameHandle !== null) this.#deps.frames.cancel(this.#frameHandle)
    if (this.#tickHandle !== null) this.#deps.timers.clearTimeout(this.#tickHandle)
    this.#frameHandle = null
    this.#tickHandle = null
    this.#clearCorrections()
    this.#strip = null
  }

  // ── MIDI input path (O(small)) ────────────────────────────────────────────────────────

  #onMidi(ev: MidiInputEvent): void {
    if (this.#disposed) return
    this.#midiBackend?.humanInput(ev)
    // The monitor hears releases under an overlay too, so no key or pedal stays down in it.
    this.#monitor?.(ev)
    if (this.#inputHeld) return
    // Echoes of Preview output on an echoing route must never reach the engine (spec).
    if (this.#listen && this.#settings.route.echo === 'echo-detected' && this.#outputKind === 'midi') return
    // Judged before the input: a press never changes the group or phase while nothing plays.
    const group = this.#previewGroupNow()
    this.#engine.input(ev)
    if (group !== null) this.#previewInput(ev, group)
    else this.#clearPreview()
    this.#process(ev.time)
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
        this.#inputDisconnected = true
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
    if (this.#sel.hands === 'both' && !this.#listen) {
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
    if (this.#sel.hands === 'both' && !this.#listen) {
      this.#midiBackend?.disconnected()
      this.#disposeOutput()
      this.#soundStatus = null
      return
    }
    const now = this.#deps.clock()
    this.#accomp?.interrupt()
    this.#listen?.transport.interrupt()
    if (this.#listen) this.#listen.playing = false
    this.#midiBackend?.disconnected()
    // Auto continues through this device on the next Start / Play (S4).
    const onDevice = this.#destination() === 'browser'
    this.#soundStatus = !onDevice
      ? 'The piano output was disconnected. Reconnect it to hear playback.'
      : this.#listen
        ? 'The piano output was disconnected. Press Play to keep listening through this device.'
        : 'The piano output was disconnected. Press Start to continue through this device.'
    if (
      this.#engine.transport === 'accompaniment' &&
      (this.#engine.state.phase === 'running' || ACTIVE.includes(this.#engine.state.phase))
    ) {
      this.#awaitPrepared = false
      this.#pendingRepeat = false
      this.#engine.interrupt('disconnect', now)
    }
    this.#clearHighlights()
    this.#process(now)
  }

  #stopSound(): void {
    // Stuck-note recovery: stop app playback; a scored attempt cannot continue without it.
    if (this.#listen?.playing) this.pause()
    else if (this.#engine.transport === 'accompaniment' && this.#isPlaying()) this.pause()
    this.#accomp?.stopSound()
    this.#listen?.transport.stopSound()
    this.#clearHighlights()
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
        if (ev.pitch === this.#cue?.target) this.#cue = null
        break
      case 'input-complete':
        this.#cue = null
        this.#accomp?.releaseGate(ev.group + this.#gateOffset)
        break
      case 'wrong':
        // A re-attacked tie end is a gentle nudge: the amber marker only (`#frame`), no pulse,
        // flash or cue. Widened: an engine without the reason never sends it.
        if ((ev.reason as string) === 'tie-end') break
        this.#wrongPending++
        this.#wrongReason = ev.reason === 'early' ? 'early' : 'wrong'
        this.#cue =
          ev.reason === 'early'
            ? null
            : (this.#octaveCorrection(ev.group, ev.pitch) ?? this.#accidentalCorrection(ev.group, ev.pitch))
        break
      case 'phase':
        this.#cue = null
        this.#onPhase(ev.phase, now)
        break
      case 'attempt-ended':
        this.#onRecord(ev.record)
        break
      case 'abandon':
        // Leaving during a lead-in (user stop) abandons nothing: it is not recorded.
        if (this.#leadIn && !this.#leadIn.handedOver && this.#engine.mode === 'reading') break
        this.#deps.history.queueAbandon(ev.event)
        break
      case 'exposure-reset':
        this.#reportVisibleLabels(now)
        break
      case 'advanced':
        this.#cue = null
        this.#lastVersion = -1
        break
      default:
        break
    }
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
    if (phase === 'ready') {
      // The automatic part may start (an introduction plays); the clock waits for the first press.
      if (this.#accomp && this.#engine.transport === 'accompaniment') this.#accomp.play(t)
    } else if (phase === 'running' && this.#engine.mode === 'scored') {
      // The first press of the next pass: the previous pass's card and marks go (Repeat keeps
      // them through the automatic restart so the learner sees what to improve).
      this.#lastResult = null
      this.#clearCorrections()
    } else if (phase === 'completed') {
      if (this.#engine.mode === 'scored') this.#completedPending = true
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
    if (record.kind !== 'scored' || record.completion !== 'completed') return
    this.#streak = record.passed ? this.#streak + 1 : 0
    const targetReached = this.#repeatTarget !== null && this.#streak >= this.#repeatTarget
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
    }
    this.#corrections = correctionMarks(record, this.#timeline, this.#model, this.#settings.naming)
    this.#strip?.setCorrections?.(this.#corrections)
  }

  /**
   * The teacher's marks go: a new attempt (Start, Restart), a dismissed result, another
   * selection, a seek, leaving Practice, or the first press of the next Repeat pass.
   */
  #clearCorrections(): void {
    if (this.#corrections.length === 0) return
    this.#corrections = []
    this.#strip?.setCorrections?.([])
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
    this.#pendingRepeat = false
    this.#accomp?.stop()
    this.#clearHighlights()
    this.#engine.restart(now)
    this.#prepareAttempt(now)
    // Back to the loop start: the strip pans there quickly instead of scrolling backward.
    this.#strip?.wrapTo?.(this.#cursorPosition())
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
      this.#accomp?.seek(this.#timeline.end)
      this.#clearHighlights()
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
    }
    this.#clearHighlights()
    this.#process(now)
  }

  /**
   * Scored preparation: transports back to the passage start, then `markPrepared` once the
   * strip is ready and persistent-label fades have finished (spec: "Before marking a new
   * scored attempt Ready, finish any outgoing label fades"). The engine itself waits for
   * released keys and sound-retaining pedals and for temporary-hint fades.
   */
  #prepareAttempt(now: number): void {
    // Every new attempt starts at the loop start, on the loop's own transport.
    this.#endLeadIn()
    this.#accomp?.stop()
    this.#clearHighlights()
    this.#flash?.clear()
    this.#awaitPrepared = true
    this.#tryPrepared(now)
  }

  #tryPrepared(now: number): void {
    if (!this.#awaitPrepared || this.#engine.state.phase !== 'preparing') return
    if (!this.#strip) return
    if (this.#engine.transport === 'accompaniment' && !this.#accomp) return
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
    const backend = make(out, this.#settings.route.outputChannel, this.#settings.route.echo !== 'echo-detected')
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
    this.#soundStatus = 'Loading piano sounds…'
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
        this.#soundStatus = 'Browser sound could not be loaded.'
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

  async #ensureMetronome(): Promise<void> {
    if (!this.#settings.metronome.enabled || this.#metronome || !this.#deps.loadMetronome) return
    try {
      const m = await this.#deps.loadMetronome()
      if (this.#disposed || this.#metronome) return
      this.#metronome = new m.WebAudioMetronome({
        context: sharedAudioContext(),
        clock: this.#deps.clock,
        volume: this.#settings.metronome.volume,
      })
    } catch {
      this.#metronome = null
    }
  }

  /** Every practice mode uses gates; both hands has no automatic notes or sound backend. */
  #ensureAccompaniment(): void {
    if (this.#sel.hands === 'none' || !hasTempo(this.#tempo)) return
    const both = this.#sel.hands === 'both'
    const output = both ? null : (this.#output ?? this.#ensureOutputSync())
    if (!both && !output) return
    // A lead-in that has not reached the loop plays on one transport into the loop: its gates are
    // the lead-in's groups, then the loop's (engine group i = gate i + `#gateOffset`). One from
    // inside or after the loop has only its own gates: at its end the music wraps (`#wrapLeadIn`).
    const lead = this.#leadIn && !this.#leadIn.handedOver ? this.#leadIn : null
    const key = `${performanceKey(this.#settings)}|${this.#outputKey}${lead ? `|lead ${ratKey(lead.start)}` : ''}`
    if (this.#accomp && this.#accompKey === key) return
    this.#disposeAccompaniment()
    const range = passageRange(this.#model, lead ? lead.span : this.#sel.range)
    const gates = !lead
      ? transportGates(this.#timeline)
      : lead.wrap
        ? transportGates(lead.timeline)
        : [...transportGates(lead.timeline), ...transportGates(this.#timeline)]
    const leadGroups = lead ? lead.timeline.groups.length : 0
    const route = this.#settings.route
    const sendPedals = !both && route.automaticPedalsInHandPractice
    const events = both
      ? []
      : buildPerformance(this.#model, {
          hands: this.#sel.hands,
          range,
          accompanimentLevel: level(route.accompanimentLevel),
          sendPedals,
        })
    const transport = createTransport({
      clock: this.#deps.clock,
      timers: this.#deps.timers,
      tempo: this.#tempo,
      multiplier: this.#sel.multiplier,
      events,
      gates,
      range,
      backend: output,
      metronome: {
        sink: this.#metronomeSink,
        clicks: buildClickTrack(this.#model, range),
        enabled: this.#settings.metronome.enabled,
      },
      onGateReached: (gate) => {
        const t = this.#deps.clock()
        // Before the hand-over only the lead-in's gates belong to the (reading) engine.
        const early = lead !== null && !lead.handedOver && gate >= leadGroups
        if (!early && gate >= this.#gateOffset) this.#engine.transportArrived(gate - this.#gateOffset, t)
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
   * `#ensureAccompaniment`, and when one hand needs browser sound that is not loaded yet (both
   * hands never loads it), load it and build the transport afterwards, then `then(now)`.
   */
  #ensureTransport(then: (now: number) => void): void {
    this.#ensureAccompaniment()
    if (this.#accomp || this.#sel.hands === 'both' || this.#sel.hands === 'none') return
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
    if (this.#accomp && this.#accomp.state === 'playing') this.#accomp.pause()
    this.#clearHighlights()
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
    this.#clearHighlights()
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

  #clearHighlights(): void {
    this.#emitQueue = []
    if (this.#sounding.size) {
      this.#sounding.clear()
      this.#highlightsDirty = true
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
    const strip = this.#strip
    const s = this.#engine.state
    this.#maintainPreview(s)
    const previewChanged = this.#previewDirty
    this.#previewDirty = false
    const versionChanged = s.version !== this.#lastVersion || force
    // Listen mode (both hands off, U9) shows no targets, even before Play.
    const quiet = this.#listen !== null || this.#sel.hands === 'none'
    if (versionChanged || previewChanged) {
      this.#lastVersion = s.version
      if (strip) {
        strip.setTargets(quiet ? [] : s.targetNotes)
        strip.setAccepted(quiet ? [] : this.#acceptedNotes(s))
        // A right pitch too early, or a re-attacked tie end, tints the cursor amber instead of red
        // (P3 revised). Widened: an engine without the 'tie-end' reason never reports it.
        const reason = s.lastWrongReason as string | null
        const soft = reason === 'early' || reason === 'tie-end'
        // A previewed wrong key tints the cursor too, without a pulse or a flash (U31).
        const wrong = (s.groupHasError && !soft) || this.#previewWrong.size > 0
        strip.setWrongMarker(wrong && !quiet)
        strip.setEarlyMarker?.(s.groupHasError && soft && !quiet)
        strip.setOttavaEmphasis(quiet ? [] : s.ottavaWarning)
        if (!this.#listen && !this.#accomp) strip.setCursor(this.#cursorPosition())
      }
    }
    if (this.#wrongPending > 0) {
      this.#wrongPending = 0
      this.#pulse++
      // The red edge flash is optional (S5); the tint, marker and cues above are not.
      if (this.#wrongReason === 'early') {
        // Too early is a timing slip, not a wrong key: the soft flash only (P3 revised).
        if (this.#settings.hints.damageFlash) this.#flash?.hit(now, s.wrongFeedbackUntil, { soft: true })
      } else {
        strip?.pulseWrong()
        if (this.#settings.hints.damageFlash) this.#flash?.hit(now, s.wrongFeedbackUntil)
      }
    }
    // The cue stays until its target is accepted or another wrong attack replaces it. A tie-end
    // press shows nothing here: the amber marker is its whole feedback.
    const showing =
      !quiet && s.phase !== 'interrupted' && s.groupHasError && (s.lastWrongReason as string | null) !== 'tie-end'
    this.feedback.set({
      visible: showing,
      reason: s.lastWrongReason === 'early' ? 'early' : 'wrong',
      pulse: this.#pulse,
      cue: showing ? (this.#cue?.cue ?? null) : null,
    })

    // Labels: temporary hints (engine, eased) combined with persistent labels by max.
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
    if (strip && (this.#labelsDirty || persistent !== this.#lastPersistent || !sameOpacity(temp, this.#lastTemp))) {
      strip.setLabelOpacity(mergeOpacity(persistent, temp))
      this.#labelsDirty = false
      this.#lastPersistent = persistent
      this.#lastTemp = temp
    }

    // The notes follow musical time in Listen and practice, holding at an unreleased gate.
    if ((this.#listen || this.#accomp) && strip) strip.setCursor(this.#cursorPosition(), { smooth: false })

    // Playback highlights of the automatic part / Preview.
    if (this.#emitQueue.length) {
      const due = this.#emitQueue.filter((e) => e.time <= now)
      if (due.length) {
        this.#emitQueue = this.#emitQueue.filter((e) => e.time > now)
        for (const { ev } of due) {
          if (ev.kind === 'on') this.#sounding.set(ev.voice, ev.notes)
          else this.#sounding.delete(ev.voice)
        }
        this.#highlightsDirty = true
      }
    }
    // The keyboard guide follows the group, the held keys and what playback sounds (U15).
    if (s.keyboardVisible && (versionChanged || previewChanged || this.#highlightsDirty)) this.#updateGuide(quiet)
    if (this.#highlightsDirty && strip) {
      this.#highlightsDirty = false
      const notes: number[] = []
      for (const ns of this.#sounding.values()) notes.push(...ns)
      strip.setPlaybackHighlights(notes)
    }

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
      tempChanging ||
      this.#labels.fading ||
      this.#emitQueue.length > 0 ||
      (this.#accomp?.state === 'playing' && this.#accomp.holdingGate === null)
    if (more) this.#scheduleFrame()
    this.#tryPrepared(now)
  }

  /** Wake for engine deadlines (pending presses, hint expiry and fades), label fades before Ready. */
  #scheduleTick(): void {
    if (this.#disposed) return
    const now = this.#deps.clock()
    let at = this.#engine.nextDeadline() ?? Infinity
    const hint = this.#engine.state.hint
    if (hint?.expiresAt != null) {
      const fadeStart = hint.expiresAt - this.#settings.hints.fadeMs
      if (fadeStart > now) at = Math.min(at, fadeStart)
    }
    if (this.#awaitPrepared) {
      const f = this.#labels.fadingUntil()
      if (f > now) at = Math.min(at, f)
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
        this.#engine.tick(t)
        this.#tryPrepared(t)
        this.#process(t)
      },
      Math.max(0, at - now),
    )
  }

  // ── Derived state ─────────────────────────────────────────────────────────────────────

  #plan() {
    const out = this.#deps.midi.output()
    const browser = this.#browserSoundPossible()
    return startPlan(this.#timeline, this.#sel, {
      hasOutput: hasSoundOutput(this.#settings, out, browser),
      noOutputReason: noPlaybackReason(this.#settings, out, browser),
      accompanimentAllowed: accompanimentAllowed(this.#settings, out, browser),
      hasTempo: hasTempo(this.#tempo),
    })
  }

  #isPlaying(): boolean {
    if (this.#listen) return this.#listen.playing
    const phase = this.#engine.state.phase
    if (this.#engine.mode === 'scored') return ACTIVE.includes(phase)
    return phase === 'running' || this.#leadInTail()
  }

  #activity(): Activity {
    if (this.#listen) return 'listening'
    if (this.#engine.mode === 'scored') return 'scored'
    return this.#readingStarted ? 'reading' : 'idle'
  }

  #interruption(): Interruption | null {
    const s = this.#engine.state
    if (s.phase !== 'interrupted' || this.#listen) return null
    const reason = s.interruptReason ?? 'pause'
    // No "Paused" banner: the main button reads Resume / Start (user, 2026-10-31).
    if (reason === 'mode-change' || reason === 'user-stop' || reason === 'pause') return null
    return { reason, text: INTERRUPT_TEXT[reason], canResume: this.#engine.mode === 'reading' }
  }

  #computeUi(): SessionUi {
    const s = this.#engine.state
    const plan = this.#plan()
    let waiting: string | null = null
    if (s.phase === 'preparing') {
      if (s.readyBlockers.includes('keys-held')) {
        waiting = 'Release the keys to begin.'
      } else if (s.readyBlockers.includes('not-prepared')) {
        waiting = this.#strip ? 'Getting ready…' : 'Preparing the score…'
      }
    }
    const leadIn = this.#leadIn !== null && !this.#leadIn.handedOver && this.#engine.mode === 'reading'
    return {
      activity: this.#activity(),
      phase: s.phase,
      playing: this.#isPlaying(),
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
      leadIn,
      repeatTarget: this.#repeatTarget,
      lastResult: this.#lastResult,
      corrections: this.#corrections.length,
      interruption: this.#interruption(),
      soundStatus: this.#soundStatus,
      inputDisconnected: this.#inputDisconnected,
      // A lead-in that read to its end is not the end of the piece: it wraps into the attempt.
      finished: this.#engine.mode === 'reading' && s.phase === 'completed' && !leadIn,
    }
  }

  #publishUi(): void {
    if (this.#disposed) return
    this.ui.set(this.#computeUi())
  }

  #cursorPosition(): number {
    if (this.#listen) return this.#listen.transport.positionNow()
    if (this.#accomp) return this.#accomp.positionNow()
    const s = this.#engine.state
    if (s.position) return toNumber(s.position)
    return toNumber(s.phase === 'completed' ? this.#timeline.end : this.#timeline.start)
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
  #updateGuide(quiet: boolean): void {
    const s = this.#engine.state
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
    this.#bothTimeline ??= selectionTimeline(this.#model, this.#tempo, {
      ...this.#sel,
      hands: 'both',
      range: this.#leadIn ? this.#leadIn.span : this.#sel.range,
    })
    const groups = this.#bothTimeline.groups
    // Numeric search: the Listen transport reports float positions.
    const at =
      (this.#listen
        ? this.#listen.transport.positionNow()
        : toNumber(this.#engine.state.position ?? this.#timeline.end)) - 1e-9
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
    const hands = this.#sel.hands
    strip.setSubduedHand(hands === 'right' ? 'L' : hands === 'left' ? 'R' : null)
    const auto: number[] = []
    if (hands === 'right' || hands === 'left') {
      for (const a of this.#timeline.automatic) auto.push(...a.notes)
      for (const a of this.#leadIn?.timeline.automatic ?? []) auto.push(...a.notes)
    }
    strip.setAutomatic(auto)
    this.#lastVersion = -1
  }

  /** Loop handles, drag inspection and the cursor's repeat button by state. */
  #syncLock(): void {
    const strip = this.#strip
    if (!strip) return
    // A lead-in that read to its end still plays on to the wrap: as running.
    const running = this.#engine.state.phase === 'running' || this.#leadInTail()
    // Loop handles only in Repeat mode (U10), never while an attempt (or a lead-in into it) runs
    // or Listen plays.
    const editable = this.#repeat && !running && !this.#listen
    const browse = !running && !(this.#listen?.playing ?? false)
    // The repeat button on the cursor (U14) opens Repeat at the cursor's bar: never in Repeat
    // mode, and while playing only with the chrome revealed (it goes with focus mode). The
    // playhead can be dragged only while paused outside Repeat mode (U23): there every pass
    // starts at the loop start.
    const playing = this.#isPlaying()
    const cursorAction = !this.#repeat && (!playing || this.#chromeRevealed)
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
    const s = this.#engine.state
    if (!s.position || s.groupIndex === null) return
    const g = this.#engine.timeline.groups[s.groupIndex]
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

/** Stored settings are not clamped (normalizeSettings falls back per field only): keep 0..1. */
function level(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
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
