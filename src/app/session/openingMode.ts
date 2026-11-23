/**
 * How a piece opens on the score screen: the mode and the hands its record asks for, for what is
 * connected now. Pure; opening saves nothing.
 */
import type { PracticeMode } from '../../core/model/practice'
import type { HandSelection, LearnerHands } from '../../core/model/score'
import type { PieceRecord } from '../../core/storage/records'

/** Wait and Keep time: what is played on the piano is practice, judged and recorded. */
export function isPractice(mode: PracticeMode): boolean {
  return mode === 'wait' || mode === 'time'
}

export interface OpeningEnv {
  /** A piano input is connected (`connectionStatus` 'connected'). */
  readonly pianoConnected: boolean
  /** A piano was chosen before (`settings.route.inputId`). */
  readonly pianoRemembered: boolean
  /** This browser has Web MIDI (`connectionStatus` is not 'unsupported'). */
  readonly midiSupported: boolean
}

/**
 * The stored mode; else what an older record says (Keep time on, or both hands off: Listen); else
 * Wait with a piano (connected or remembered) and Listen without one. A browser without Web MIDI
 * opens Wait and Keep time as Listen.
 *
 * `practice`: the piece is opened to practice a given passage (a suggestion, Practice again), so
 * Listen and Follow open as Wait.
 */
export function openingMode(
  piece: Pick<PieceRecord, 'mode' | 'rhythm' | 'lastHands'>,
  env: OpeningEnv,
  practice = false,
): PracticeMode {
  const stored = recordedMode(piece) ?? (env.pianoConnected || env.pianoRemembered ? 'wait' : 'listen')
  const mode = practice && !isPractice(stored) ? 'wait' : stored
  return isPractice(mode) && !env.midiSupported ? 'listen' : mode
}

/** The mode a piece's record asks for (older records included), or null when it asks for none. */
export function recordedMode(piece: Pick<PieceRecord, 'mode' | 'rhythm' | 'lastHands'>): PracticeMode | null {
  if (piece.mode) return piece.mode
  if (piece.rhythm === true) return 'time'
  return piece.lastHands === 'none' ? 'listen' : null
}

/** A stored hand selection as the learner's hands: an older record's 'none' reads as both. */
export function learnerHands(hands: HandSelection): LearnerHands {
  return hands === 'none' ? 'both' : hands
}
