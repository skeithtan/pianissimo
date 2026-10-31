/**
 * The practice engine: a pure, synchronous state machine following the learner's onset
 * groups (spec: "Score following", "Mistake feedback and hints", "Repeating passages",
 * "Results and timing", transport rules of "Listening and hand practice").
 *
 * Inputs: human MIDI events (`input`, already filtered of app echoes), explicit `now`
 * timestamps (performance.now() timebase, the same as MIDI event times) and session calls.
 * Outputs: a readonly snapshot (`state`) and a drained event queue (`drainEvents`).
 * The engine never reads clocks or timers; per-event work is O(size of one group).
 */
import { CC_ALL_NOTES_OFF, CC_SOSTENUTO, CC_SUSTAIN, type MidiInputEvent } from '../midi/types'
import { samePassage } from '../model/passage'
import { MATCHING_RULES_VERSION } from '../model/score'
import {
  USER_ABANDON_REASONS,
  type Completion,
  type GroupOutcome,
  type InterruptReason,
  type LabelSettingsSnapshot,
} from '../model/practice'
import { DEFAULT_SETTINGS } from '../model/settings'
import { AttemptLog, buildAbandonEvent, buildAttemptRecord, comparisonContextOf } from './attempt'
import { ActiveClock, HintState, type HintSource } from './hints'
import { PhysicalState } from './physical'
import { type OnsetGroup, type Timeline, groupAtOrAfter } from './timeline'
import type {
  AttemptStartOptions,
  EngineConfig,
  EngineEvent,
  EngineHintSettings,
  EngineReconfigure,
  EngineSettingsPatch,
  EngineState,
  HintPedalDetector,
  Phase,
  PracticeMode,
  ReadyBlocker,
  TransportEta,
  TransportMode,
  WrongReason,
} from './types'

export const DEFAULT_WRONG_FEEDBACK_MS = 300
export const DEFAULT_PEDAL_DOWN_THRESHOLD = 64
/**
 * Early-press grace (user decision): a press up to this many real milliseconds before its
 * moment is not judged too early. Not scaled by the tempo multiplier. Part of the matching
 * rules (`MATCHING_RULES_VERSION`).
 */
export const EARLY_PRESS_GRACE_MS = 120
/**
 * A sustain pedal change reaching the score's state this many real milliseconds after a group
 * completed still counts as in place for it (people pedal just after the attack; E17).
 */
export const PEDAL_GRACE_MS = 150
const LABELS_OFF: LabelSettingsSnapshot = { mode: 'off', rulesJson: '{}' }

/** Matching-rules id for a grace window (the default grace keeps `MATCHING_RULES_VERSION`). */
export function matchingRulesFor(graceMs: number): string {
  return graceMs === EARLY_PRESS_GRACE_MS ? MATCHING_RULES_VERSION : `match-v2-early-grace-${graceMs}ms`
}

/** Spec default transport: free advancement for both hands, accompaniment for one hand. */
export function defaultTransport(timeline: Timeline): TransportMode {
  return timeline.hands === 'both' ? 'free' : 'accompaniment'
}

function completionFor(reason: InterruptReason): Completion {
  return USER_ABANDON_REASONS.includes(reason) ? 'abandoned' : 'interrupted'
}

function sameStructure(a: Timeline, b: Timeline): boolean {
  return a.model === b.model && a.hands === b.hands && samePassage(a.range, b.range)
}

function assertScored(timeline: Timeline): void {
  if (!timeline.scoredAllowed) {
    throw new RangeError(`Scored practice is unavailable: ${timeline.blockers.map((b) => b.message).join(' ')}`)
  }
}

/** A fresh press of a next-group pitch, awaiting judgment for at most the grace window. */
interface PendingPress {
  readonly pitch: number
  readonly time: number
  /** Group current when pressed ("ahead" errors are attributed here). */
  readonly from: number
  /** The immediate next group, whose pitch it is. */
  readonly target: number
  readonly deadline: number
  /** A pitch tied into `target` (not required anywhere): a tie-end press if `target` comes in time. */
  readonly tieEnd?: boolean
}

/** A completed group whose sustain pedal did not match the score, still within `PEDAL_GRACE_MS`. */
interface PedalWatch {
  readonly group: number
  readonly down: boolean
  readonly until: number
}

type PendingOutcome = 'keep' | 'done'

export class PracticeEngine {
  #timeline: Timeline
  #mode: PracticeMode
  #transport: TransportMode
  readonly #pieceId: string
  #hintSettings: EngineHintSettings
  #labelSettings: LabelSettingsSnapshot
  #hintPedal: HintPedalDetector | null
  #hintPedalAction: 'names' | 'keys'
  #wrongFeedbackMs: number
  #passTimeTolerance: number | null
  #transportEta: TransportEta | null
  #checkPedal: boolean
  readonly #graceMs: number
  readonly #timeOrigin: number
  readonly #newId: (n: number, createdAt: number) => string

  readonly #physical: PhysicalState
  readonly #clock = new ActiveClock()
  readonly #hints = new HintState()

  #phase: Phase = 'interrupted'
  #prepared = false
  #log: AttemptLog
  #attempts = 0
  #interruptReason: InterruptReason | null = null
  /** The transport ran into this attempt's first gate (lead-in): its first group can be late. */
  #runningStart = false
  /** Group current when the attempt clock started (its press started the clock). */
  #clockGroup: number | null = null

