/**
 * Practice timeline: the learner's required onset groups for one hand selection and passage,
 * prepared once before practice so matching only does small lookups per MIDI event
 * (spec: "Score following", "Repeating passages", "Results and timing").
 */
import { type Rational, ZERO, add, cmp, ge, gt, key, le, lt } from '../music/rational'
import { type TempoMapData, hasTempo, isValidMultiplier, secondsBetween, tempoMapId } from '../music/tempo'
import {
  MATCHING_RULES_VERSION,
  type Hand,
  type HandSelection,
  type PerformedNote,
  type ScoreModel,
  type TimingIssue,
  type UnsupportedRegion,
} from '../model/score'
import type { ComparisonContext, PassageRange } from '../model/practice'
import { handAssignmentId } from '../model/practice'
import { describePassage, normalizePassage, passageBounds } from '../model/passage'

/** Hands the learner plays (Preview has no learner timeline). */
export type LearnerHands = Exclude<HandSelection, 'none'>

export interface TimelineOptions {
  readonly hands: LearnerHands
  /** Inclusive occurrence range, optionally with exact note-level edges (U21); null = whole piece. */
  readonly range: PassageRange | null
  /** Speed multiplier applied to the whole tempo map (must be finite and > 0). */
  readonly multiplier: number
  /** Practice tempo map. Defaults to the score's; pass `userTempoMap(...)` when it has none. */
  readonly tempo?: TempoMapData
}

/**
 * All distinct pitches the learner must freshly attack at one musical position
 * (spec: "onset groups: all distinct pitches that begin at the same musical position in the
 * selected hand or hands"). Tie continuations are never required, not even at a loop start
 * (a tie attacked before the loop sounds through; DECISIONS E16).
 */
export interface OnsetGroup {
  readonly index: number
  readonly position: Rational
  /** Measure occurrence the position belongs to (mistakes are attributed here). */
  readonly occ: number
  /** Required performed-note indices (shared pitches in two voices are both listed). */
  readonly notes: readonly number[]
  /** Distinct required MIDI pitches, ascending. One attack satisfies a pitch shared by two voices. */
  readonly pitches: readonly number[]
  /** Performed notes per entry of `pitches`, for marking accepted noteheads. */
  readonly notesByPitch: readonly (readonly number[])[]
  /**
   * Held (untied) notes made required only because they already sound at the loop start
   * (practice-boundary reattacks). A tied note sounding there is not reattacked (`tiedPitches`).
   */
  readonly boundaryNotes: readonly number[]
  /** True when the group exists only because of the loop boundary (no written onset here). */
  readonly synthetic: boolean
  /** Seconds from the passage start to this position at the multiplier; null without tempo. */
  readonly onsetSec: number | null
  /** Earliest reference attack in the group (onset + smallest roll offset). */
  readonly firstAttackSec: number | null
  /** Latest reference attack in the group (onset + largest roll offset). */
  readonly refAttackSec: number | null
  /**
   * Ottava spans applicable at this position for the selected parts (staff scope and exact
   * half-open [start, end)); emphasized on a wrong attack. Never derived from a played pitch.
   */
  readonly ottavas: readonly number[]
  /**
   * Learner pitches tied into this onset: tie continuations (of a chain attacked earlier in the
   * passage) whose tie end lies after the previous group's position and at or before this one,
   * so they sound through while this group is current. Never one of `pitches`. Pressing one is
   * a tie-end press, not a wrong attack (DECISIONS E16). Usually empty.
   */
  readonly tiedPitches: readonly number[]
  /**
   * Sustain pedal the score wants at this onset: true = down (a sustain span covers it), false =
   * up; null when the score has no sustain pedal marks at all (DECISIONS E17).
   */
  readonly pedalDown: boolean | null
}

/** A position where the automatic (non-learner) part attacks. */
export interface AutomaticPosition {
  readonly position: Rational
  readonly occ: number
  /** Automatic-part notes attacked here, excluding unisons with a learner attack. */
  readonly notes: readonly number[]
  /** Automatic notes whose pitch the learner also attacks here: suppress the redundant automatic attack. */
  readonly unisonWithLearner: readonly number[]
  readonly onsetSec: number | null
  /** Index of the learner group at this same position, if any (a transport gate). */
  readonly learnerGroup: number | null
}

