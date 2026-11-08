/**
 * The microphone follower's worker side (DECISIONS P15): owns an `AudioFollower`, feeds it the
 * sample blocks the AudioWorklet captured and posts position estimates. Pure and worker-safe;
 * `workers/follower.worker.ts` binds it to the worker global.
 */
import { ZERO } from '../music/rational'
import { type AudioFollower, type AudioFollowerOptions, createAudioFollower } from './index'
import type { FollowerRequest, FollowerResponse } from './protocol'

export interface FollowerHandlerOptions extends AudioFollowerOptions {
  /** Post an estimate after this many analyzed frames (default 2: every 20 ms of audio). */
  readonly every?: number
}

export function createFollowerWorkerHandler(
  post: (response: FollowerResponse) => void,
  options: FollowerHandlerOptions = {},
): (request: FollowerRequest) => void {
  const every = Math.max(1, options.every ?? 2)
  let follower: AudioFollower | null = null
  let paused = false
  let sinceSent = 0
  return (request) => {
    try {
      switch (request.type) {
        case 'configure': {
          follower = createAudioFollower(request.model, request.tempo, request.multiplier, options)
          follower.reset(request.position ?? ZERO)
          paused = false
          sinceSent = 0
          return
        }
        case 'reset':
          follower?.reset(request.position)
          sinceSent = 0
          return
        case 'pause':
          paused = true
          return
        case 'resume':
          paused = false
          sinceSent = 0
          return
        case 'samples': {
          if (!follower || paused) return
          const est = follower.push(request.samples, request.sampleRate, 0)
          sinceSent += est.frames
          if (sinceSent < every) return
          sinceSent = 0
          post({ type: 'estimate', position: est.position, confidence: est.confidence })
          return
        }
      }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
}