  #group: number | null = null
  readonly #accepted = new Set<number>()
  #inputComplete = false
  #transportGate = -1
  /** Time the latest gate (`#transportGate`) was reached. */
  #gateAt = -Infinity
  /** Arrival time per gate reached in this attempt/traversal (for per-group lateness). */
  readonly #arrivedAt = new Map<number, number>()
  /** Time of the latest group input completion (keeps completion times monotonic). */
  #lastCompleteAt = -Infinity
  /** Earliest and latest accepted attack of the current group (chord spread). */
  #firstAcceptAt = Infinity
  #lastAcceptAt = -Infinity
  #pedalWatch: PedalWatch | null = null
  #pending: PendingPress[] = []
  #groupWrong = 0
  /** Wrong attacks counting toward the automatic hint threshold (re-armed on show and expiry). */
  #sinceArm = 0
  #groupHasError = false
  #lastWrongReason: WrongReason | null = null
  #ottava: readonly number[] = []
  readonly #heldWrong = new Set<number>()
  #wrongUntil = 0
  #keyboard = false

  #lastSeq = -Infinity
  #lastNow: number
  #events: EngineEvent[] = []
  #version = 0
  #snapshot: EngineState | null = null

  constructor(timeline: Timeline, config: EngineConfig, now: number) {
    if (config.mode === 'scored') assertScored(timeline)
    this.#timeline = timeline
    this.#mode = config.mode
    this.#transport = config.transport ?? defaultTransport(timeline)
    this.#pieceId = config.pieceId
    this.#hintSettings = config.hints ?? DEFAULT_SETTINGS.hints
    this.#labelSettings = config.labelSettings ?? LABELS_OFF
    this.#hintPedal = config.hintPedal ?? null
    this.#hintPedalAction = config.hintPedalAction ?? 'names'
    this.#wrongFeedbackMs = config.wrongFeedbackMs ?? DEFAULT_WRONG_FEEDBACK_MS
    this.#passTimeTolerance = config.passTimeTolerance ?? null
    this.#transportEta = config.transportEta ?? null
    this.#checkPedal = config.checkPedal ?? true
    this.#graceMs = config.earlyGraceMs ?? EARLY_PRESS_GRACE_MS
    this.#timeOrigin = config.timeOrigin ?? 0
    const pieceId = config.pieceId
    this.#newId = config.newId ?? ((n, createdAt) => `${pieceId}-${createdAt}-${n}`)
    this.#physical = new PhysicalState(config.pedalDownThreshold ?? DEFAULT_PEDAL_DOWN_THRESHOLD)
    this.#lastNow = now
    this.#log = new AttemptLog('', 0)
    if (this.#mode === 'scored') {
      this.#begin(now, 0, 'preparing')
      if (config.prepared) this.markPrepared(now)
    } else {
      this.#begin(now, config.startGroup ?? 0, config.startPaused ? 'paused' : 'running')
    }
  }

  get timeline(): Timeline {
    return this.#timeline
  }

  get mode(): PracticeMode {
    return this.#mode
  }

  get transport(): TransportMode {
    return this.#transport
  }

