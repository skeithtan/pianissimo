/**
 * Reference performance builder: turns the common score model into the automatic part's
 * note and pedal events for the transport (spec "Listening and hand practice" and "MIDI
 * input, output, and pedal controls").
 *
 * Rules implemented here:
 *  - Learner selection decides the automatic part: right → left part, left → right part,
 *    Preview ('none') → both parts (optionally filtered to one hand), both hands → nothing.
 *  - A tie chain is one attack lasting the whole tied duration.
 *  - A note already sounding at the range start is attacked at the start (the automatic
 *    counterpart of the engine's loop-boundary reattack); releases are clipped to the range end.
 *  - If a pitch starts simultaneously in the learner and automatic parts, the learner's attack
 *    is required and the redundant automatic attack is suppressed. A learner tie chain begun
 *    before the range start is not attacked at the start (E16), so it suppresses nothing there.
 *  - Simultaneous unisons inside the automatic part (Preview: across both hands) merge into one
 *    attack with the loudest velocity and the latest release.
 *  - Overlapping same-pitch notes keep their own on/off pair; backends count ownership so an
 *    older release never cuts a newer note.
 *  - Velocities are scaled by the accompaniment level (velocity scaling, spec default).
 *  - Pedals are sent in Preview, and in hand practice only when the route allows it
 *    (`sendPedals`). A pedal 'change' is up at the position then down again shortly after.
 */
import { type Rational, add, cmp, gt, key, lt, min } from '../music/rational'
import { passageBounds } from '../model/passage'
import type { PassageRange } from '../model/practice'
import type { Hand, HandSelection, PedalKind, PedalMark, ScoreModel } from '../model/score'
import { CC_SOFT, CC_SOSTENUTO, CC_SUSTAIN } from '../midi/types'
import type { ControlEvent, NoteOffEvent, NoteOnEvent, PerformanceEvent, PerformanceRange } from './types'

/** Delay of the re-press after a pedal change, seconds at 1× (lets dampers fall first). */
export const PEDAL_CHANGE_GAP_SEC = 0.03

export const PEDAL_CONTROLLERS: Readonly<Record<PedalKind, number>> = {
  sustain: CC_SUSTAIN,
  sostenuto: CC_SOSTENUTO,
  soft: CC_SOFT,
}

export type ListenFilter = 'both' | 'left' | 'right'

export interface PerformanceOptions {
  /** Hands the learner plays; 'none' is Preview. */
  readonly hands: HandSelection
  /** Performance range; omitted or null = the whole piece. */
  readonly range?: PerformanceRange | null
  /** 0..1 velocity scale for app playback. 0 mutes notes (pedals still follow). Default 1. */
  readonly accompanimentLevel?: number
  /**
   * Send score pedals. Preview: normally true. Hand practice: only when the route verified
   * that automatic pedals are confined to the automatic part
   * (`MidiRouteSettings.automaticPedalsInHandPractice`).
   */
  readonly sendPedals: boolean
  /** Preview listening filter (ignored in hand practice). */
  readonly listenFilter?: ListenFilter
}

/**
 * Performance range of a passage (inclusive occurrences, narrowed to its exact note-level edges
 * when it has them, U21); null = whole piece.
 */
export function passageRange(model: ScoreModel, passage: PassageRange | null): PerformanceRange {
  return passageBounds(model, passage)
}

/** Hands the app plays for a learner selection (and Preview filter). */
export function automaticHands(hands: HandSelection, filter: ListenFilter = 'both'): readonly Hand[] {
  switch (hands) {
    case 'both':
      return []
    case 'right':
      return ['L']
    case 'left':
      return ['R']
    case 'none':
      return filter === 'left' ? ['L'] : filter === 'right' ? ['R'] : ['L', 'R']
  }
}

function learnerHands(hands: HandSelection): readonly Hand[] {
  return hands === 'both' ? ['L', 'R'] : hands === 'right' ? ['R'] : hands === 'left' ? ['L'] : []
}

interface Draft {
  readonly at: Rational
  offsetSec: number
  end: Rational
  velocity: number
  readonly note: number
  readonly hand: Hand
  readonly notes: number[]
}

/** Sorted automatic-part events for the transport. */
export function buildPerformance(model: ScoreModel, options: PerformanceOptions): PerformanceEvent[] {
  const range = options.range ?? passageRange(model, null)
  if (!lt(range.start, range.end)) return []
  const auto = automaticHands(options.hands, options.listenFilter)
  if (auto.length === 0) return []
  const level = options.accompanimentLevel ?? 1
  if (!Number.isFinite(level) || level < 0) throw new RangeError(`Invalid accompaniment level ${level}`)

  const events: PerformanceEvent[] = []
  if (level > 0) buildNotes(model, options.hands, auto, range, level, events)
  if (options.sendPedals) buildPedals(model.pedals, range, events)
  return events.sort(compareEvents)
}

/** Clip a tie chain to the range: attack position (boundary-adjusted) and release position. */
function clip(onset: Rational, length: Rational, range: PerformanceRange): { at: Rational; end: Rational } | null {
  const end = min(add(onset, length), range.end)
  if (!lt(onset, range.end)) return null
  const at = lt(onset, range.start) ? range.start : onset
  return lt(at, end) ? { at, end } : null
}

