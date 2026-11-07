/**
 * Public engine types: configuration, readonly state snapshot and the change events the
 * session drains to update only what changed.
 */
import type { MidiInputEvent } from '../midi/types'
import type { Rational } from '../music/rational'
import type {
  AbandonEvent,
  AssistanceLevel,
  AttemptRecord,
  InterruptReason,
  LabelSettingsSnapshot,
  MeasureTraversal,
  RhythmParams,
  TransportKind,
} from '../model/practice'
import type { HintSettings } from '../model/settings'
import type { HintSource } from './hints'
import type { Timeline } from './timeline'

/** 'reading' = ordinary unscored reading; 'scored' = a passage attempt (DECISIONS P1). */
export type PracticeMode = 'reading' | 'scored'
/**
 * 'free' = immediate advancement on input completion; 'accompaniment' = also wait for the
 * transport; 'strict' = rhythm mode (scored only): the transport never waits and every group is
 * judged against its scheduled time (see README "Strict transport").
 */
export type { TransportKind } from '../model/practice'
/** @deprecated Use `TransportKind` (the contract's name); kept as an alias. */
export type TransportMode = TransportKind

/**
 * - preparing: scored attempt created; waiting for `markPrepared`, released keys and label fades.
 * - ready: accepts the first fresh press (which starts the clock); hints and pedals do not.
 *   Strict transport: presses only update key state; `startRunning` starts the clock.
 * - running: grading input (ordinary reading is running while not paused).
 * - paused: ordinary reading paused (progress kept, hint timers and fades frozen).
 * - completed: the final group was completed (record emitted).
 * - interrupted: stopped by an interruption; `restart` (scored) or `resume` (reading) continues.
 */
export type Phase = 'preparing' | 'ready' | 'running' | 'paused' | 'completed' | 'interrupted'

/** `'pedals-held'` is kept for compatibility but never emitted: a held pedal does not block Ready. */
export type ReadyBlocker = 'not-prepared' | 'keys-held' | 'pedals-held' | 'label-fade'

/**
 * Once-per-press hint-pedal detection, structurally compatible with core/midi's
 * `HintPedalTrigger`. Matching controller messages are consumed by it and never tracked as
 * sustain/sostenuto, so they cannot block Ready.
 */
export interface HintPedalDetector {
  matches(ev: MidiInputEvent): boolean
  /** Returns true exactly when this event is a new press. */
  feed(ev: MidiInputEvent): boolean
}

/**
 * Milliseconds until the transport reaches group `group`'s gate, as seen at time `atTime`
 * (performance.now() timebase): 0 when it has arrived, is holding there or has passed it;
 * null when unknown (e.g. blocked behind an unreleased earlier gate). Must be side-effect free.
 */
export type TransportEta = (group: number, atTime: number) => number | null

/**
 * Why a press was graded wrong: 'pitch' = not a required pitch here; 'ahead' = a next-group
 * pitch played before the current group completed (beyond the grace window); 'early' = a
 * correct pitch played too long before its gate (accompaniment: the grace; strict: the rhythm
 * tolerance); 'tie-end' = a re-attack of a pitch tied into the current group (it should sound
 * through); 'late' = strict only, a pitch of the group that just closed as missed, pressed within
 * the tolerance of its close (a late slip). A 'tie-end' press is reported only as
 * `GroupOutcome.tieEndPresses` and a 'late' press is not recorded at all: neither is a wrong
 * attack (no totals, red wash, wrong-key marking, hint count or ottava warning; DECISIONS E16),
 * so give them gentle feedback only.
 */
export type WrongReason = 'pitch' | 'ahead' | 'early' | 'tie-end' | 'late'

/** The hint settings the engine uses (the damage flash is the session's business, S5). */
export type EngineHintSettings = Pick<HintSettings, 'autoThreshold' | 'lifetime' | 'fadeMs'>