  /** Matching-rules id recorded in comparison contexts. */
  get matchingRules(): string {
    return matchingRulesFor(this.#graceMs)
  }

  // ── Input ────────────────────────────────────────────────────────────────────────────

  /**
   * Process one human MIDI event, in order, exactly once (events with a `seq` at or below the
   * last processed one are ignored). Note On with positive velocity is the only attack; Note
   * Off and zero-velocity Note On are releases; controllers never attack. Pending next-group
   * presses whose grace window ended before this event are judged first.
   */
  input(ev: MidiInputEvent): void {
    if (ev.seq <= this.#lastSeq) return
    this.#lastSeq = ev.seq
    this.#now(ev.time)
    this.#expirePending(ev.time)
    if (ev.kind === 'noteon' && ev.velocity > 0) this.#press(ev.note, ev.channel, ev.time)
    else if (ev.kind === 'cc') this.#controller(ev)
    else this.#release(ev.note, ev.time)
    this.#touch()
  }

  #press(note: number, channel: number, time: number): void {
    this.#physical.keyDown(note, channel)
    let wrong = false
    if (this.#phase === 'ready') {
      this.#startClock(time)
      this.#setPhase('running', time)
    }
    if (this.#phase === 'running' && this.#group !== null) {
      if (!this.#log.started) this.#startClock(time)
      wrong = this.#attack(note, time)
    }
    this.#emit({ type: 'key', note, down: true, wrong })
  }

  #startClock(time: number): void {
    this.#log.clockStart = time
    this.#clockGroup = this.#group
    this.#emit({ type: 'clock-started', time })
  }

  #release(note: number, time: number): void {
    if (this.#physical.keyUp(note)) this.#emit({ type: 'key', note, down: false, wrong: this.#heldWrong.has(note) })
    this.#heldWrong.delete(note)
    this.#checkReady(time)
  }

  #controller(ev: Extract<MidiInputEvent, { kind: 'cc' }>): void {
    if (this.#hintPedal?.matches(ev)) {
      if (this.#hintPedal.feed(ev)) {
        if (this.#hintPedalAction === 'keys') this.setKeyboardVisible(true, ev.time)
        else this.requestHint(ev.time)
      }
      return
    }
    if (ev.controller === CC_ALL_NOTES_OFF) {
      for (const note of this.#physical.releaseChannel(ev.channel)) {
        this.#emit({ type: 'key', note, down: false, wrong: this.#heldWrong.has(note) })
        this.#heldWrong.delete(note)
      }
      this.#checkReady(ev.time)
      return
    }
    const sustainBefore = this.#physical.sustainDown
    const sostenutoBefore = this.#physical.sostenutoDown
    if (!this.#physical.pedal(ev.controller, ev.value)) return
    if (sustainBefore !== this.#physical.sustainDown) {
      this.#emit({ type: 'pedal', controller: CC_SUSTAIN, down: this.#physical.sustainDown })
      this.#pedalChanged(ev.time)
    }
    if (sostenutoBefore !== this.#physical.sostenutoDown) {
      this.#emit({ type: 'pedal', controller: CC_SOSTENUTO, down: this.#physical.sostenutoDown })
    }
    this.#checkReady(ev.time)
  }

  /**
   * Judge one fresh attack against the current group i. Returns true when it was wrong now.
   * - Pitch of i already accepted → replay (no progress, no error, never prefills i+1).
   * - Pitch of i → accepted, unless (accompaniment) its gate is more than the grace away → 'early'.
   * - Pitch of i+1 only → pending for the grace window (applied to i+1 if i advances in time).
   * - Pitch tied into i → tie-end press (E16); tied into i+1 → pending, a tie-end press of i+1
   *   if i advances in time, else 'pitch'.
   * - Otherwise → 'pitch'.
   */
  #attack(pitch: number, time: number): boolean {
    const gi = this.#group!
    const groups = this.#timeline.groups
    const g = groups[gi]!
    const k = g.pitches.indexOf(pitch)
    if (k >= 0) {
      if (this.#accepted.has(pitch)) {
        this.#emit({ type: 'replay', group: gi, pitch, time })
        return false
      }
      if (this.#tooEarly(gi, time)) {
        this.#wrong(gi, g, pitch, time, 'early')
        return true
      }
      this.#accept(gi, g, k, time)
      return false
    }
    if (groups[gi + 1]?.pitches.includes(pitch)) {
      this.#pending.push({ pitch, time, from: gi, target: gi + 1, deadline: time + this.#graceMs })
      return false
    }
    if (g.tiedPitches.includes(pitch)) {
      this.#tieEnd(gi, pitch, time)
      return false
    }
    if (groups[gi + 1]?.tiedPitches.includes(pitch)) {
      this.#pending.push({ pitch, time, from: gi, target: gi + 1, deadline: time + this.#graceMs, tieEnd: true })
      return false
    }
    this.#wrong(gi, g, pitch, time, 'pitch')
    return true
  }

  /**
   * A re-attack of a pitch tied into group `gi` (E16): counted as the group's tie-end press only.
   * Not a wrong attack: no totals, red wash, local marker, wrong-key marking, hint count or
   * ottava warning, and `lastWrongReason` is kept. The event lets the session react gently.
   */
  #tieEnd(gi: number, pitch: number, time: number): void {
    this.#log.tieEnd(gi)
    this.#emit({ type: 'wrong', group: gi, pitch, time, feedbackUntil: this.#wrongUntil, reason: 'tie-end' })
  }

  /** Accompaniment: the gate of group `gi` is not reached within the grace of `time`. */
  #tooEarly(gi: number, time: number): boolean {
    if (this.#transport === 'free' || this.#transportEta === null || this.#transportGate >= gi) return false
    const eta = this.#transportEta(gi, time)
    return eta === null || eta >= this.#graceMs
  }