export interface TimelineMeasure {
  readonly occ: number
  /** Group indices in this occurrence (may be empty: no learner onsets in this bar). */
  readonly groups: readonly number[]
  /**
   * A boundary bar of a note-level loop that leaves out some of the bar's learner onsets: its
   * traversals are never complete (partial, H1/H7), so a few notes never count as the whole bar.
   */
  readonly partial: boolean
}

export type ScoredBlocker =
  | { readonly kind: 'no-required-onsets'; readonly message: string }
  | { readonly kind: 'tempo-missing'; readonly message: string }
  | { readonly kind: 'unsupported-region'; readonly region: UnsupportedRegion; readonly message: string }
  | { readonly kind: 'hands-unconfirmed'; readonly voices: readonly string[]; readonly message: string }

export interface Timeline {
  readonly model: ScoreModel
  readonly hands: LearnerHands
  /**
   * Resolved inclusive range (the whole piece when none was selected), normalized: exact edges only
   * strictly inside a boundary bar (`normalizePassage`), so whole-bar keys never change.
   */
  readonly range: PassageRange
  /** True when the caller selected a passage (scored attempt per DECISIONS P1). */
  readonly rangeSelected: boolean
  readonly multiplier: number
  readonly tempo: TempoMapData
  readonly start: Rational
  readonly end: Rational
  readonly groups: readonly OnsetGroup[]
  /** Required performed-note index → group index. */
  readonly noteToGroup: ReadonlyMap<number, number>
  /**
   * Learner note (required, or a tie continuation of a required attack) → the group whose
   * attack it reveals. Persistent-label exposure is attributed through this map.
   */
  readonly labelToGroup: ReadonlyMap<number, number>
  readonly measures: readonly TimelineMeasure[]
  readonly measureByOcc: ReadonlyMap<number, TimelineMeasure>
  /** Automatic-part attack positions (empty in both-hands practice). */
  readonly automatic: readonly AutomaticPosition[]
  /**
   * Reference attack span: first required attack → latest required attack of the final group
   * (final roll spread included, final sustain and trailing rests excluded). Null for a
   * single-group passage, without tempo, or when timing is unscored.
   */
  readonly expectedSpanSec: number | null
  /** Full notated passage duration at the multiplier; null without tempo. */
  readonly notatedDurationSec: number | null
  /** Why the attack span cannot be scored (no tempo, fermata, verbal tempo…); null when it can. */
  readonly timingUnscoredReason: string | null
  /** Timing issues inside the passage (all of them, including those that do not affect the span). */
  readonly timingIssues: readonly TimingIssue[]
  readonly status: 'ok' | 'no-required-onsets'
  /** Unsupported regions overlapping the passage. */
  readonly unsupported: readonly UnsupportedRegion[]
  /** Reasons scored practice is disabled for this selection (Listen and selection stay available). */
  readonly blockers: readonly ScoredBlocker[]
  readonly scoredAllowed: boolean
  /** Comparison context without the transport mode (the engine adds it). */
  readonly context: Omit<ComparisonContext, 'transport'>
}

const HAND_NAMES: Record<LearnerHands, string> = { both: 'both-hands', right: 'right-hand', left: 'left-hand' }

function handsOf(h: LearnerHands): readonly Hand[] {
  return h === 'both' ? ['R', 'L'] : h === 'right' ? ['R'] : ['L']
}

/** Printed bar label for an occurrence: "12" or "12 (pass 2)". */
export function barLabel(model: ScoreModel, occ: number): string {
  const o = model.occurrences[occ]
  if (!o) return `${occ + 1}`
  return o.pass > 1 ? `${o.number} (pass ${o.pass})` : o.number
}

function resolveRange(model: ScoreModel, range: PassageRange | null): PassageRange {
  const last = model.occurrences.length - 1
  if (range === null) return { fromOcc: 0, toOcc: Math.max(0, last) }
  if (
    !Number.isInteger(range.fromOcc) ||
    !Number.isInteger(range.toOcc) ||
    range.fromOcc < 0 ||
    range.toOcc > last ||
    range.fromOcc > range.toOcc
  ) {
    throw new RangeError(`Invalid passage ${range.fromOcc}–${range.toOcc} (score has ${last + 1} bars)`)
  }
  // Exact edges (U21) must lie inside their boundary bars and keep the loop non-empty.
  const { start, end } = passageBounds(model, range)
  const first = model.occurrences[range.fromOcc]!
  const lastBar = model.occurrences[range.toOcc]!
  if (
    (range.start && (lt(start, first.start) || !lt(start, add(first.start, first.duration)))) ||
    (range.end && (!gt(end, lastBar.start) || gt(end, add(lastBar.start, lastBar.duration))))
  ) {
    throw new RangeError(`Passage edges outside bars ${range.fromOcc}–${range.toOcc}`)
  }
  // Edges on a barline are dropped, so a whole-bar passage keeps its comparison key.
  return normalizePassage(model, range) ?? { fromOcc: range.fromOcc, toOcc: range.toOcc }
}

