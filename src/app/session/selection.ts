import { msg, percentage } from '../../i18n/messages'
/**
 * What the learner selected (hands, passage, speed) and what it allows: the engine timeline,
 * scored-practice blockers in plain language and the passage summary shown before Start
 * (spec "Repeating passages": "Show the selected hand, measure range, repeat occurrence, and
 * practice tempo before starting. If the selected hand has no required onsets in the passage,
 * disable scored practice and explain why; retain Listen and selection controls.").
 */
import { buildTimeline, type Timeline, type TimelineOptions } from '../../core/engine'
import { describePassage, normalizePassage, passageBounds, samePassage } from '../../core/model/passage'
import type { PassageRange, PracticeMode } from '../../core/model/practice'
import type { LearnerHands, ScoreModel } from '../../core/model/score'
import { beatUnitGlyph, effectiveTempoAt, hasTempo, type TempoMapData } from '../../core/music/tempo'
import type { OtherHandSound } from './types'

export interface Selection {
  /** The hands the learner plays; in Listen, the hands they hear. */
  readonly hands: LearnerHands
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

/** The onset groups of the selected hands in the selected passage (all of them in Listen too: the cursor's stops). */
export function selectionTimeline(
  model: ScoreModel,
  tempo: TempoMapData,
  sel: Selection,
  options: Pick<TimelineOptions, 'reattackHeldAtStart'> = {},
): Timeline {
  return buildTimeline(model, { hands: sel.hands, range: sel.range, multiplier: sel.multiplier, tempo, ...options })
}

export const HAND_TEXT: Readonly<Record<LearnerHands, string>> = {
  both: 'Both hands',
  right: 'Right hand',
  left: 'Left hand',
}

/** "Bars 5–8", "Bar 12 (pass 2)", "Bar 12, beat 3 – bar 14", "Whole piece" (`describePassage`). */
export function rangeText(model: ScoreModel, range: PassageRange | null, hands: LearnerHands = 'both'): string {
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
  const pct = percentage(Math.round(sel.multiplier * 100) / 100)
  const t = tempoText(model, tempo, sel)
  return [msg(HAND_TEXT[sel.hands]), rangeText(model, sel.range, sel.hands), t ? `${pct} (${t})` : pct].join(' · ')
}

/** Why the main button cannot start what it would start; null when it can. */
export interface StartPlan {
  /** `'play'`: Follow (DECISIONS P12), an unscored performance over the whole piece. */
  readonly action: 'reading' | 'scored' | 'listen' | 'play'
  readonly enabled: boolean
  readonly reason: string | null
  /** Only the place where the other hand sounds is missing (P2): the view asks for it (U149). */
  readonly otherHand?: OtherHandSound
}

export interface StartContext {
  /** App playback can go somewhere now: the piano, or this device's sound (DECISIONS S4). */
  readonly hasOutput: boolean
  /** Why it cannot, in words (`noPlaybackReason`). */
  readonly noOutputReason?: string | null
  /** One-hand grading allowed on this route (verified, echo-free output or browser sound). */
  readonly accompanimentAllowed: boolean
  /** Where the other hand could sound, whatever the settings say now. */
  readonly otherHand?: OtherHandSound
  readonly hasTempo: boolean
  /** A piano input is connected (default true): Wait and Keep time need one. */
  readonly hasInput?: boolean
  /** Keep time plays both parts, using a route that is safe for grading. */
  readonly scorePlayback?: boolean
  /**
   * Follow would use the microphone (DECISIONS P15, P22): it needs no piano input, and with one
   * hand the app plays nothing (no output or echo check needed).
   */
  readonly mic?: boolean
}

/**
 * What Start does in `mode` with this selection, and why it cannot. Listen plays the score; Wait
 * reads, or scores the loop in Repeat mode (`sel.range`); Keep time always scores (the loop, or
 * from the cursor to the end); Follow plays through. A missing piano comes before any other reason
 * in Wait and Keep time, so the view can offer to connect one.
 */
export function startPlan(timeline: Timeline, sel: Selection, mode: PracticeMode, ctx: StartContext): StartPlan {
  const noOutput = ctx.noOutputReason ?? msg('Nothing can play sound here.')
  const action =
    mode === 'listen'
      ? 'listen'
      : mode === 'follow'
        ? 'play'
        : mode === 'time' || sel.range !== null
          ? 'scored'
          : 'reading'
  const blocked = (reason: string): StartPlan => ({ action, enabled: false, reason })
  const noNotes = () =>
    blocked(msg('{0} has no notes to play here. Choose other hands or bars.', msg(HAND_TEXT[sel.hands])))

  if (action === 'listen') {
    if (!ctx.hasOutput) return blocked(msg('{0} Listen is not available.', noOutput))
    if (!ctx.hasTempo) return blocked(msg('Set a practice tempo to listen.'))
    return timeline.groups.length === 0 ? noNotes() : { action, enabled: true, reason: null }
  }
  if (ctx.hasInput === false) {
    if (mode === 'wait') return blocked(msg('Wait needs a connected piano.'))
    if (mode === 'time') return blocked(msg('Keep time needs a connected piano.'))
    if (!ctx.mic) return blocked(msg('Follow needs a connected piano or a microphone.'))
  }
  if (!ctx.hasTempo) return blocked(msg('Set a practice tempo so the score can follow the timing.'))
  // One hand through the microphone: the app plays nothing (the microphone must never hear it).
  const silent = action === 'play' && ctx.mic === true
  const places = ctx.otherHand ?? { piano: ctx.hasOutput, device: false }
  const asks = sel.hands !== 'both' && !silent && !(ctx.hasOutput && ctx.accompanimentAllowed)
  const otherHand = asks && (places.piano || places.device) ? places : null
  if (asks && !otherHand) {
    return blocked(msg('One-hand practice needs the piano or this device to play the other hand. {0}', noOutput))
  }
  if (!otherHand && mode === 'time' && ctx.scorePlayback && (!ctx.hasOutput || !ctx.accompanimentAllowed)) {
    return blocked(
      ctx.hasOutput
        ? msg(
            'Playback needs an echo-free output. Play the test notes or choose Browser sound in Settings → Piano and sound.',
          )
        : msg('Playback needs a sound output. {0}', noOutput),
    )
  }
  if (timeline.groups.length === 0) return noNotes()
  if (action === 'scored' && !timeline.scoredAllowed) {
    return blocked(timeline.blockers[0]?.message ?? msg('Scored practice is not available for this passage.'))
  }
  if (otherHand) return { action, enabled: false, reason: null, otherHand }
  return { action, enabled: true, reason: null }
}
