/**
 * Play-through follower (DECISIONS P12): a pure, synchronous follower for performing a piece
 * without being blocked by mistakes. It follows the learner's onset groups over a `Timeline`
 * and tells the session when to release each transport gate: when the group was played, when
 * the learner moved on to one of the next groups, or when the patience after the transport's
 * arrival ran out. Nothing is graded or recorded.
 *
 * Like `PracticeEngine`, it never reads clocks, timers or MIDI: the session passes human MIDI
 * events and `now`, and reads a lazily rebuilt snapshot (`state`) and drained events.
 */
import { CC_ALL_NOTES_OFF, type MidiInputEvent } from '../midi/types'
import type { Rational } from '../music/rational'
import { PhysicalState } from './physical'
import { type OnsetGroup, type Timeline, groupAtOrAfter } from './timeline'

/** A press matching one of the next this-many groups (and not the current one) moves on. */
export const LOOKAHEAD_GROUPS = 2
/** A press matching the previous this-many groups (and not the current one) is silent; checked before the lookahead. */
export const LOOKBEHIND_GROUPS = 1
export const PATIENCE_MIN_MS = 300
export const PATIENCE_MAX_MS = 2000
/** Patience of the last group (no next onset to measure against). */
export const PATIENCE_LAST_MS = 1000
export const FOLLOW_WRONG_FEEDBACK_MS = 300

/**
 * Patience of group `group` of `timeline` in real ms: the time at the timeline's speed from its
 * onset to the next group's onset, clamped to [PATIENCE_MIN_MS, PATIENCE_MAX_MS];
 * PATIENCE_LAST_MS for the last group (and without tempo).
 */
export function patienceMs(timeline: Timeline, group: number): number {
  const g = timeline.groups[group]
  const next = timeline.groups[group + 1]
  if (!g || !next || g.onsetSec === null || next.onsetSec === null) return PATIENCE_LAST_MS
  const ms = (next.onsetSec - g.onsetSec) * 1000
  return Math.min(PATIENCE_MAX_MS, Math.max(PATIENCE_MIN_MS, ms))
}

export interface FollowerConfig {
  /** Red/amber feedback duration per wrong press (default FOLLOW_WRONG_FEEDBACK_MS). */
  readonly wrongFeedbackMs?: number
  /** Group to start at (default 0). */
  readonly startGroup?: number
}

export interface FollowerState {
  readonly version: number
  /** Current group; null once the last group was released (finished) or the timeline is empty. */
  readonly groupIndex: number | null
  readonly position: Rational | null
  /** Required performed notes of the current group (cursor targets). */
  readonly targetNotes: readonly number[]
  readonly acceptedPitches: readonly number[]
  /** Performed notes of the accepted pitches (strip accepted marks). */
  readonly acceptedNotes: readonly number[]
  readonly missingPitches: readonly number[]
  readonly inputComplete: boolean
  /** The transport has arrived at the current group's gate (holding or passed). */
  readonly arrived: boolean
  readonly heldKeys: readonly number[]
  /** Held keys whose press was judged wrong (keyboard guide marks them while held). */
  readonly heldWrongKeys: readonly number[]
  /** Show the gentle wrong tint while `now < wrongFeedbackUntil`. */
  readonly wrongFeedbackUntil: number
  /** A wrong press happened at the current group and it is not complete (cursor tint). */
  readonly groupHasError: boolean
  readonly paused: boolean
  readonly finished: boolean
}

export type FollowerEvent =
  | {
      readonly type: 'accepted'
      readonly group: number
      readonly pitch: number
      readonly notes: readonly number[]
      readonly time: number
    }
  | {
      readonly type: 'wrong'
      readonly group: number
      readonly pitch: number
      readonly time: number
      readonly feedbackUntil: number
    }
  /** Release transport gate `group` (in order; several per drain when the learner skipped ahead). */
  | { readonly type: 'release'; readonly group: number; readonly reason: 'complete' | 'skipped' | 'patience' }
  | { readonly type: 'advanced'; readonly from: number; readonly to: number | null }
  | { readonly type: 'key'; readonly note: number; readonly down: boolean; readonly wrong: boolean }
  | { readonly type: 'finished' }

export class PlayFollower {
  #timeline: Timeline
  readonly #wrongMs: number
  readonly #physical = new PhysicalState(64)
  readonly #heldWrong = new Set<number>()
  readonly #accepted = new Set<number>()
  #group: number | null = null
  /** Real time the transport arrived at the current gate (shifted past pauses). */
  #arrivedAt: number | null = null
  /** Real time of the first fresh press since the group became current (shifted past pauses). */
  #firstPressAt: number | null = null
  #pausedAt: number | null = null
  #wrongUntil = 0
  #groupHasError = false
  #lastSeq = -Infinity
  #events: FollowerEvent[] = []
  #version = 0
  #snapshot: FollowerState | null = null

