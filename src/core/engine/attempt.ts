/**
 * Per-attempt (or per ordinary-reading traversal) accumulation of mistakes, completions,
 * timing and assistance, and the records built from it
 * (spec: "Results and timing", "Detecting recurring mistakes", label assistance paragraph).
 */
import type {
  AbandonEvent,
  AssistanceLevel,
  AssistanceRecord,
  AttemptRecord,
  ComparisonContext,
  Completion,
  GroupOutcome,
  InterruptReason,
  LabelSettingsSnapshot,
  MeasureTraversal,
  OnsetTimestamp,
} from '../model/practice'
import { contextKey, measureContextKey } from '../model/practice'
import type { Timeline, TimelineMeasure } from './timeline'

interface MeasureAcc {
  wrong: number
  wrongExcludingBoundary: number
  readonly errorGroups: Set<number>
  completed: number
  tempHint: boolean
  keyboard: boolean
}

interface GroupAcc {
  wrong: number
  early: number
  lateMs: number
  readonly wrongPitches: number[]
  spreadMs: number
  tieEnd: number
}

/** How a group's completion went besides first-pass (all default to 0). */
export interface GroupCompletion {
  /** Whole ms after the gate's arrival (0 for the attempt's first group unless a running start). */
  readonly lateMs?: number
  /** Whole ms between the group's first and last accepted attack. */
  readonly spreadMs?: number
}

export const READING_UNTIMED = 'Ordinary reading is not timed.'

export class AttemptLog {
  readonly id: string
  /** Epoch milliseconds. */
  readonly createdAt: number
  /** MIDI timestamp of the first fresh press (performance.now() timebase). */
  clockStart: number | null = null
  /** MIDI timestamp of the final group's last missing correct attack. */
  finalAttack: number | null = null
  wrongAttacks = 0
  /** Wrong attacks that were right pitches pressed too early (reason `'early'`, E12). */
  earlyAttacks = 0
  groupsFirstPass = 0
  hintRequests = 0
  autoHints = 0
  keyboardShown = false
  readonly onsets: OnsetTimestamp[] = []
  readonly measures: MeasureTraversal[] = []
  readonly exposedNotes = new Set<number>()
  readonly exposedGroups = new Set<number>()
  readonly hintGroups = new Set<number>()
  readonly #acc = new Map<number, MeasureAcc>()
  readonly #closed = new Set<number>()
  readonly #completedGroups = new Set<number>()
  /** Groups reached in this attempt/traversal, in the order reached. */
  readonly #groups = new Map<number, GroupAcc>()

  constructor(id: string, createdAt: number) {
    this.id = id
    this.createdAt = createdAt
  }

