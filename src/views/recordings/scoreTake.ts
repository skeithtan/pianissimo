import type { ScoreModel } from '../../core/model/score'
import { buildTimeline } from '../../core/engine/timeline'
import type { PassageRange } from '../../core/model/practice'
import { playedThrough, scorePerformance, type NoteScore } from '../../core/recording/performance'
import type { RecordingInfo } from '../../core/recording/records'

export interface TakeScore {
  readonly score: NoteScore
  readonly playedThrough: boolean
}

/** What a take of this passage is compared with. */
export function takeTimeline(model: ScoreModel, hands: RecordingInfo['hands'], range: PassageRange | null) {
  return buildTimeline(model, { hands, range, multiplier: 1, reattackHeldAtStart: false })
}

function inWorker(groups: readonly (readonly number[])[], played: readonly number[]): Promise<TakeScore> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/recordingScore.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<TakeScore>) => {
      worker.terminate()
      resolve(e.data)
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message))
    }
    worker.postMessage({ groups, played })
  })
}

export async function scoreTake(groups: readonly (readonly number[])[], played: readonly number[]): Promise<TakeScore> {
  try {
    return await inWorker(groups, played)
  } catch {
    return { score: scorePerformance(groups, played), playedThrough: playedThrough(groups, played) }
  }
}
