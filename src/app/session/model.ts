/**
 * The model the session practices: the stored package, with the learner's practice tempo
 * applied when the score has no numerical tempo (spec "Missing numerical tempos require user
 * input"; `withUserTempo` also realizes reference roll offsets at that tempo).
 */
import { withUserTempo } from '../../core/import/rolls'
import type { ScoreModel } from '../../core/model/score'
import { hasTempo } from '../../core/music/tempo'
import type { UserTempo } from '../../core/storage/records'

export function practiceModel(model: ScoreModel, userTempo: UserTempo | undefined): ScoreModel {
  if (hasTempo(model.tempo) || !userTempo) return model
  return withUserTempo(model, userTempo.beatBpm, userTempo.beatUnit)
}

/** True when neither the score nor the learner supplied a numerical tempo. */
export function practiceTempoMissing(model: ScoreModel): boolean {
  return !hasTempo(model.tempo)
}
