import { onsetPositions, passageFromBounds } from '../../core/model/passage'
import type { PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { type Rational, eq } from '../../core/music/rational'
import { clampPassage } from './selection'

/**
 * The loop for drilling the place at `position`: from two onsets of the selected hands before
 * it to the end of the onset after it, so the player plays into the spot and out of it. Fewer
 * onsets are taken where the piece starts or ends nearby. Null when `position` is not an onset
 * of the selected hands or the piece has fewer than two such onsets.
 */
export function drillRange(model: ScoreModel, hands: HandSelection, position: Rational): PassageRange | null {
  const onsets = onsetPositions(model, hands)
  if (onsets.length < 2) return null
  const idx = onsets.findIndex((o) => eq(o, position))
  if (idx < 0) return null
  const start = onsets[Math.max(0, idx - 2)]!
  const end = idx + 2 < onsets.length ? onsets[idx + 2]! : model.totalDuration
  return clampPassage(model, passageFromBounds(model, start, end))
}
