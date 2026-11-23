import { msg } from '../../i18n/messages'
import type { ScoreModel } from '../../core/model/score'
import { beatText, describePassage, normalizePassage, positionText } from '../../core/model/passage'
import { cmp, isZero, ZERO, type Rational } from '../../core/music/rational'
import type { PieceRecord } from '../../core/storage/records'
import { formatSpeedPercent } from '../../ui/speed'
import { formatLastSpeed, formatRelativeTime } from './format'

/** An import alone is not a practice session, even though it receives a last-opened time. */
export function hasPracticeContext(piece: PieceRecord): boolean {
  return piece.resume !== null || piece.repeatOpen === true
}

/** The list is ordered by last opened; Study also changes that order, so never call it last practiced. */
export function continuingPiece(pieces: readonly PieceRecord[]): PieceRecord | undefined {
  return pieces.find(hasPracticeContext)
}

/**
 * Never opened since it was added: an import (and a copy) stores `lastOpenedAt === createdAt`,
 * the initial pieces store `lastOpenedAt <= createdAt`, and every open (Practice, Study, a
 * suggestion, Open existing piece, Add and open) stores a later time.
 */
export function neverOpened(piece: Pick<PieceRecord, 'createdAt' | 'lastOpenedAt'>): boolean {
  return piece.lastOpenedAt <= piece.createdAt
}

/**
 * An ordinary row's status line, from the piece record alone. "Opened", never "practiced":
 * Study updates `lastOpenedAt` too (DECISIONS L9).
 */
export function openedStatus(piece: Pick<PieceRecord, 'createdAt' | 'lastOpenedAt'>, now: number): string {
  return neverOpened(piece) ? msg('Not opened yet') : msg('Opened {0}', formatRelativeTime(piece.lastOpenedAt, now))
}

const HANDS = { both: 'both hands', right: 'right hand', left: 'left hand', none: 'listening' } as const
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

/** "Bar 9" on beat 1, else "Bar 9, beat 3" (`positionText` always names the beat). */
function resumeText(score: ScoreModel, position: Rational): string {
  const text = positionText(score, position)
  const beat = beatText(score, position)
  const suffix = msg(', beat {0}', beat)
  return beat === '1' && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text
}

/**
 * The Continue practice card's one context line: where it resumes, the hands, and the speed
 * unless it is 100% ("From bar 9 · right hand · 80% speed", "Repeat bars 5–8 · both hands").
 * Printed bar numbers and repeat passes come from the package, never from occurrence indexes.
 */
export function continuationContext(piece: PieceRecord, score: ScoreModel | null): string {
  let position: string
  if (piece.repeatOpen) {
    position = piece.lastPassage
      ? score
        ? msg(
            'Repeat {0}',
            lowerFirst(describePassage(score, normalizePassage(score, piece.lastPassage), piece.lastHands)),
          )
        : msg('Repeat saved passage')
      : msg('Repeat whole piece')
  } else {
    const resume = piece.resume?.position
    position =
      resume && isZero(resume)
        ? msg('From the start')
        : score &&
            score.occurrences.length > 0 &&
            resume &&
            cmp(resume, ZERO) > 0 &&
            cmp(resume, score.totalDuration) < 0
          ? msg('From {0}', lowerFirst(resumeText(score, resume)))
          : msg('Saved position')
  }
  const parts = [position, msg(HANDS[piece.lastHands])]
  if (formatSpeedPercent(piece.lastMultiplier) !== formatSpeedPercent(1))
    parts.push(formatLastSpeed(piece.lastMultiplier))
  return parts.join(' · ')
}