function describeIssue(model: ScoreModel, issue: TimingIssue): string {
  const what =
    issue.kind === 'fermata'
      ? 'Fermata'
      : issue.kind === 'verbal-tempo'
        ? `Verbal tempo "${issue.text}"`
        : issue.kind === 'rubato'
          ? 'Rubato'
          : `Timing instruction "${issue.text}"`
  return `${what} in bar ${barLabel(model, issue.occ)} has no exact duration; completion time is not compared.`
}

/**
 * A timing issue makes the attack span unscored only when it can change the reference time
 * between the first and the last required attack: a fermata held at or after the final
 * attack only lengthens final sustain (excluded from the span), and one before the first
 * required attack only delays the start; tempo-changing text before the final attack does
 * affect it.
 */
function affectsSpan(issue: TimingIssue, first: Rational, last: Rational): boolean {
  if (!lt(issue.at, last)) return false
  return issue.kind === 'fermata' ? ge(issue.at, first) : true
}

interface Bucket {
  readonly position: Rational
  readonly occ: number
  readonly required: PerformedNote[]
  readonly auto: PerformedNote[]
}

/**
 * Build the learner timeline for a hand selection and passage.
 *
 * - Only learner-assigned voices create groups (right = voices assigned 'R', left = 'L').
 * - Tie continuations and grace notes are never required; positions holding only rests or
 *   tie continuations get no group (the cursor moves to the next playable onset).
 * - At a loop start inside a held (untied) note, the sounding note becomes required at the
 *   start and is flagged as a practice-boundary reattack (spec: "Repeating passages"). A tie
 *   chain attacked before the start is not required anywhere in the loop: it sounds through and
 *   its pitch is in the first group's `tiedPitches` (user, 31 October 2026; DECISIONS E16).
 * - `tiedPitches` and `pedalDown` per group feed the tie-end and pedal outcomes (E16, E17).
 * - Reference attack times include roll offsets scaled by 1/multiplier.
 */