export interface EngineConfig {
  readonly mode: PracticeMode
  readonly pieceId: string
  /**
   * Default: 'free' for both hands, 'accompaniment' for one hand. 'strict' (rhythm mode) is
   * scored only and needs `rhythm` (RangeError otherwise).
   */
  readonly transport?: TransportKind
  /** Strict transport: the on-time tolerance. Required with `transport: 'strict'`. */
  readonly rhythm?: RhythmParams
  /** Default: `DEFAULT_SETTINGS.hints` (threshold 1, lifetime 30 s, fade 300 ms). */
  readonly hints?: EngineHintSettings
  /** Label mode and rules recorded with assistance. Default: mode off. */
  readonly labelSettings?: LabelSettingsSnapshot
  readonly hintPedal?: HintPedalDetector | null
  /** What a hint-pedal press does (spec default: note names). */
  readonly hintPedalAction?: 'names' | 'keys'
  /** Red wash duration per wrong attack; repeats extend it (default 300 ms). */
  readonly wrongFeedbackMs?: number
  /** Sustain/sostenuto value at or above which the pedal counts as down (default 64). */
  readonly pedalDownThreshold?: number
  /** Optional total completion-time tolerance (fraction of expected time) for `passed`. */
  readonly passTimeTolerance?: number | null
  /** Epoch ms of performance.now() = 0 (`performance.timeOrigin`) for record timestamps. Default 0. */
  readonly timeOrigin?: number
  /** Reading mode: group to resume from (default 0). */
  readonly startGroup?: number
  /** Reading mode: start paused (default false: running). */
  readonly startPaused?: boolean
  /** Scored mode: preparation is already complete (same as calling `markPrepared` at once). */
  readonly prepared?: boolean
  /** Attempt id factory (default: `${pieceId}-${createdAt}-${n}`). */
  readonly newId?: (n: number, createdAt: number) => string
  /** Early-press grace in real milliseconds (default `EARLY_PRESS_GRACE_MS` = 120; not tempo-scaled). */
  readonly earlyGraceMs?: number
  /**
   * Accompaniment and strict: gate ETA from the transport. Accompaniment without it: current-group
   * presses are never "too early". Strict without it: a press before its gate's arrival is "too
   * early" (the scheduled time is unknown).
   */
  readonly transportEta?: TransportEta | null
}

/** Options of a new scored attempt (`restart`, `reconfigure`). */
export interface AttemptStartOptions {
  /**
   * The transport is already running into this attempt's first gate (a lead-in handing over to
   * the loop): the first group's lateness is measured like any other group's. Default false:
   * the transport waits at the first gate for the first press, so the first group is never late.
   */
  readonly runningStart?: boolean
}

export interface EngineReconfigure extends AttemptStartOptions {
  /** Why the current attempt/traversal ends ('hand-change', 'tempo-change', 'range-change', 'mode-change', …). */
  readonly reason: InterruptReason
  /** New timeline (hands, range, tempo or multiplier changed). */
  readonly timeline?: Timeline
  readonly mode?: PracticeMode
  /**
   * Default: kept, or derived from the new timeline's hands when the timeline changes. A kept
   * 'strict' falls back to the default when the new mode is 'reading'; an explicit 'strict' with
   * 'reading' throws. 'strict' needs rhythm parameters (here, in the config or a settings patch).
   */
  readonly transport?: TransportKind
  /** Strict transport: new rhythm parameters (a different tolerance is a different context). */
  readonly rhythm?: RhythmParams
  /** Reading mode: where the new traversal starts (default: the group at or after the old position). */
  readonly startGroup?: number
  /**
   * Scored mode: the transport is already running into this attempt's first gate (a lead-in's
   * hand-over), so the first group's lateness is measured. Default false.
   */
  readonly runningStart?: boolean
}

export interface EngineSettingsPatch {
  readonly hints?: EngineHintSettings
  /** A changed label mode/rule interrupts an active scored attempt ('setting-change'). */
  readonly labelSettings?: LabelSettingsSnapshot
  readonly hintPedal?: HintPedalDetector | null
  readonly hintPedalAction?: 'names' | 'keys'
  readonly passTimeTolerance?: number | null
  readonly wrongFeedbackMs?: number
  readonly transportEta?: TransportEta | null
  /**
   * Strict transport parameters. A different tolerance during an active strict scored attempt
   * interrupts it ('setting-change'): it is a different comparison context.
   */
  readonly rhythm?: RhythmParams
}

export interface HintView {
  readonly group: number
  readonly notes: readonly number[]
  readonly source: HintSource
  readonly untilCorrect: boolean
  /** Real time (performance.now() timebase) of expiry; null for "Until correct" or while paused. */
  readonly expiresAt: number | null
}

