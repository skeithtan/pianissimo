/**
 * Practice records shared by the engine (producer), history/suggestions (consumer) and
 * storage. Plain JSON. See spec sections "Results and timing", "Repeating passages" and
 * "Suggested practice".
 */
import { type Rational, key } from '../music/rational'
import type { HandAssignment, HandSelection } from './score'
import type { PersistentLabelMode } from './settings'

/**
 * Inclusive range of measure occurrences (performance order), optionally narrowed to notes
 * inside its boundary bars (note-level loops, DECISIONS U19/U21). Helpers: `./passage.ts`.
 */
export interface PassageRange {
  readonly fromOcc: number
  readonly toOcc: number
  /**
   * Exact loop start (performance position, whole notes) strictly inside `fromOcc`: the onset of
   * the loop's first note. Absent = the start of `fromOcc` (whole bars; every older record).
   */
  readonly start?: Rational
  /**
   * Exact exclusive loop end strictly inside `toOcc`: the onset after the loop's last note.
   * Absent = the end of `toOcc`.
   */
  readonly end?: Rational
}

/** True when the passage has no exact edge (whole bars, as before note-level loops). */
export function isWholeBars(p: PassageRange): boolean {
  return p.start === undefined && p.end === undefined
}

/**
 * The passage part of a comparison key. Whole bars keep the key they always had ("5-7"), so
 * stored history still matches; exact edges append "@start..end" ("5-7@45/4..53/2", an absent
 * edge is empty), making a note-level loop its own comparison context (DECISIONS U21).
 */
export function passageKey(p: PassageRange): string {
  const bars = `${p.fromOcc}-${p.toOcc}`
  if (isWholeBars(p)) return bars
  return `${bars}@${p.start ? key(p.start) : ''}..${p.end ? key(p.end) : ''}`
}

/**
 * Results are only compared within one context (spec: same score version, passage
 * occurrences, hands, tempo map and speed, roll policy, transport mode, matching rules).
 */
/**
 * How musical time relates to the learner's input: 'free' = both-hands immediate advancement;
 * 'accompaniment' = transport-gated, the music waits at every learner onset; 'strict' = rhythm
 * mode (DECISIONS P13), the music never waits and every onset group is judged against its
 * scheduled time.
 */
export type TransportKind = 'free' | 'accompaniment' | 'strict'

/** Rhythm mode (strict transport) parameters recorded with an attempt. */
export interface RhythmParams {
  /** A group completed within this many ms of its scheduled time is on time (pass condition). */
  readonly toleranceMs: number
}

export interface ComparisonContext {
  readonly scoreVersionId: string
  readonly passage: PassageRange
  readonly hands: HandSelection
  /**
   * `handAssignmentId(model.hands)`: reassigning voices to hands keeps the score version but
   * changes what each hand plays, so results stop comparing (DECISIONS Q3).
   */
  readonly handsId: string
  readonly tempoMapId: string
  readonly multiplier: number
  readonly rollPolicy: string
  /** See `TransportKind`. Strict attempts are their own comparison contexts. */
  readonly transport: TransportKind
  readonly matchingRules: string
}

export function contextKey(c: ComparisonContext): string {
  return [
    c.scoreVersionId,
    // "from-to" for whole bars (unchanged keys); exact edges append "@start..end" (U21).
    passageKey(c.passage),
    c.hands,
    c.handsId,
    c.tempoMapId,
    c.multiplier.toFixed(4),
    c.rollPolicy,
    c.transport,
    c.matchingRules,
  ].join('|')
}

/**
 * Stable short id of a voice → hand assignment (FNV-1a over the sorted pairs). Independent of
 * `ambiguousVoices` and `confirmed`: only what each hand plays matters for comparison.
 */
export function handAssignmentId(a: HandAssignment): string {
  const text = Object.keys(a.byVoice)
    .sort()
    .map((v) => `${v}=${a.byVoice[v]}`)
    .join(',')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `h${h.toString(16).padStart(8, '0')}`
}

/** Context for per-measure traversal history (no passage: a bar is a bar in any passage). */
export function measureContextKey(c: Omit<ComparisonContext, 'passage'>): string {
  return [
    c.scoreVersionId,
    c.hands,
    c.handsId,
    c.tempoMapId,
    c.multiplier.toFixed(4),
    c.rollPolicy,
    c.transport,
    c.matchingRules,
  ].join('|')
}

export type Completion = 'completed' | 'interrupted' | 'abandoned'

export type InterruptReason =
  | 'pause'
  | 'seek'
  | 'disconnect'
  | 'suspend'
  | 'setting-change'
  | 'layout-change'
  | 'tempo-change'
  | 'hand-change'
  | 'range-change'
  | 'mode-change'
  | 'user-stop'
  | 'user-restart'

/** Reasons that are user-initiated abandonment (count toward repeated-restart suggestions). */
export const USER_ABANDON_REASONS: readonly InterruptReason[] = ['user-stop', 'user-restart']

export type AssistanceLevel = 'none' | 'names' | 'keyboard'

export interface LabelSettingsSnapshot {
  readonly mode: PersistentLabelMode
  /** JSON of the active clef rules at the time (for result details). */
  readonly rulesJson: string
  /** Tie continuations labeled too (U69); absent in records from before the setting (they were). */
  readonly tiedContinuations?: boolean
}