export function buildTimeline(model: ScoreModel, options: TimelineOptions): Timeline {
  const { hands, multiplier } = options
  if (!isValidMultiplier(multiplier)) throw new RangeError(`Invalid speed multiplier ${multiplier}`)
  const tempo = options.tempo ?? model.tempo
  const range = resolveRange(model, options.range)
  const firstOcc = model.occurrences[range.fromOcc]
  const lastOcc = model.occurrences[range.toOcc]
  // A note-level loop (U21) narrows the boundary bars to [range.start, range.end).
  const start = range.start ?? (firstOcc ? firstOcc.start : ZERO)
  const end = range.end ?? (lastOcc ? add(lastOcc.start, lastOcc.duration) : model.totalDuration)
  const learnerHands = handsOf(hands)
  // Grace and cue notes are never expected or sounded (DECISIONS I13).
  const isLearner = (n: PerformedNote): boolean => !n.grace && !n.cue && learnerHands.includes(n.hand)

  // A held note sounding at a loop start is reattacked there; a tie chain attacked before the
  // start is not (user, 31 October 2026: "pretend it's just not there"): it sounds through, and
  // pressing it is a tie-end press of the first group (E16).
  const boundary: PerformedNote[] = []
  const tiedAtStart: PerformedNote[] = []
  if (gt(start, ZERO)) {
    for (const n of model.notes) {
      if (!isLearner(n)) continue
      const c = cmp(n.onset, start)
      if (c < 0 && gt(add(n.onset, n.duration), start)) {
        ;(isTied(n) ? tiedAtStart : boundary).push(n)
      } else if (c === 0 && n.tieContinuation) {
        const head = model.notes[n.tieHead]
        if (head && lt(head.onset, start)) tiedAtStart.push(n)
      }
    }
  }

  const buckets = new Map<string, Bucket>()
  const bucketAt = (position: Rational, occ: number): Bucket => {
    const k = key(position)
    let b = buckets.get(k)
    if (!b) {
      b = { position, occ, required: [], auto: [] }
      buckets.set(k, b)
    }
    return b
  }
  const inRange: PerformedNote[] = []
  for (const n of model.notes) {
    if (lt(n.onset, start) || !lt(n.onset, end)) continue
    inRange.push(n)
    if (n.grace || n.cue || n.tieContinuation) continue
    const b = bucketAt(n.onset, n.occ)
    ;(isLearner(n) ? b.required : b.auto).push(n)
  }
  if (boundary.length > 0) bucketAt(start, range.fromOcc)

  const sorted = [...buckets.values()].sort((a, b) => cmp(a.position, b.position))
  const secs = hasTempo(tempo) ? (p: Rational) => secondsBetween(tempo, start, p, multiplier) : null
  const bothHands = hands === 'both'
  const learnerSpans = new Set<number>()
  for (const s of model.ottavas) {
    if (
      s.notes.some((i) => {
        const n = model.notes[i]
        return n !== undefined && isLearner(n)
      })
    )
      learnerSpans.add(s.index)
  }

  const groups: OnsetGroup[] = []
  const noteToGroup = new Map<number, number>()
  const automatic: AutomaticPosition[] = []
  for (const b of sorted) {
    const atStart = boundary.length > 0 && cmp(b.position, start) === 0
    const byPitch = new Map<number, number[]>()
    const offsets: number[] = []
    const boundaryNotes: number[] = []
    const addNote = (n: PerformedNote, offset: number): void => {
      let list = byPitch.get(n.midi)
      if (!list) byPitch.set(n.midi, (list = []))
      list.push(n.index)
      offsets.push(offset)
    }
    for (const n of b.required) addNote(n, n.refOffsetSec)
    if (atStart) {
      for (const n of boundary) {
        addNote(n, 0)
        boundaryNotes.push(n.index)
      }
    }
    const onsetSec = secs ? secs(b.position) : null
    let groupIndex: number | null = null
    if (byPitch.size > 0) {
      groupIndex = groups.length
      const pitches = [...byPitch.keys()].sort((x, y) => x - y)
      const notesByPitch = pitches.map((p) => byPitch.get(p) ?? [])
      const notes = notesByPitch.flat()
      for (const n of notes) noteToGroup.set(n, groupIndex)
      const staves = new Set<number>()
      for (const n of notes) {
        const pn = model.notes[n]
        if (pn) staves.add(pn.staff)
      }
      groups.push({
        index: groupIndex,
        position: b.position,
        occ: b.occ,
        notes,
        pitches,
        notesByPitch,
        boundaryNotes,
        synthetic: b.required.length === 0,
        onsetSec,
        firstAttackSec: onsetSec === null ? null : onsetSec + Math.min(...offsets) / multiplier,
        refAttackSec: onsetSec === null ? null : onsetSec + Math.max(...offsets) / multiplier,
        ottavas: applicableOttavas(
          model,
          b.position,
          bothHands ? null : (s) => staves.has(s.staff) || learnerSpans.has(s.index),
        ),
        tiedPitches: [],
        pedalDown: null,
      })
    }
    if (!bothHands && b.auto.length > 0) {
      const auto: number[] = []
      const unison: number[] = []
      for (const n of b.auto) (byPitch.has(n.midi) ? unison : auto).push(n.index)
      automatic.push({
        position: b.position,
        occ: b.occ,
        notes: auto,
        unisonWithLearner: unison,
        onsetSec,
        learnerGroup: groupIndex,
      })
    }
  }

  const tied = tiedPitchesOf(groups, [...tiedAtStart, ...inRange], isLearner, start)
  const pedals = pedalsOf(groups, model)
  for (let i = 0; i < groups.length; i++) {
    const tiedPitches = tied.get(i)
    const pedalDown = pedals?.[i] ?? null
    if (tiedPitches || pedalDown !== null) groups[i] = { ...groups[i]!, tiedPitches: tiedPitches ?? [], pedalDown }
  }

  const labelToGroup = new Map<number, number>(noteToGroup)
  const boundaryHeadGroup = new Map<number, number>()
  const firstGroup = groups[0]
  if (firstGroup) for (const n of firstGroup.boundaryNotes) boundaryHeadGroup.set(model.notes[n]?.tieHead ?? n, 0)
  for (const n of inRange) {
    if (!n.tieContinuation || !isLearner(n) || labelToGroup.has(n.index)) continue
    const g = noteToGroup.get(n.tieHead) ?? boundaryHeadGroup.get(n.tieHead)
    if (g !== undefined) labelToGroup.set(n.index, g)
  }

  // Boundary bars a note-level loop cuts: some learner onset of the bar lies outside the loop.
  const partial = new Set<number>()
  if (range.start || range.end) {
    for (const n of model.notes) {
      if (n.occ !== range.fromOcc && n.occ !== range.toOcc) continue
      if (n.tieContinuation || !isLearner(n)) continue
      if (lt(n.onset, start) || !lt(n.onset, end)) partial.add(n.occ)
    }
  }
  const measures: TimelineMeasure[] = []
  const measureByOcc = new Map<number, TimelineMeasure>()
  if (model.occurrences.length > 0) {
    const perOcc = new Map<number, number[]>()
    for (const g of groups) {
      let list = perOcc.get(g.occ)
      if (!list) perOcc.set(g.occ, (list = []))
      list.push(g.index)
    }
    for (let occ = range.fromOcc; occ <= range.toOcc; occ++) {
      const m: TimelineMeasure = { occ, groups: perOcc.get(occ) ?? [], partial: partial.has(occ) }
      measures.push(m)
      measureByOcc.set(occ, m)
    }
  }

  const lastGroup = groups[groups.length - 1]
  const timingIssues = model.timingIssues.filter(
    (i) =>
      i.occ >= range.fromOcc &&
      i.occ <= range.toOcc &&
      (!range.start || ge(i.at, range.start)) &&
      (!range.end || lt(i.at, range.end)),
  )
  const spanIssue =
    firstGroup && lastGroup
      ? timingIssues.find((i) => affectsSpan(i, firstGroup.position, lastGroup.position))
      : undefined
  const timingUnscoredReason = !hasTempo(tempo)
    ? 'No numerical tempo: choose a practice tempo before timing can be scored.'
    : spanIssue
      ? describeIssue(model, spanIssue)
      : null
  const expectedSpanSec =
    timingUnscoredReason === null &&
    groups.length >= 2 &&
    firstGroup?.firstAttackSec != null &&
    lastGroup?.refAttackSec != null
      ? lastGroup.refAttackSec - firstGroup.firstAttackSec
      : null
  const notatedDurationSec = hasTempo(tempo) ? secondsBetween(tempo, start, end, multiplier) : null

  const unsupported = model.unsupported.filter((r) => r.fromOcc <= range.toOcc && r.toOcc >= range.fromOcc)
  const words = describePassage(model, range, hands)
  const bars = `${words.charAt(0).toLowerCase()}${words.slice(1)}`
  const blockers: ScoredBlocker[] = []
  if (groups.length === 0) {
    blockers.push({
      kind: 'no-required-onsets',
      message: `The ${HAND_NAMES[hands]} part has no notes to play in ${bars}. Choose another hand or passage; Listen is still available.`,
    })
  }
  if (!hasTempo(tempo)) {
    blockers.push({
      kind: 'tempo-missing',
      message: 'This score has no numerical tempo. Enter a practice tempo before scored practice.',
    })
  }
  for (const region of unsupported) {
    blockers.push({
      kind: 'unsupported-region',
      region,
      message: `${region.message} (bars ${barLabel(model, region.fromOcc)}–${barLabel(model, region.toOcc)}) cannot be scored yet.`,
    })
  }
  if (model.hands.ambiguousVoices.length > 0 && !model.hands.confirmed) {
    const ambiguous = new Set(model.hands.ambiguousVoices)
    const voices = new Set<string>()
    for (const n of inRange) {
      const v = `${n.partId}:${n.voice}`
      if (ambiguous.has(v)) voices.add(v)
    }
    if (voices.size > 0) {
      blockers.push({
        kind: 'hands-unconfirmed',
        voices: [...voices],
        message: 'Confirm the hand assignment of cross-staff voices in the import summary before scored practice.',
      })
    }
  }

  return {
    model,
    hands,
    range,
    rangeSelected: options.range !== null,
    multiplier,
    tempo,
    start,
    end,
    groups,
    noteToGroup,
    labelToGroup,
    measures,
    measureByOcc,
    automatic,
    expectedSpanSec,
    notatedDurationSec,
    timingUnscoredReason,
    timingIssues,
    status: groups.length === 0 ? 'no-required-onsets' : 'ok',
    unsupported,
    blockers,
    scoredAllowed: blockers.length === 0,
    context: {
      scoreVersionId: model.scoreVersionId,
      passage: range,
      hands,
      handsId: handAssignmentId(model.hands),
      tempoMapId: tempoMapId(tempo),
      multiplier,
      rollPolicy: model.meta.rollPolicyVersion,
      matchingRules: MATCHING_RULES_VERSION,
    },
  }
}