  #accept(gi: number, g: OnsetGroup, k: number, time: number): void {
    const pitch = g.pitches[k]!
    this.#accepted.add(pitch)
    if (time < this.#firstAcceptAt) this.#firstAcceptAt = time
    if (time > this.#lastAcceptAt) this.#lastAcceptAt = time
    this.#emit({ type: 'accepted', group: gi, pitch, notes: g.notesByPitch[k] ?? [], time })
    if (this.#accepted.size === g.pitches.length) this.#complete(gi, g, Math.max(time, this.#lastCompleteAt))
  }

  #wrong(gi: number, g: OnsetGroup, pitch: number, time: number, reason: WrongReason): void {
    this.#groupWrong++
    this.#log.wrong(gi, g.occ, g.synthetic, reason === 'early', pitch)
    this.#wrongUntil = Math.max(this.#wrongUntil, time + this.#wrongFeedbackMs)
    this.#groupHasError = true
    this.#lastWrongReason = reason
    this.#emit({ type: 'wrong', group: gi, pitch, time, feedbackUntil: this.#wrongUntil, reason })
    // A too-early press had the right pitch: no wrong-key marking, ottava emphasis or hint count.
    if (reason === 'early') return
    if (this.#physical.isHeld(pitch)) this.#heldWrong.add(pitch)
    if (g.ottavas.length > 0 && this.#ottava !== g.ottavas) {
      this.#ottava = g.ottavas
      this.#emit({ type: 'ottava-warning', group: gi, spans: g.ottavas })
    }
    if (this.#inputComplete || this.#hints.isActive(gi)) return
    this.#sinceArm++
    const threshold = this.#hintSettings.autoThreshold
    if (threshold !== null && threshold > 0 && this.#sinceArm >= threshold)
      this.#showHint('auto', Math.max(time, this.#lastNow))
  }

  #complete(gi: number, g: OnsetGroup, time: number): void {
    this.#inputComplete = true
    this.#lastCompleteAt = time
    const spreadMs = g.pitches.length > 1 ? Math.max(0, Math.round(this.#lastAcceptAt - this.#firstAcceptAt)) : 0
    this.#log.groupComplete(gi, g.occ, time, this.#groupWrong === 0, {
      lateMs: this.#lateMs(gi, time),
      spreadMs,
      pedal: this.#pedalAt(gi, g, time),
    })
    if (gi === this.#timeline.groups.length - 1) this.#log.finalAttack = time
    this.#emit({ type: 'input-complete', group: gi, time })
    this.#groupHasError = false
    this.#clearOttava()
    this.#retireHint(time, 'completed')
    if (this.#transport === 'free' || this.#transportGate >= gi) this.#advance(time)
    else this.#emit({ type: 'waiting-for-transport', group: gi })
  }

  /**
   * How long after its gate's arrival group `gi` completed at `time` (0 when not after arrival).
   * The group whose press started the clock is never late: the transport waited at its gate for
   * that press (P9), unless it was already running into it (`runningStart`, a lead-in).
   */
  #lateMs(gi: number, time: number): number {
    if (gi === this.#clockGroup && !this.#runningStart) return 0
    if (this.#transport === 'free' || this.#transportGate < gi) return 0
    const at = this.#arrivedAt.get(gi)
    return at === undefined ? 0 : Math.max(0, Math.round(time - at))
  }

  /**
   * The sustain pedal at a group's completion against the score (E17): 'none' without sustain
   * marks or with checking off. A mismatch is watched for `PEDAL_GRACE_MS`: a change to the
   * score's state in that time revises it to 'ok' (`#pedalChanged`).
   */
  #pedalAt(gi: number, g: OnsetGroup, time: number): NonNullable<GroupOutcome['pedal']> {
    this.#pedalWatch = null
    if (!this.#checkPedal || g.pedalDown === null) return 'none'
    if (this.#physical.sustainDown === g.pedalDown) return 'ok'
    this.#pedalWatch = { group: gi, down: g.pedalDown, until: time + PEDAL_GRACE_MS }
    return g.pedalDown ? 'missing' : 'extra'
  }

  /** The sustain pedal crossed its threshold at `time`. */
  #pedalChanged(time: number): void {
    const w = this.#pedalWatch
    if (w === null) return
    if (time <= w.until && this.#physical.sustainDown === w.down) this.#log.pedal(w.group, 'ok')
    else if (time <= w.until) return
    this.#pedalWatch = null
  }

  #advance(now: number): void {
    const from = this.#group!
    const groups = this.#timeline.groups
    const occ = groups[from]!.occ
    const to = from + 1 < groups.length ? from + 1 : null
    if (to === null || groups[to]!.occ !== occ) this.#closeMeasure(occ)
    this.#emit({ type: 'advanced', from, to })
    this.#enterGroup(to, now)
    if (to === null) {
      this.#pending = []
      this.#setPhase('completed', now)
      this.#end('completed', null, now)
      return
    }
    this.#settlePending(Math.max(now, this.#lastNow), false)
  }

  // ── Early-press grace ────────────────────────────────────────────────────────────────

  /** Judge pending presses whose grace window has ended by `now`. */
  #expirePending(now: number): boolean {
    if (this.#pending.length === 0 || !this.#pending.some((p) => now >= p.deadline)) return false
    this.#settlePending(now, true)
    return true
  }

  /**
   * Re-examine pending presses in press order. With `expiring`, presses past their deadline
   * get a final verdict; others are decided as soon as the outcome is known.
   */
  #settlePending(now: number, expiring: boolean): void {
    if (this.#pending.length === 0) return
    for (const p of [...this.#pending].sort((a, b) => a.time - b.time)) {
      const i = this.#pending.indexOf(p)
      if (i < 0) continue
      // Taken out while deciding: an acceptance can complete and advance, re-entering here.
      this.#pending.splice(i, 1)
      if (this.#decidePending(p, expiring && now >= p.deadline) === 'keep') this.#pending.push(p)
    }
  }

  #decidePending(p: PendingPress, expired: boolean): PendingOutcome {
    const cur = this.#group
    if (cur === null || p.target < cur || !this.#attemptActive()) return 'done'
    const groups = this.#timeline.groups
    if (p.target > cur) {
      if (!expired) return 'keep'
      const g = groups[cur]!
      if (p.tieEnd) this.#wrong(cur, g, p.pitch, p.time, 'pitch')
      else if (g.tiedPitches.includes(p.pitch)) this.#tieEnd(cur, p.pitch, p.time)
      else this.#wrong(cur, g, p.pitch, p.time, 'ahead')
      return 'done'
    }
    // The pressed group is now current.
    if (p.tieEnd) {
      this.#tieEnd(cur, p.pitch, p.time)
      return 'done'
    }
    const g = groups[cur]!
    const k = g.pitches.indexOf(p.pitch)
    if (k < 0) return 'done'
    if (this.#accepted.has(p.pitch)) {
      this.#emit({ type: 'replay', group: cur, pitch: p.pitch, time: p.time })
      return 'done'
    }
    let verdict: 'accept' | 'early' | 'keep'
    if (this.#transport === 'free' || this.#transportEta === null) {
      verdict = 'accept'
    } else if (this.#transportGate >= cur) {
      const arrivedAt = this.#transportGate === cur ? this.#gateAt : -Infinity
      verdict = arrivedAt - p.time < this.#graceMs ? 'accept' : 'early'
    } else if (expired) {
      verdict = 'early'
    } else {
      const eta = this.#transportEta(cur, p.time)
      verdict = eta === null ? 'keep' : eta < this.#graceMs ? 'accept' : 'early'
    }
    if (verdict === 'keep') return 'keep'
    if (verdict === 'accept') this.#accept(cur, g, k, p.time)
    else this.#wrong(cur, g, p.pitch, p.time, 'early')
    return 'done'
  }

  // ── Transport seam ───────────────────────────────────────────────────────────────────

  /**
   * The transport reached gate `group` at `now` (it emitted the automatic events due there).
   * In accompaniment the engine passes a group only after both input completion and arrival;
   * gates count as reached in order. Ignored in free (both-hands) mode.
   */
  transportArrived(group: number, now: number = this.#lastNow): void {
    if (this.#transport === 'free') return
    this.#now(now)
    const expired = this.#expirePending(now)
    if (group <= this.#transportGate) {
      if (expired) this.#touch()
      return
    }
    for (let g = this.#transportGate + 1; g <= group; g++) this.#arrivedAt.set(g, now)
    this.#transportGate = group
    this.#gateAt = now
    const gi = this.#group
    if (gi !== null && this.#inputComplete && this.#transportGate >= gi && this.#attemptActive()) this.#advance(now)
    this.#settlePending(now, false)
    this.#touch()
  }

  // ── Session controls ─────────────────────────────────────────────────────────────────

  /** Scored: preparation finished (score ready, automatic tail done, output released, transport at start). */
  markPrepared(now: number): void {
    this.#now(now)
    if (this.#mode !== 'scored' || this.#phase !== 'preparing') return
    this.#prepared = true
    this.#checkReady(now)
    this.#touch()
  }

  /**
   * Manual Hint (button or hint pedal): reveals the current group's names, restarting the
   * lifetime and canceling a fade of the same labels. Never skips notes, never starts the
   * clock or cancels Ready. Returns false when there is nothing to reveal.
   */
  requestHint(now: number): boolean {
    this.#now(now)
    if (!this.#attemptActive() || this.#group === null || this.#inputComplete) return false
    this.#showHint('manual', now)
    this.#touch()
    return true
  }

  /** Explicit dismissal: the hint fades from now, attached to its notes. */
  dismissHint(now: number): void {
    this.#now(now)
    if (this.#retireHint(now, 'dismissed')) this.#touch()
  }

  /** Keyboard guide shown/hidden. Showing marks the attempt (and the bars it is shown in) keyboard-assisted. */
  setKeyboardVisible(visible: boolean, now: number): void {
    this.#now(now)
    if (visible === this.#keyboard) return
    this.#keyboard = visible
    this.#emit({ type: 'keyboard', visible })
    if (visible && this.#attemptActive()) this.#markKeyboard()
    this.#touch()
  }

  /**
   * Persistent labels currently visible (performed note indices, any order, may repeat).
   * Exposure of a learner note not yet played in this attempt/traversal marks its own group
   * and bar assisted (read-ahead included); other notes are ignored. Returns the number of
   * newly recorded notes. Distinct from hint requests.
   */
  recordPersistentLabelExposure(notes: Iterable<number>, now: number): number {
    this.#now(now)
    if (!this.#attemptActive()) return 0
    let added = 0
    const map = this.#timeline.labelToGroup
    for (const note of notes) {
      const g = map.get(note)
      if (g === undefined || this.#log.isCompleted(g)) continue
      if (this.#log.expose(note, g)) added++
    }
    if (added > 0) this.#touch()
    return added
  }

  /** Reading: pause keeps progress and freezes hint timers and fades. Scored: interrupts the attempt. */
  pause(now: number): void {
    this.#now(now)
    if (this.#mode === 'scored') {
      this.interrupt('pause', now)
      return
    }
    if (this.#phase === 'running') {
      this.#pending = []
      this.#setPhase('paused', now)
    }
    this.#touch()
  }

  /** Reading: resume a pause, or start a new traversal at the same position after an interruption. */
  resume(now: number): void {
    this.#now(now)
    if (this.#mode !== 'reading') return
    if (this.#phase === 'paused') this.#setPhase('running', now)
    else if (this.#phase === 'interrupted') this.#begin(now, this.#group ?? 0, 'running')
    this.#touch()
  }

  /**
   * End the active attempt/traversal. user-stop/user-restart are 'abandoned' (and report an
   * `AbandonEvent` after wrong notes in the current bar); every other reason is 'interrupted'
   * and never yields a completed or failed result. A disconnect also forgets physical state.
   * Pending presses are dropped without errors. Reading-mode 'pause' is an ordinary pause.
   */
  interrupt(reason: InterruptReason, now: number): void {
    this.#now(now)
    if (reason === 'pause' && this.#mode === 'reading') {
      this.pause(now)
      return
    }
    if (reason === 'disconnect') {
      this.#physical.reset()
      this.#heldWrong.clear()
    }
    if (this.#attemptActive()) {
      this.#pending = []
      this.#end(completionFor(reason), reason, now)
      this.#clearGroupState(now)
      this.#setPhase('interrupted', now)
    }
    this.#touch()
  }

  /**
   * Repeat reset / Restart passage. Scored: a new attempt enters Preparing and becomes Ready
   * once `markPrepared` was called, keys are released and label fades finished (held pedals
   * never block). Reading: a new traversal from the first group. An attempt in progress is
   * abandoned ('user-restart').
   */
  restart(now: number, options: AttemptStartOptions = {}): void {
    this.#now(now)
    this.#pending = []
    if (this.#attemptActive()) this.#end('abandoned', 'user-restart', now)
    this.#clearGroupState(now)
    if (this.#mode === 'scored') {
      this.#begin(now, 0, 'preparing', options.runningStart)
      this.#checkReady(now)
    } else {
      this.#begin(now, 0, 'running')
    }
    this.#touch()
  }

  /**
   * Move the score position. Scored: interrupts an active attempt ('seek'; the next attempt
   * restarts at the passage start). Reading: ends the traversal and starts a new one at
   * `group`, keeping running/paused. Gates before the new position count as passed.
   */
  seek(group: number, now: number): void {
    this.#now(now)
    if (this.#mode === 'scored') {
      if (this.#attemptActive()) this.interrupt('seek', now)
      return
    }
    this.#pending = []
    const phase: Phase = this.#phase === 'running' ? 'running' : 'paused'
    if (this.#attemptActive()) this.#end('interrupted', 'seek', now)
    this.#clearGroupState(now)
    this.#begin(now, group, phase)
    this.#touch()
  }

  /**
   * Hands, range, tempo, multiplier, transport or mode changed. The active attempt/traversal
   * ends with `reason`. Ordinary reading with the same groups (tempo or speed only) keeps the
   * current target and its progress and continues in a new traversal (new comparison context).
   * A scored attempt starts over in Preparing.
   */
  reconfigure(change: EngineReconfigure, now: number): void {
    this.#now(now)
    const timeline = change.timeline ?? this.#timeline
    const mode = change.mode ?? this.#mode
    const transport = change.transport ?? (change.timeline ? defaultTransport(timeline) : this.#transport)
    if (mode === 'scored') assertScored(timeline)
    this.#pending = []
    const keep =
      this.#mode === 'reading' &&
      mode === 'reading' &&
      transport === this.#transport &&
      sameStructure(this.#timeline, timeline)
    if (keep) {
      const active = this.#attemptActive()
      if (active) this.#end('interrupted', change.reason, now)
      this.#timeline = timeline
      if (active) this.#continueTraversal(now)
      this.#touch()
      return
    }
    const wasRunning = this.#phase === 'running'
    const oldPosition = this.#currentGroup()?.position ?? null
    if (this.#attemptActive()) this.#end(completionFor(change.reason), change.reason, now)
    this.#clearGroupState(now)
    this.#timeline = timeline
    this.#mode = mode
    this.#transport = transport
    if (mode === 'scored') {
      this.#begin(now, 0, 'preparing', change.runningStart)
      this.#checkReady(now)
    } else {
      const start = change.startGroup ?? (oldPosition ? groupAtOrAfter(timeline, oldPosition) : 0)
      this.#begin(now, start, wasRunning ? 'running' : 'paused')
    }
    this.#touch()
  }

  /** Settings that do not change the comparison context. A changed label mode/rule interrupts a scored attempt. */
  updateSettings(patch: EngineSettingsPatch, now: number): void {
    this.#now(now)
    const labels = patch.labelSettings
    if (labels && (labels.mode !== this.#labelSettings.mode || labels.rulesJson !== this.#labelSettings.rulesJson)) {
      if (this.#mode === 'scored' && this.#attemptActive()) this.interrupt('setting-change', now)
      this.#labelSettings = labels
    }
    if (patch.hints) this.#hintSettings = patch.hints
    if (patch.hintPedal !== undefined) this.#hintPedal = patch.hintPedal
    if (patch.hintPedalAction) this.#hintPedalAction = patch.hintPedalAction
    if (patch.passTimeTolerance !== undefined) this.#passTimeTolerance = patch.passTimeTolerance
    if (patch.wrongFeedbackMs !== undefined) this.#wrongFeedbackMs = patch.wrongFeedbackMs
    if (patch.transportEta !== undefined) this.#transportEta = patch.transportEta
    if (patch.checkPedal !== undefined) this.#checkPedal = patch.checkPedal
    this.#touch()
  }

  /** Forget physical key/pedal state (e.g. after reconnecting or changing the input port). */
  resetPhysical(now: number): void {
    this.#now(now)
    this.#physical.reset()
    this.#heldWrong.clear()
    this.#checkReady(now)
    this.#touch()
  }

  /**
   * Time-driven changes: pending presses whose grace window ended, hint expiry (re-arms the
   * automatic threshold), finished fades, Ready.
   */
  tick(now: number): void {
    this.#now(now)
    let changed = this.#expirePending(this.#lastNow)
    const t = this.#clock.active(this.#lastNow)
    const expired = this.#hints.expire(t)
    if (expired !== null) {
      this.#emit({ type: 'hint-expired', group: expired })
      if (expired === this.#group) this.#sinceArm = 0
      changed = true
    }
    if (this.#hints.prune(t)) changed = true
    const phase = this.#phase
    this.#checkReady(this.#lastNow)
    if (changed || phase !== this.#phase) this.#touch()
  }

  /**
   * Real time of the next time-driven change (pending-press deadline, hint expiry or fade
   * end); null when none. Hint deadlines are absent while an ordinary reading pause freezes them.
   */
  nextDeadline(): number | null {
    let next: number | null = null
    for (const p of this.#pending) if (next === null || p.deadline < next) next = p.deadline
    const d = this.#hints.nextDeadline()
    const hint = d === null ? null : this.#clock.toReal(d)
    if (hint !== null && (next === null || hint < next)) next = hint
    return next
  }

  /**
   * Temporary-hint label opacity per performed note (eased, in (0, 1]; absent = no temporary
   * reason to show). Cheap enough per animation frame; frozen during an ordinary pause.
   * Combine with persistent labels by taking the maximum (one label per note).
   */
  temporaryLabelOpacity(now: number): ReadonlyMap<number, number> {
    return this.#hints.opacities(this.#clock.active(Math.max(now, this.#lastNow)))
  }

  drainEvents(): EngineEvent[] {
    const out = this.#events
    this.#events = []
    return out
  }

  get state(): EngineState {
    if (this.#snapshot && this.#snapshot.version === this.#version) return this.#snapshot
    const g = this.#currentGroup()
    const accepted: number[] = []
    const acceptedNotes: number[] = []
    const missing: number[] = []
    if (g) {
      g.pitches.forEach((p, i) => {
        if (this.#accepted.has(p)) {
          accepted.push(p)
          acceptedNotes.push(...(g.notesByPitch[i] ?? []))
        } else {
          missing.push(p)
        }
      })
    }
    const h = this.#hints.hint
    this.#snapshot = {
      version: this.#version,
      mode: this.#mode,
      transport: this.#transport,
      phase: this.#phase,
      readyBlockers: this.#mode === 'scored' && this.#phase === 'preparing' ? this.#blockers(this.#lastNow) : [],
      groupIndex: this.#group,
      position: g?.position ?? null,
      targetNotes: g?.notes ?? [],
      acceptedPitches: accepted,
      acceptedNotes,
      missingPitches: missing,
      inputComplete: this.#inputComplete,
      waitingForTransport: this.#waitingForTransport(),
      transportGate: this.#transportGate,
      heldKeys: this.#physical.heldKeys(),
      heldWrongKeys: [...this.#heldWrong].sort((a, b) => a - b),
      sustain: this.#physical.sustain,
      sostenuto: this.#physical.sostenuto,
      sustainDown: this.#physical.sustainDown,
      sostenutoDown: this.#physical.sostenutoDown,
      wrongFeedbackUntil: this.#wrongUntil,
      groupHasError: this.#groupHasError,
      groupWrongAttacks: this.#groupWrong,
      lastWrongReason: this.#lastWrongReason,
      pendingPitches: this.#pending.map((p) => p.pitch),
      ottavaWarning: this.#ottava,
      hint: h
        ? {
            group: h.group,
            notes: h.notes,
            source: h.source,
            untilCorrect: h.expiresAt === null,
            expiresAt: h.expiresAt === null ? null : this.#clock.toReal(h.expiresAt),
          }
        : null,
      keyboardVisible: this.#keyboard,
      assistance: this.#log.assistanceLevel,
      wrongAttacks: this.#log.wrongAttacks,
      clockStartedAt: this.#log.clockStart,
      attemptId: this.#log.id,
      interruptReason: this.#interruptReason,
    }
    return this.#snapshot
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────

  #now(now: number): void {
    if (now > this.#lastNow) this.#lastNow = now
  }

  #touch(): void {
    this.#version++
  }

  #emit(e: EngineEvent): void {
    this.#events.push(e)
  }

  #setPhase(phase: Phase, now: number): void {
    if (this.#phase === phase) return
    // Only ordinary reading pauses; the active clock (hint lifetimes, fades) is frozen exactly then.
    if (phase === 'paused') this.#clock.pause(Math.max(now, this.#lastNow))
    else if (this.#phase === 'paused') this.#clock.resume(Math.max(now, this.#lastNow))
    this.#phase = phase
    this.#emit({ type: 'phase', phase })
  }

  /** An attempt or traversal is in progress (its log can still change). */
  #attemptActive(): boolean {
    const p = this.#phase
    return p === 'preparing' || p === 'ready' || p === 'running' || p === 'paused'
  }

  #currentGroup(): OnsetGroup | null {
    return this.#group === null ? null : (this.#timeline.groups[this.#group] ?? null)
  }

  #waitingForTransport(): boolean {
    return (
      this.#transport === 'accompaniment' &&
      this.#inputComplete &&
      this.#group !== null &&
      this.#transportGate < this.#group
    )
  }

  #blockers(now: number): ReadyBlocker[] {
    const out: ReadyBlocker[] = []
    if (!this.#prepared) out.push('not-prepared')
    if (this.#physical.anyKeyHeld) out.push('keys-held')
    // A held sustain/sostenuto pedal never blocks Ready (user, 31 October 2026): 'pedals-held' is not emitted.
    if (this.#hints.fadingUntil() > this.#clock.active(now)) out.push('label-fade')
    return out
  }

  #checkReady(now: number): void {
    if (this.#mode !== 'scored' || this.#phase !== 'preparing') return
    if (this.#blockers(Math.max(now, this.#lastNow)).length === 0) this.#setPhase('ready', now)
  }

  /** Start a new attempt/traversal at `startGroup` in `phase`. */
  #begin(now: number, startGroup: number, phase: Phase, runningStart = false): void {
    this.#newLog(now)
    this.#runningStart = runningStart
    this.#prepared = false
    this.#pending = []
    this.#lastCompleteAt = -Infinity
    this.#lastWrongReason = null
    this.#setPhase(phase, now)
    const n = this.#timeline.groups.length
    const start = n === 0 ? null : Math.max(0, Math.min(Math.trunc(startGroup), n - 1))
    this.#transportGate = (start ?? 0) - 1
    this.#gateAt = -Infinity
    this.#arrivedAt.clear()
    this.#enterGroup(start, now)
  }

  #newLog(now: number): void {
    this.#attempts++
    const createdAt = this.#timeOrigin + now
    this.#log = new AttemptLog(this.#newId(this.#attempts, createdAt), createdAt)
    this.#clockGroup = null
    this.#pedalWatch = null
    this.#interruptReason = null
    this.#emit({ type: 'exposure-reset', attemptId: this.#log.id })
  }

  /** Reading: a tempo/speed change splits the traversal but keeps the target and its progress. */
  #continueTraversal(now: number): void {
    this.#newLog(now)
    if (this.#keyboard) this.#markKeyboard()
    const h = this.#hints.hint
    const g = this.#currentGroup()
    if (h && g && h.group === this.#group) this.#log.hint(h.group, g.occ, h.source)
  }

  #enterGroup(group: number | null, now: number): void {
    const h = this.#hints.hint
    if (h && h.group !== group) this.#retireHint(now, 'dismissed')
    this.#group = group
    this.#accepted.clear()
    this.#firstAcceptAt = Infinity
    this.#lastAcceptAt = -Infinity
    this.#inputComplete = false
    this.#groupWrong = 0
    this.#sinceArm = 0
    this.#groupHasError = false
    this.#clearOttava()
    if (group !== null && this.#attemptActive()) this.#log.reach(group)
    if (this.#keyboard && group !== null && this.#attemptActive()) this.#markKeyboard()
  }

  /** Clear the current group's matching and feedback state (seek, restart, interruption, hands). */
  #clearGroupState(now: number): void {
    this.#retireHint(now, 'dismissed')
    this.#pending = []
    this.#accepted.clear()
    this.#firstAcceptAt = Infinity
    this.#lastAcceptAt = -Infinity
    this.#inputComplete = false
    this.#groupWrong = 0
    this.#sinceArm = 0
    this.#groupHasError = false
    this.#clearOttava()
    this.#heldWrong.clear()
  }

  #clearOttava(): void {
    if (this.#ottava.length === 0) return
    this.#ottava = []
    this.#emit({ type: 'ottava-cleared' })
  }

  #markKeyboard(): void {
    this.#log.keyboard(this.#currentGroup()?.occ ?? null)
  }

  #showHint(source: HintSource, now: number): void {
    const gi = this.#group!
    const g = this.#timeline.groups[gi]!
    const lifetime = this.#hintSettings.lifetime
    this.#hints.show(
      gi,
      g.notes,
      source,
      this.#clock.active(Math.max(now, this.#lastNow)),
      lifetime === 'until-correct' ? null : lifetime * 1000,
      this.#hintSettings.fadeMs,
    )
    this.#sinceArm = 0
    this.#log.hint(gi, g.occ, source)
    this.#emit({ type: 'hint-shown', group: gi, source, notes: g.notes })
  }

  #retireHint(now: number, reason: 'completed' | 'dismissed'): boolean {
    const group = this.#hints.retire(this.#clock.active(Math.max(now, this.#lastNow)), this.#hintSettings.fadeMs)
    if (group === null) return false
    this.#emit({ type: 'hint-retired', group, reason })
    return true
  }

  #closeMeasure(occ: number): void {
    const m = this.#timeline.measureByOcc.get(occ)
    if (!m) return
    const t = this.#log.closeMeasure(m)
    if (t) this.#emit({ type: 'measure', traversal: t })
  }

  /** Finish the current log: close the open bar, report abandonment, emit the record. */
  #end(completion: Completion, reason: InterruptReason | null, now: number): void {
    const log = this.#log
    // The record is built now: a pedal change after the final completion cannot revise it.
    this.#pedalWatch = null
    const g = this.#currentGroup()
    const context = comparisonContextOf(this.#timeline, this.#transport, this.matchingRules)
    if (completion === 'abandoned' && reason !== null && log.started && g && log.measureWrong(g.occ) > 0) {
      this.#emit({
        type: 'abandon',
        event: buildAbandonEvent(this.#pieceId, context, g.occ, this.#timeOrigin + now, reason),
      })
    }
    if (g && completion !== 'completed') this.#closeMeasure(g.occ)
    this.#interruptReason = reason
    if (!log.started) {
      this.#emit({ type: 'attempt-discarded', attemptId: log.id, reason: reason ?? 'user-stop' })
      return
    }
    this.#emit({
      type: 'attempt-ended',
      record: buildAttemptRecord({
        log,
        kind: this.#mode,
        timeline: this.#timeline,
        transport: this.#transport,
        pieceId: this.#pieceId,
        labelSettings: this.#labelSettings,
        completion,
        reason,
        timeTolerance: this.#passTimeTolerance,
        matchingRules: this.matchingRules,
      }),
    })
  }
}