function buildNotes(
  model: ScoreModel,
  hands: HandSelection,
  auto: readonly Hand[],
  range: PerformanceRange,
  level: number,
  out: PerformanceEvent[],
): void {
  const learner = learnerHands(hands)
  const learnerAttacks = new Set<string>()
  for (const n of model.notes) {
    if (n.grace || n.cue || n.tieHead !== n.index || !learner.includes(n.hand)) continue
    const c = clip(n.onset, n.soundingDuration, range)
    // A learner tie chain begun before the range start is not attacked there (E16): no suppression.
    if (c && lt(n.onset, range.start) && gt(n.soundingDuration, n.duration)) continue
    if (c) learnerAttacks.add(`${key(c.at)}|${n.midi}`)
  }

  const drafts = new Map<string, Draft>()
  for (const n of model.notes) {
    if (n.grace || n.cue || n.tieHead !== n.index || !auto.includes(n.hand)) continue
    const c = clip(n.onset, n.soundingDuration, range)
    if (!c) continue
    const k = `${key(c.at)}|${n.midi}`
    if (learnerAttacks.has(k)) continue
    const offsetSec = lt(n.onset, range.start) ? 0 : Math.max(0, n.refOffsetSec)
    const d = drafts.get(k)
    if (d) {
      d.offsetSec = Math.min(d.offsetSec, offsetSec)
      d.velocity = Math.max(d.velocity, n.velocity)
      if (gt(c.end, d.end)) d.end = c.end
      d.notes.push(n.index)
    } else {
      drafts.set(k, {
        at: c.at,
        offsetSec,
        end: c.end,
        velocity: n.velocity,
        note: n.midi,
        hand: n.hand,
        notes: [n.index],
      })
    }
  }

  let voice = 0
  for (const d of drafts.values()) {
    const velocity = Math.max(1, Math.min(127, Math.round(d.velocity * level)))
    const on: NoteOnEvent = {
      kind: 'on',
      position: d.at,
      offsetSec: d.offsetSec,
      note: d.note,
      velocity,
      voice,
      hand: d.hand,
      notes: d.notes,
    }
    const off: NoteOffEvent = { kind: 'off', position: d.end, offsetSec: 0, note: d.note, voice }
    out.push(on, off)
    voice++
  }
}

function buildPedals(marks: readonly PedalMark[], range: PerformanceRange, out: PerformanceEvent[]): void {
  const sorted = marks.map((m, i) => ({ m, i })).sort((a, b) => cmp(a.m.at, b.m.at) || a.i - b.i)
  const kinds = ['sustain', 'sostenuto', 'soft'] as const
  const state: Record<PedalKind, number> = { sustain: 0, sostenuto: 0, soft: 0 }
  const lastUp: Record<PedalKind, string> = { sustain: '', sostenuto: '', soft: '' }
  const cc = (position: Rational, kind: PedalKind, value: number, offsetSec = 0): void => {
    const ev: ControlEvent = { kind: 'cc', position, offsetSec, controller: PEDAL_CONTROLLERS[kind], value }
    out.push(ev)
    if (value === 0) lastUp[kind] = key(position)
  }
  let i = 0
  // Marks up to and including the range start only shape the state the passage starts with.
  for (; i < sorted.length && !gt(sorted[i]!.m.at, range.start); i++) {
    const m = sorted[i]!.m
    if (m.type === 'start' || m.type === 'change') state[m.kind] = clampDown(m.value)
    else if (m.type === 'stop') state[m.kind] = 0
  }
  for (const kind of kinds) if (state[kind] > 0) cc(range.start, kind, state[kind])
  for (; i < sorted.length && lt(sorted[i]!.m.at, range.end); i++) {
    const m = sorted[i]!.m
    const down = clampDown(m.value)
    const was = state[m.kind]
    switch (m.type) {
      case 'start': {
        // A start while already down is a re-pedal; a start right after a stop is a change.
        if (was > 0) cc(m.at, m.kind, 0)
        const gap = was > 0 || lastUp[m.kind] === key(m.at) ? PEDAL_CHANGE_GAP_SEC : 0
        cc(m.at, m.kind, down, gap)
        state[m.kind] = down
        break
      }
      case 'stop':
        if (was > 0) cc(m.at, m.kind, 0)
        state[m.kind] = 0
        break
      case 'change':
        cc(m.at, m.kind, 0)
        cc(m.at, m.kind, down, PEDAL_CHANGE_GAP_SEC)
        state[m.kind] = down
        break
      case 'continue':
        break
    }
  }
  for (const kind of kinds) if (state[kind] > 0) cc(range.end, kind, 0)
}

function clampDown(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 127
  return Math.max(1, Math.min(127, Math.round(value)))
}

/** Rank at one instant: releases first, then pedal up, pedal down, attacks. */
export function eventRank(ev: PerformanceEvent | { readonly kind: 'click' }): number {
  switch (ev.kind) {
    case 'off':
      return 0
    case 'cc':
      return ev.value < 64 ? 1 : 2
    case 'click':
      return 3
    case 'on':
      return 4
  }
}

function compareEvents(a: PerformanceEvent, b: PerformanceEvent): number {
  return (
    cmp(a.position, b.position) ||
    a.offsetSec - b.offsetSec ||
    eventRank(a) - eventRank(b) ||
    (a.kind === 'cc' ? a.controller : a.note) - (b.kind === 'cc' ? b.controller : b.note)
  )
}