/** A note of a tie chain: a continuation, or a head tied on (its chain outlasts the note). */
function isTied(n: PerformedNote): boolean {
  return n.tieContinuation || gt(n.soundingDuration, n.duration)
}

/**
 * `tiedPitches`: each learner tie continuation in the passage, and each tied note already
 * sounding at the passage start (`notes` holds both), goes to the first group at or after its
 * onset (the start, for one sounding at it), unless that group attacks the pitch itself. A tie
 * end after the last group gets none.
 */
function tiedPitchesOf(
  groups: readonly OnsetGroup[],
  notes: readonly PerformedNote[],
  isLearner: (n: PerformedNote) => boolean,
  start: Rational,
): Map<number, readonly number[]> {
  const out = new Map<number, readonly number[]>()
  if (groups.length === 0) return out
  const tied = new Map<number, Set<number>>()
  for (const n of notes) {
    if (!isLearner(n) || !(n.tieContinuation || lt(n.onset, start))) continue
    const onset = lt(n.onset, start) ? start : n.onset
    let lo = 0
    let hi = groups.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lt(groups[mid]!.position, onset)) lo = mid + 1
      else hi = mid
    }
    const g = groups[lo]
    if (!g || g.pitches.includes(n.midi)) continue
    let set = tied.get(lo)
    if (!set) tied.set(lo, (set = new Set()))
    set.add(n.midi)
  }
  for (const [i, set] of tied)
    out.set(
      i,
      [...set].sort((a, b) => a - b),
    )
  return out
}