  constructor(timeline: Timeline, config: FollowerConfig, now: number) {
    void now
    this.#timeline = timeline
    this.#wrongMs = config.wrongFeedbackMs ?? FOLLOW_WRONG_FEEDBACK_MS
    this.#setGroup(config.startGroup ?? 0)
  }

  get timeline(): Timeline {
    return this.#timeline
  }

  // ── Input ────────────────────────────────────────────────────────────────────────────

  /**
   * One human MIDI event, consumed once by `seq`. Positive Note On is the only attack; Note Off
   * and zero-velocity Note On release keys; CC 123 releases the channel's keys; everything else
   * is ignored. While paused or finished only held keys change.
   */
  input(ev: MidiInputEvent): void {
    if (ev.seq <= this.#lastSeq) return
    this.#lastSeq = ev.seq
    if (ev.kind === 'noteon' && ev.velocity > 0) this.#press(ev.note, ev.channel, ev.time)
    else if (ev.kind === 'cc') {
      if (ev.controller !== CC_ALL_NOTES_OFF) return
      for (const note of this.#physical.releaseChannel(ev.channel)) this.#keyUp(note)
    } else {
      if (!this.#physical.isHeld(ev.note)) return
      this.#physical.keyUp(ev.note)
      this.#keyUp(ev.note)
    }
    this.#touch()
  }

  #keyUp(note: number): void {
    this.#emit({ type: 'key', note, down: false, wrong: this.#heldWrong.has(note) })
    this.#heldWrong.delete(note)
  }

  #press(note: number, channel: number, time: number): void {
    this.#physical.keyDown(note, channel)
    this.#heldWrong.delete(note)
    const wrong = this.#pausedAt === null && this.#group !== null && this.#attack(note, time)
    this.#emit({ type: 'key', note, down: true, wrong })
  }

  /** Judges a fresh attack at the current group. Returns true when it was wrong. */
  #attack(pitch: number, time: number): boolean {
    const i = this.#group!
    const groups = this.#timeline.groups
    const g = groups[i]!
    if (this.#firstPressAt === null) this.#firstPressAt = time
    if (g.pitches.includes(pitch)) {
      if (!this.#accepted.has(pitch)) this.#accept(g, pitch, time)
      return false
    }
    if (g.tiedPitches.includes(pitch)) return false
    for (let j = Math.max(0, i - LOOKBEHIND_GROUPS); j < i; j++) if (groups[j]!.pitches.includes(pitch)) return false
    for (let j = i + 1; j <= i + LOOKAHEAD_GROUPS && j < groups.length; j++) {
      if (!groups[j]!.pitches.includes(pitch)) continue
      for (let k = i; k < j; k++) this.#emit({ type: 'release', group: k, reason: 'skipped' })
      this.#emit({ type: 'advanced', from: i, to: j })
      this.#setGroup(j)
      this.#firstPressAt = time
      this.#accept(groups[j]!, pitch, time)
      return false
    }
    this.#wrongUntil = Math.max(this.#wrongUntil, time + this.#wrongMs)
    this.#groupHasError = true
    this.#heldWrong.add(pitch)
    this.#emit({ type: 'wrong', group: i, pitch, time, feedbackUntil: this.#wrongUntil })
    return true
  }

  #accept(g: OnsetGroup, pitch: number, time: number): void {
    this.#accepted.add(pitch)
    const notes = g.notesByPitch[g.pitches.indexOf(pitch)] ?? []
    this.#emit({ type: 'accepted', group: g.index, pitch, notes, time })
    if (this.#accepted.size >= g.pitches.length) this.#release('complete')
  }

  /** Releases the current group and makes the next one current (or finishes). */
  #release(reason: 'complete' | 'patience'): void {
    const i = this.#group!
    this.#emit({ type: 'release', group: i, reason })
    const to = i + 1 < this.#timeline.groups.length ? i + 1 : null
    this.#emit({ type: 'advanced', from: i, to })
    this.#setGroup(i + 1)
    if (to === null) this.#emit({ type: 'finished' })
  }

  // ── Time and transport ───────────────────────────────────────────────────────────────

  /** Releases the current group when its patience deadline has passed. */
  tick(now: number): void {
    const deadline = this.nextDeadline()
    if (deadline === null || now < deadline) return
    this.#release('patience')
    this.#touch()
  }

  /**
   * Real time of the patience release: `max(arrival, first press since current) + patienceMs`,
   * only when both happened; null when paused, finished or either is missing.
   */
  nextDeadline(): number | null {
    if (this.#group === null || this.#pausedAt !== null) return null
    if (this.#arrivedAt === null || this.#firstPressAt === null) return null
    return Math.max(this.#arrivedAt, this.#firstPressAt) + patienceMs(this.#timeline, this.#group)
  }

  /**
   * The transport reached gate `group`. The current group: marks arrival (first arrival kept).
   * An earlier group: ignored. A later group: it becomes current (accepted cleared, `advanced`
   * emitted, nothing released) and is marked arrived.
   */
  transportArrived(group: number, now: number): void {
    const i = this.#group
    if (i === null || group < i || group >= this.#timeline.groups.length) return
    if (group > i) {
      this.#emit({ type: 'advanced', from: i, to: group })
      this.#setGroup(group)
    }
    if (this.#arrivedAt === null) this.#arrivedAt = now
    this.#touch()
  }

  /** Freezes the patience clock (and judging: presses only update held keys). */
  pause(now: number): void {
    if (this.#pausedAt !== null) return
    this.#pausedAt = now
    this.#touch()
  }

  /**
   * Unfreezes: anchors set before the pause shift by the paused duration, anchors set during
   * the pause start at `now`, so paused time never counts toward patience.
   */
  resume(now: number): void {
    const at = this.#pausedAt
    if (at === null) return
    const shift = (t: number | null): number | null => (t === null ? null : t <= at ? t + (now - at) : now)
    this.#arrivedAt = shift(this.#arrivedAt)
    this.#firstPressAt = shift(this.#firstPressAt)
    this.#pausedAt = null
    this.#touch()
  }

  /** New current group (accepted set, arrival and first press cleared; held keys and pause kept). */
  seek(group: number, now: number): void {
    void now
    this.#setGroup(group)
    this.#touch()
  }

  /**
   * New timeline (speed or hands change). Default group: the first at or after the old
   * position. When the position is unchanged, the arrival, first press and still-required
   * accepted pitches are kept (a speed change keeps the group as it was).
   */
  reconfigure(timeline: Timeline, now: number, startGroup?: number): void {
    void now
    const old = this.#group === null ? null : this.#timeline.groups[this.#group]!
    this.#timeline = timeline
    const target = startGroup ?? (old ? groupAtOrAfter(timeline, old.position) : timeline.groups.length)
    const next = timeline.groups[target]
    if (old && next && next.position.n === old.position.n && next.position.d === old.position.d) {
      const keep = { arrivedAt: this.#arrivedAt, firstPressAt: this.#firstPressAt, error: this.#groupHasError }
      const accepted = [...this.#accepted].filter((p) => next.pitches.includes(p))
      this.#setGroup(target)
      this.#arrivedAt = keep.arrivedAt
      this.#firstPressAt = keep.firstPressAt
      this.#groupHasError = keep.error
      for (const p of accepted) this.#accepted.add(p)
    } else {
      this.#setGroup(target)
    }
    this.#touch()
  }

  /** Forget held keys (disconnect: releases sent while absent are lost). */
  resetPhysical(now: number): void {
    void now
    this.#physical.reset()
    this.#heldWrong.clear()
    this.#touch()
  }

  drainEvents(): FollowerEvent[] {
    const out = this.#events
    this.#events = []
    return out
  }

  get state(): FollowerState {
    if (this.#snapshot && this.#snapshot.version === this.#version) return this.#snapshot
    const g = this.#group === null ? null : this.#timeline.groups[this.#group]!
    const accepted: number[] = []
    const acceptedNotes: number[] = []
    const missing: number[] = []
    g?.pitches.forEach((p, k) => {
      if (this.#accepted.has(p)) {
        accepted.push(p)
        acceptedNotes.push(...(g.notesByPitch[k] ?? []))
      } else {
        missing.push(p)
      }
    })
    this.#snapshot = {
      version: this.#version,
      groupIndex: this.#group,
      position: g?.position ?? null,
      targetNotes: g?.notes ?? [],
      acceptedPitches: accepted,
      acceptedNotes,
      missingPitches: missing,
      inputComplete: g !== null && missing.length === 0,
      arrived: this.#arrivedAt !== null,
      heldKeys: this.#physical.heldKeys(),
      heldWrongKeys: [...this.#heldWrong].sort((a, b) => a - b),
      wrongFeedbackUntil: this.#wrongUntil,
      groupHasError: this.#groupHasError && missing.length > 0,
      paused: this.#pausedAt !== null,
      finished: this.#group === null,
    }
    return this.#snapshot
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────

  /** Makes `group` current with a fresh accepted set (null past the end: finished). */
  #setGroup(group: number): void {
    const n = this.#timeline.groups.length
    this.#group = group >= 0 && group < n ? group : group >= n ? null : n > 0 ? 0 : null
    this.#accepted.clear()
    this.#arrivedAt = null
    this.#firstPressAt = null
    this.#groupHasError = false
  }

  #touch(): void {
    this.#version++
  }

  #emit(e: FollowerEvent): void {
    this.#events.push(e)
  }
}