export interface AssistanceRecord {
  readonly level: AssistanceLevel
  /** Performed note indices exposed by persistent labels during this attempt/traversal. */
  readonly persistentLabelNotes: readonly number[]
  /** Group indices (within the attempt's timeline) whose notes were exposed by persistent labels. */
  readonly persistentLabelGroups: readonly number[]
  /** Manual Hint / hint-pedal requests (not incremented by persistent labels). */
  readonly hintRequests: number
  /** Automatic name hints shown after the wrong-attack threshold. */
  readonly autoHints: number
  /** Groups revealed by temporary hints. */
  readonly hintGroups: readonly number[]
  readonly keyboardShown: boolean
  readonly labelSettings: LabelSettingsSnapshot
}

/** One measure occurrence as traversed inside an attempt or ordinary reading. */
export interface MeasureTraversal {
  readonly occ: number
  /** All required onset groups of this measure were completed in this traversal. */
  readonly complete: boolean
  readonly wrongAttacks: number
  /** Wrong attacks excluding those at synthetic loop-boundary reattack groups. */
  readonly wrongAttacksExcludingBoundary: number
  readonly groupsWithErrors: number
  readonly tempHint: boolean
  readonly persistentLabel: boolean
  readonly keyboard: boolean
}

export interface OnsetTimestamp {
  readonly group: number
  /** Seconds since the attempt clock started (first fresh press). */
  readonly t: number
}

/**
 * How one learner onset group went in a scored attempt (groundwork for teacher corrections).
 * Additive: records stored before it have no `groups`.
 */
export interface GroupOutcome {
  /** Engine group index (`timeline.groups`) within the attempt's passage. */
  readonly group: number
  /** Wrong attacks attributed to the group, too-early ones included. */
  readonly wrongAttacks: number
  /** Of `wrongAttacks`, right pitches pressed too early (E12). */
  readonly earlyAttacks: number
  /**
   * Whole milliseconds from the transport reaching the group's gate to the learner completing
   * the group; 0 when completed before or at arrival, not completed, or without a transport, and
   * always 0 for the attempt's first group (the clock starts with its press; it cannot be late).
   */
  readonly lateMs: number
  /**
   * The wrong (not too-early) pitches attacked in this group, in order (MIDI), so a correction
   * can name the slip: a wrong accidental (one semitone off, same letter), a wrong octave (twelve
   * off) or another key. Absent on records stored before 2026-10-31 (afternoon).
   */
  readonly wrongPitches?: readonly number[]
  /**
   * Whole milliseconds between the first and the last accepted attack of the group: how spread
   * out a chord was played; 0 for a single note or when absent.
   */
  readonly spreadMs?: number
  /**
   * Presses of a pitch that is tied into this onset (sounding through from an earlier attack),
   * which the learner should not have re-attacked.
   */
  readonly tieEndPresses?: number
  /**
   * Strict transport only (rhythm mode, P13): whole milliseconds from the group's scheduled time
   * (the transport's arrival at its gate) to the learner completing it; negative = early. Absent
   * when the group was not completed or on gated attempts.
   */
  readonly offsetMs?: number
  /** Strict transport only: the music moved on before the group was complete. */
  readonly missed?: boolean
}

export interface AttemptRecord {
  readonly id: string
  readonly pieceId: string
  readonly createdAt: number
  readonly kind: 'scored' | 'reading'
  readonly context: ComparisonContext
  readonly contextKey: string
  readonly completion: Completion
  readonly interruptReason?: InterruptReason
  readonly wrongAttacks: number
  /** Of `wrongAttacks`, right pitches pressed too early (E12). Absent on older records. */
  readonly earlyAttacks?: number
  readonly groupsTotal: number
  readonly groupsFirstPass: number
  /** Attack-span completion time; absent when not completed or the clock never started. */
  readonly completionTimeSec?: number
  /** Reference attack span; null when there is no tempo ratio (single group) or timing is unscored. */
  readonly expectedTimeSec: number | null
  readonly notatedDurationSec: number | null
  readonly timingUnscoredReason?: string
  readonly assistance: AssistanceRecord
  /**
   * Passed the selected pass condition: zero wrong attacks, no assistance and the optional total
   * time tolerance; in strict transport (rhythm mode) no missed group and every group within
   * `rhythm.toleranceMs` of its scheduled time instead of the time tolerance.
   */
  readonly passed: boolean
  readonly onsets: readonly OnsetTimestamp[]
  readonly measures: readonly MeasureTraversal[]
  /**
   * Scored attempts: one entry per group reached in the attempt (completed ones and, when it
   * ended early, the current one), ascending by group. Absent on reading traversals and on
   * records stored before it existed.
   */
  readonly groups?: readonly GroupOutcome[]
  /** Strict transport (rhythm mode, P13) parameters; absent on gated and free attempts. */
  readonly rhythm?: RhythmParams
  /** Strict transport: groups the music passed before they were complete. Absent = 0. */
  readonly missedGroups?: number
}

/** A user-initiated restart/stop after wrong notes in a bar (repeated-abandonment trigger). */
export interface AbandonEvent {
  readonly pieceId: string
  readonly measureContextKey: string
  readonly occ: number
  readonly at: number
  readonly reason: InterruptReason
}
