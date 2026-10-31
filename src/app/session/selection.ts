/**
 * What the learner selected (hands, passage, speed) and what it allows: the engine timeline,
 * scored-practice blockers in plain language and the passage summary shown before Start
 * (spec "Repeating passages": "Show the selected hand, measure range, repeat occurrence, and
 * practice tempo before starting. If the selected hand has no required onsets in the passage,
 * disable scored practice and explain why; retain Listen and selection controls.").
 */
import { buildTimeline, type LearnerHands, type Timeline } from '../../core/engine'
import { describePassage, normalizePassage, passageBounds, samePassage } from '../../core/model/passage'
import type { PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { beatUnitGlyph, effectiveTempoAt, hasTempo, type TempoMapData } from '../../core/music/tempo'

export interface Selection {
  readonly hands: HandSelection
  /**
   * Inclusive passage, optionally with note-level edges (U21); null = no passage (ordinary reading
   * of the whole piece, DECISIONS P1).
   */
  readonly range: PassageRange | null
  readonly multiplier: number
}

/** Same bars and the same exact edges. */
export const sameRange = samePassage

export function sameSelection(a: Selection, b: Selection): boolean {
  return a.hands === b.hands && a.multiplier === b.multiplier && sameRange(a.range, b.range)
}

/**
 * Clamp a passage to the piece (`normalizePassage`): bars ordered and clamped, note-level edges
 * kept only strictly inside their bars; null when the piece has no bars.
 */
export function clampPassage(model: ScoreModel, range: PassageRange | null): PassageRange | null {
  return normalizePassage(model, range)
}

/** The learner timeline for a selection. Preview ('none') keeps a both-hands timeline for the cursor. */
export function selectionTimeline(model: ScoreModel, tempo: TempoMapData, sel: Selection): Timeline {
  const hands: LearnerHands = sel.hands === 'none' ? 'both' : sel.hands
  return buildTimeline(model, { hands, range: sel.range, multiplier: sel.multiplier, tempo })
}

export const HAND_TEXT: Readonly<Record<HandSelection, string>> = {
  both: 'Both hands',
  right: 'Right hand',
  left: 'Left hand',
  none: 'Preview',
}

/** "Bars 5–8", "Bar 12 (pass 2)", "Bar 12, beat 3 – bar 14", "Whole piece" (`describePassage`). */
export function rangeText(model: ScoreModel, range: PassageRange | null, hands: HandSelection = 'both'): string {
  return describePassage(model, range, hands)
}

/** "♩ = 72" at the passage start under the multiplier; null without a numerical tempo. */
export function tempoText(model: ScoreModel, tempo: TempoMapData, sel: Selection): string | null {
  if (!hasTempo(tempo)) return null
  const t = effectiveTempoAt(tempo, passageBounds(model, sel.range).start, sel.multiplier)
  return `${beatUnitGlyph(t.beatUnit)} = ${Math.round(t.beatBpm)}`
}

/** "Right hand · Bars 5–8 · 80% (♩ = 58)". */
export function passageSummary(model: ScoreModel, tempo: TempoMapData, sel: Selection): string {
  const pct = `${Math.round(sel.multiplier * 100)}%`
  const t = tempoText(model, tempo, sel)
  return [HAND_TEXT[sel.hands], rangeText(model, sel.range, sel.hands), t ? `${pct} (${t})` : pct].join(' · ')
}

/** Why the main button cannot start what it would start; null when it can. */
export interface StartPlan {
  readonly action: 'reading' | 'scored' | 'listen'
  readonly enabled: boolean
  readonly reason: string | null
}

export interface StartContext {
  /** App playback can go somewhere now: the piano, or this device's sound (DECISIONS S4). */
  readonly hasOutput: boolean
  /** Why it cannot, in words (`noPlaybackReason`). */
  readonly noOutputReason?: string | null
  /** One-hand grading allowed on this route (verified, echo-free output or browser sound). */
  readonly accompanimentAllowed: boolean
  readonly hasTempo: boolean
}

export function startPlan(timeline: Timeline, sel: Selection, ctx: StartContext): StartPlan {
  const noOutput = ctx.noOutputReason ?? 'Nothing can play sound here.'
  if (sel.hands === 'none') {
    if (!ctx.hasOutput) return { action: 'listen', enabled: false, reason: `${noOutput} Listen is not available.` }
    if (!ctx.hasTempo) return { action: 'listen', enabled: false, reason: 'Set a practice tempo to listen.' }
    return { action: 'listen', enabled: true, reason: null }
  }
  const action = sel.range ? 'scored' : 'reading'
  if (!ctx.hasTempo) {
    return {
      action,
      enabled: false,
      reason: 'Set a practice tempo so the score can follow the timing.',
    }
  }
  if (sel.hands !== 'both') {
    if (!ctx.hasOutput) {
      return {
        action,
        enabled: false,
        reason: `One-hand practice needs the piano or this device to play the other hand. ${noOutput}`,
      }
    }
    if (!ctx.accompanimentAllowed) {
      return {
        action,
        enabled: false,
        reason:
          'Graded one-hand practice needs a verified output with no echo. Run the playback and echo tests in Connection, or practice both hands.',
      }
    }
  }
  if (timeline.groups.length === 0) {
    return {
      action,
      enabled: false,
      reason: `${HAND_TEXT[sel.hands]} has no notes to play here. Choose other hands or bars; Listen still works.`,
    }
  }
  if (action === 'scored' && !timeline.scoredAllowed) {
    const first = timeline.blockers[0]
    return {
      action,
      enabled: false,
      reason: first ? first.message : 'Scored practice is not available for this passage.',
    }
  }
  return { action, enabled: true, reason: null }
}