/** Readonly snapshot; the same object is returned until something changes (`version`). */
export interface EngineState {
  readonly version: number
  readonly mode: PracticeMode
  readonly transport: TransportKind
  readonly phase: Phase
  /** Why a preparing scored attempt is not Ready yet. */
  readonly readyBlockers: readonly ReadyBlocker[]
  /** Current required group; null when finished or the timeline is empty. */
  readonly groupIndex: number | null
  /** Performance position of the current group (resume position). */
  readonly position: Rational | null
  /** Required performed notes of the current group (cursor targets). */
  readonly targetNotes: readonly number[]
  /** Pitches of the current group already attacked correctly (shown completed after release). */
  readonly acceptedPitches: readonly number[]
  readonly acceptedNotes: readonly number[]
  readonly missingPitches: readonly number[]
  readonly inputComplete: boolean
  /** Accompaniment: input complete, waiting for the transport to reach the position. */
  readonly waitingForTransport: boolean
  /** Highest transport gate reached (−1 before the first). */
  readonly transportGate: number
  /** Physically depressed keys (separate from accepted attacks and sustained sound). */
  readonly heldKeys: readonly number[]
  /** Held keys that were graded wrong (keyboard guide may mark them while held). */
  readonly heldWrongKeys: readonly number[]
  readonly sustain: number
  readonly sostenuto: number
  readonly sustainDown: boolean
  readonly sostenutoDown: boolean
  /** Show the red wash while `now < wrongFeedbackUntil`; repeats extend it monotonically. */
  readonly wrongFeedbackUntil: number
  /** Local error marker at the current group; cleared on correct completion. */
  readonly groupHasError: boolean
  /** Wrong attacks at the current group. */
  readonly groupWrongAttacks: number
  /** Reason of the latest wrong attack in this attempt ("Too early" vs "Wrong key"); null before any. */
  readonly lastWrongReason: WrongReason | null
  /** Next-group presses awaiting judgment (≤ grace window), by pitch. */
  readonly pendingPitches: readonly number[]
  /** Ottava span indices emphasized after a wrong attack, until the group completes. */
  readonly ottavaWarning: readonly number[]
  readonly hint: HintView | null
  readonly keyboardVisible: boolean
  /** Assistance recorded so far in this attempt/traversal. */
  readonly assistance: AssistanceLevel
  readonly wrongAttacks: number
  /** Strict transport: groups closed by the clock before they were complete, this attempt. */
  readonly missedGroups: number
  /** Strict transport: offset (ms, negative = early) of the most recently completed group; null before any. */
  readonly lastOffsetMs: number | null
  /** MIDI time the attempt clock started; null before the first fresh press. */
  readonly clockStartedAt: number | null
  readonly attemptId: string
  readonly interruptReason: InterruptReason | null
}

export type EngineEvent =
  | { readonly type: 'phase'; readonly phase: Phase }
  | { readonly type: 'clock-started'; readonly time: number }
  | { readonly type: 'key'; readonly note: number; readonly down: boolean; readonly wrong: boolean }
  /** A sound-retaining pedal crossed the down threshold. */
  | { readonly type: 'pedal'; readonly controller: number; readonly down: boolean }
  | {
      readonly type: 'accepted'
      readonly group: number
      readonly pitch: number
      readonly notes: readonly number[]
      readonly time: number
    }
  /** Reattack of an already accepted pitch: no progress, no error. */
  | { readonly type: 'replay'; readonly group: number; readonly pitch: number; readonly time: number }
  /** One wrong physical key press (original press time); `feedbackUntil` is the extended red-wash end. */
  | {
      readonly type: 'wrong'
      readonly group: number
      readonly pitch: number
      readonly time: number
      readonly feedbackUntil: number
      readonly reason: WrongReason
    }
  | { readonly type: 'ottava-warning'; readonly group: number; readonly spans: readonly number[] }
  | { readonly type: 'ottava-cleared' }
  /** Every required pitch was attacked: release transport gate `group` (exactly once per group). */
  | { readonly type: 'input-complete'; readonly group: number; readonly time: number }
  | { readonly type: 'waiting-for-transport'; readonly group: number }
  /**
   * Strict transport: group `group` closed incomplete at `time` (its scheduled time plus the
   * tolerance, or the arrival of a later gate); its missing notes are no longer required.
   */
  | { readonly type: 'missed'; readonly group: number; readonly notes: readonly number[]; readonly time: number }
  | { readonly type: 'advanced'; readonly from: number; readonly to: number | null }
  | {
      readonly type: 'hint-shown'
      readonly group: number
      readonly source: HintSource
      readonly notes: readonly number[]
    }
  | { readonly type: 'hint-retired'; readonly group: number; readonly reason: 'completed' | 'dismissed' }
  | { readonly type: 'hint-expired'; readonly group: number }
  | { readonly type: 'keyboard'; readonly visible: boolean }
  /** A new attempt/traversal began: report persistent labels that are still visible. */
  | { readonly type: 'exposure-reset'; readonly attemptId: string }
  | { readonly type: 'measure'; readonly traversal: MeasureTraversal }
  | { readonly type: 'attempt-ended'; readonly record: AttemptRecord }
  /** An attempt/traversal ended before its first fresh press: nothing to record. */
  | { readonly type: 'attempt-discarded'; readonly attemptId: string; readonly reason: InterruptReason }
  | { readonly type: 'abandon'; readonly event: AbandonEvent }