/**
 * `pedalDown`: the sustain state after every sustain mark at or before the group's position, in
 * score order ('start' and 'change' press, 'stop' releases, 'continue' keeps), as playback
 * realizes them. Sostenuto and soft marks never decide it; staff scope is ignored (one foot).
 */
function pedalsOf(groups: readonly OnsetGroup[], model: ScoreModel): boolean[] | null {
  const marks = model.pedals
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.kind === 'sustain')
    .sort((a, b) => cmp(a.m.at, b.m.at) || a.i - b.i)
  if (marks.length === 0) return null
  const out: boolean[] = []
  let down = false
  let k = 0
  for (const g of groups) {
    for (; k < marks.length && le(marks[k]!.m.at, g.position); k++) {
      const type = marks[k]!.m.type
      if (type === 'start' || type === 'change') down = true
      else if (type === 'stop') down = false
    }
    out.push(down)
  }
  return out
}

/**
 * Ottava spans active at `position` (half-open [start, end)). With `applies` null (both-hands
 * practice) every span of the selected parts counts, including one over a staff that is
 * resting or continuing a tie; otherwise only spans the predicate accepts. A held or tied
 * note never extends a span.
 */
export function applicableOttavas(
  model: ScoreModel,
  position: Rational,
  applies: ((span: ScoreModel['ottavas'][number]) => boolean) | null,
): readonly number[] {
  const out: number[] = []
  for (const s of model.ottavas) {
    if (le(s.start, position) && lt(position, s.end) && (applies === null || applies(s))) out.push(s.index)
  }
  return out
}

/** Index of the first group at or after `position` (groups.length when none). */
export function groupAtOrAfter(timeline: Timeline, position: Rational): number {
  const gs = timeline.groups
  let lo = 0
  let hi = gs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lt(gs[mid]!.position, position)) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Transport gates for accompaniment (engine ↔ transport seam): ascending performance
 * positions of the learner's onset groups; gate `i` is engine group `i`.
 */
export function transportGates(timeline: Timeline): readonly Rational[] {
  return timeline.groups.map((g) => g.position)
}
