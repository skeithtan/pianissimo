/**
 * Microphone follower worker entry (DECISIONS P15): the audio score follower runs here so the
 * main thread never analyzes audio. All logic lives in `core/audio/workerHandler.ts`.
 */
import { createFollowerWorkerHandler } from '../core/audio/workerHandler'
import type { FollowerRequest } from '../core/audio/protocol'

declare const self: DedicatedWorkerGlobalScope

const handle = createFollowerWorkerHandler((message) => self.postMessage(message))

self.onmessage = (event: MessageEvent<FollowerRequest>) => {
  handle(event.data)
}