  #measure(occ: number): MeasureAcc {
    let m = this.#acc.get(occ)
    if (!m) {
      m = {
        wrong: 0,
        wrongExcludingBoundary: 0,
        errorGroups: new Set(),
        completed: 0,
        tempHint: false,
        keyboard: false,
      }
      this.#acc.set(occ, m)
    }
    return m
  }

  /** The performance began: a fresh human press arrived while Ready (or while reading). */
  get started(): boolean {
    return this.clockStart !== null
  }

  #group(group: number): GroupAcc {
    let g = this.#groups.get(group)
    if (!g) {
      g = { wrong: 0, early: 0, lateMs: 0, wrongPitches: [], spreadMs: 0, tieEnd: 0 }
      this.#groups.set(group, g)
    }
    return g
  }

  /** The group became current (it is reported in the record's per-group outcomes). */
  reach(group: number): void {
    this.#group(group)
  }

  /**
   * A wrong attack of MIDI `pitch` at the current expected group, attributed to it and to its
   * measure. Too-early ones (right pitch) are not listed in the group's wrong pitches.
   */
  wrong(group: number, occ: number, syntheticBoundary: boolean, early: boolean, pitch: number): void {
    this.wrongAttacks++
    if (early) this.earlyAttacks++
    const g = this.#group(group)
    g.wrong++
    if (early) g.early++
    else g.wrongPitches.push(pitch)
    const m = this.#measure(occ)
    m.wrong++
    if (!syntheticBoundary) m.wrongExcludingBoundary++
    m.errorGroups.add(group)
  }

  /** A press of a pitch tied into the current group: its own class, not a wrong attack (E16). */
  tieEnd(group: number): void {
    this.#group(group).tieEnd++
  }

  measureWrong(occ: number): number {
    return this.#acc.get(occ)?.wrong ?? 0
  }

  isCompleted(group: number): boolean {
    return this.#completedGroups.has(group)
  }

  /** The group's input requirement completed at MIDI time `time` (see `GroupCompletion`). */
  groupComplete(group: number, occ: number, time: number, firstPass: boolean, detail: GroupCompletion = {}): void {
    if (this.#completedGroups.has(group)) return
    this.#completedGroups.add(group)
    const g = this.#group(group)
    g.lateMs = detail.lateMs ?? 0
    g.spreadMs = detail.spreadMs ?? 0
    this.#measure(occ).completed++
    if (firstPass) this.groupsFirstPass++
    if (this.clockStart !== null) this.onsets.push({ group, t: (time - this.clockStart) / 1000 })
  }

  /** A temporary hint revealed this group's names. */
  hint(group: number, occ: number, source: 'auto' | 'manual'): void {
    if (source === 'auto') this.autoHints++
    else this.hintRequests++
    this.hintGroups.add(group)
    this.#measure(occ).tempHint = true
  }

  /** The keyboard guide was visible while a group of `occ` was current (null: no current group). */
  keyboard(occ: number | null): void {
    this.keyboardShown = true
    if (occ !== null) this.#measure(occ).keyboard = true
  }

  /** Persistent-label exposure of a learner note, attributed to its own group. Returns true when new. */
  expose(note: number, group: number): boolean {
    if (this.exposedNotes.has(note)) return false
    this.exposedNotes.add(note)
    this.exposedGroups.add(group)
    return true
  }

  /**
   * Close a visited measure's traversal. Complete only when every required group of the
   * measure was completed in this traversal (an interruption after that still leaves it
   * complete). A visit without completions, mistakes or assistance is no evidence and
   * yields null. Each measure is closed at most once per traversal.
   */
  closeMeasure(m: TimelineMeasure): MeasureTraversal | null {
    if (this.#closed.has(m.occ)) return null
    const acc = this.#acc.get(m.occ)
    const persistentLabel = m.groups.some((g) => this.exposedGroups.has(g))
    if (!acc && !persistentLabel) return null
    const completed = acc?.completed ?? 0
    // A bar a note-level loop cuts is never complete (partial, H7): only some of its notes ran.
    const complete = !m.partial && m.groups.length > 0 && completed === m.groups.length
    const evidence =
      complete ||
      completed > 0 ||
      (acc?.wrong ?? 0) > 0 ||
      acc?.tempHint === true ||
      acc?.keyboard === true ||
      persistentLabel
    if (!evidence) return null
    this.#closed.add(m.occ)
    const t: MeasureTraversal = {
      occ: m.occ,
      complete,
      wrongAttacks: acc?.wrong ?? 0,
      wrongAttacksExcludingBoundary: acc?.wrongExcludingBoundary ?? 0,
      groupsWithErrors: acc?.errorGroups.size ?? 0,
      tempHint: acc?.tempHint ?? false,
      persistentLabel,
      keyboard: acc?.keyboard ?? false,
    }
    this.measures.push(t)
    return t
  }

  /** Per-group outcomes of the reached groups, ascending by group. */
  groupOutcomes(): GroupOutcome[] {
    return [...this.#groups]
      .sort((a, b) => a[0] - b[0])
      .map(([group, g]) => ({
        group,
        wrongAttacks: g.wrong,
        earlyAttacks: g.early,
        lateMs: g.lateMs,
        wrongPitches: [...g.wrongPitches],
        spreadMs: g.spreadMs,
        tieEndPresses: g.tieEnd,
      }))
  }

  assistance(labelSettings: LabelSettingsSnapshot): AssistanceRecord {
    const asc = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b)
    return {
      level: this.assistanceLevel,
      persistentLabelNotes: asc(this.exposedNotes),
      persistentLabelGroups: asc(this.exposedGroups),
      hintRequests: this.hintRequests,
      autoHints: this.autoHints,
      hintGroups: asc(this.hintGroups),
      keyboardShown: this.keyboardShown,
      labelSettings,
    }
  }

  get assistanceLevel(): AssistanceLevel {
    if (this.keyboardShown) return 'keyboard'
    return this.exposedNotes.size > 0 || this.hintRequests > 0 || this.autoHints > 0 ? 'names' : 'none'
  }
}

export interface RecordInput {
  readonly log: AttemptLog
  readonly kind: AttemptRecord['kind']
  readonly timeline: Timeline
  readonly transport: ComparisonContext['transport']
  readonly pieceId: string
  readonly labelSettings: LabelSettingsSnapshot
  readonly completion: Completion
  readonly reason: InterruptReason | null
  /**
   * Optional total completion-time tolerance as a fraction of the expected time (0.1 = ±10%).
   * Not proof of rhythm accuracy; ignored when the expected time is null or zero.
   */
  readonly timeTolerance: number | null
  /** Matching-rules id when it differs from the timeline's (e.g. a non-default grace). */
  readonly matchingRules?: string
}

export function comparisonContextOf(
  timeline: Timeline,
  transport: ComparisonContext['transport'],
  matchingRules: string = timeline.context.matchingRules,
): ComparisonContext {
  return { ...timeline.context, transport, matchingRules }
}

/**
 * Attempt record (spec "Results and timing"). Scored: completion time is the attack span from
 * the first fresh press to the final group's last missing correct attack; passed = completed
 * with zero wrong attacks and no assistance of any kind (persistent labels, temporary hints,
 * keyboard), plus the optional total-time tolerance. Interrupted and abandoned attempts never
 * pass and carry no completion time. Ordinary-reading traversals ('reading') carry their
 * mistakes, assistance and measure traversals for suggested practice but are not timed.
 */
export function buildAttemptRecord(input: RecordInput): AttemptRecord {
  const { log, timeline, completion, kind } = input
  const context = comparisonContextOf(timeline, input.transport, input.matchingRules)
  const assistance = log.assistance(input.labelSettings)
  const scored = kind === 'scored'
  const completionTimeSec =
    scored && completion === 'completed' && log.clockStart !== null && log.finalAttack !== null
      ? (log.finalAttack - log.clockStart) / 1000
      : null
  const expected = scored ? timeline.expectedSpanSec : null
  const unscoredReason = scored ? timeline.timingUnscoredReason : READING_UNTIMED
  const tolerance = input.timeTolerance
  const withinTolerance =
    tolerance === null ||
    expected === null ||
    expected === 0 ||
    (completionTimeSec !== null && Math.abs(completionTimeSec - expected) <= tolerance * expected)
  return {
    id: log.id,
    pieceId: input.pieceId,
    createdAt: log.createdAt,
    kind,
    context,
    contextKey: contextKey(context),
    completion,
    ...(input.reason !== null ? { interruptReason: input.reason } : {}),
    wrongAttacks: log.wrongAttacks,
    earlyAttacks: log.earlyAttacks,
    groupsTotal: timeline.groups.length,
    groupsFirstPass: log.groupsFirstPass,
    ...(completionTimeSec !== null ? { completionTimeSec } : {}),
    expectedTimeSec: expected,
    notatedDurationSec: timeline.notatedDurationSec,
    ...(unscoredReason !== null ? { timingUnscoredReason: unscoredReason } : {}),
    assistance,
    passed:
      scored && completion === 'completed' && log.wrongAttacks === 0 && assistance.level === 'none' && withinTolerance,
    onsets: [...log.onsets],
    measures: [...log.measures],
    ...(scored ? { groups: log.groupOutcomes() } : {}),
  }
}

/** Repeated-abandonment evidence: a user stop/restart after wrong notes in bar `occ`. */
export function buildAbandonEvent(
  pieceId: string,
  context: ComparisonContext,
  occ: number,
  at: number,
  reason: InterruptReason,
): AbandonEvent {
  return { pieceId, measureContextKey: measureContextKey(context), occ, at, reason }
}
