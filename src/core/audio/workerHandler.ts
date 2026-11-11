/**
 * The microphone follower's worker side (DECISIONS P15): owns an `AudioFollower`, feeds it the
 * sample blocks the AudioWorklet captured and posts where the player was heard. Pure and
 * worker-safe; `workers/follower.worker.ts` binds it to the worker global.
 */
import { ZERO } from '../music/rational'
import { type AudioFollower, type AudioFollowerOptions, createAudioFollower } from './index'
import type { FollowerRequest, FollowerResponse } from './protocol'

export function createFollowerWorkerHandler(
  post: (response: FollowerResponse) => void,
  options: AudioFollowerOptions = {},
): (request: FollowerRequest) => void {
  let follower: AudioFollower | null = null
  let paused = false
  return (request) => {
    try {
      switch (request.type) {
        case 'configure': {
          follower = createAudioFollower(request.model, options)
          follower.reset(request.position ?? ZERO)
          paused = false
          return
        }
        case 'reset':
          follower?.reset(request.position)
          return
        case 'pause':
          paused = true
          return
        case 'resume':
          // Only after a pause: the samples skipped meanwhile leave a gap in the stream.
          if (paused) follower?.listen()
          paused = false
          return
        case 'samples': {
          if (!follower || paused) return
          const est = follower.push(request.samples, request.sampleRate, 0)
          if (est.moved) post({ type: 'estimate', position: est.position, confidence: est.confidence })
          return
        }
      }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
}
