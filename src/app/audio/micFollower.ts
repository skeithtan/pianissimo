/**
 * The microphone follower (DECISIONS P15): opens the microphone with `getUserMedia`, captures it
 * through an AudioWorklet (`public/mic-processor.js`) and streams the samples to a worker that
 * runs `core/audio`'s score follower; its position estimates come back to the session, which
 * releases play-through gates from them. Both hands only (the session never lets the microphone
 * hear the app's own playback). Everything browser-specific is injectable for tests.
 */
import type { FollowerRequest, FollowerResponse } from '../../core/audio/protocol'
import type { ScoreModel } from '../../core/model/score'
import type { Rational } from '../../core/music/rational'
import type { TempoMapData } from '../../core/music/tempo'
import type { CreateMicFollower, MicEstimate, MicFollowerLike } from '../session/types'

export const MIC_NOT_SUPPORTED = 'This browser cannot use the microphone here.'
export const MIC_DENIED = 'Microphone access was not allowed. Allow it for this site, then press Start again.'
export const MIC_FAILED = 'The microphone could not be started.'

/** What the follower needs from a worker. */
export interface FollowerWorkerLike {
  postMessage(message: FollowerRequest, transfer?: Transferable[]): void
  onmessage: ((event: { data: FollowerResponse }) => void) | null
  onerror: ((event: { message?: string }) => void) | null
  terminate(): void
}

/** What the follower needs from the worklet node's port. */
export interface SamplePortLike {
  onmessage: ((event: { data: { samples: Float32Array; sampleRate: number } }) => void) | null
}

export interface MicCapture {
  /** Samples arrive here from the worklet. */
  readonly port: SamplePortLike
  /** Closes the stream, the node and the context. */
  readonly close: () => void
}

export interface MicFollowerOptions {
  readonly createWorker?: () => FollowerWorkerLike
  /** Opens the microphone and the worklet; rejects with a user-facing message. */
  readonly capture?: () => Promise<MicCapture>
  readonly log?: (message: string, detail?: unknown) => void
}

const MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
}

/** Opens the real microphone: `getUserMedia` → `AudioContext` → the worklet node. */
export async function captureMicrophone(): Promise<MicCapture> {
  const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
  const Node = (globalThis as { AudioWorkletNode?: typeof AudioWorkletNode }).AudioWorkletNode
  if (!devices?.getUserMedia || !Context || !Node) throw new Error(MIC_NOT_SUPPORTED)
  let stream: MediaStream
  try {
    stream = await devices.getUserMedia(MEDIA_CONSTRAINTS)
  } catch (e) {
    const name = e instanceof DOMException ? e.name : ''
    throw new Error(name === 'NotAllowedError' || name === 'SecurityError' ? MIC_DENIED : MIC_FAILED)
  }
  const ctx = new Context()
  try {
    if (!ctx.audioWorklet) throw new Error(MIC_NOT_SUPPORTED)
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}mic-processor.js`)
    const source = ctx.createMediaStreamSource(stream)
    const node = new Node(ctx, 'pianissimo-mic', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
    source.connect(node)
    // Silent output: connected only so the browser keeps processing the node.
    node.connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume()
    return {
      // The worklet posts `{ type: 'samples', samples, sampleRate }` (`public/mic-processor.js`).
      port: node.port as unknown as SamplePortLike,
      close: () => {
        node.port.onmessage = null
        node.disconnect()
        source.disconnect()
        for (const track of stream.getTracks()) track.stop()
        void ctx.close()
      },
    }
  } catch (e) {
    for (const track of stream.getTracks()) track.stop()
    void ctx.close()
    throw e instanceof Error && e.message === MIC_NOT_SUPPORTED ? e : new Error(MIC_FAILED)
  }
}

function defaultWorker(): FollowerWorkerLike {
  return new Worker(new URL('../../workers/follower.worker.ts', import.meta.url), {
    type: 'module',
    name: 'pianissimo-follower',
  }) as unknown as FollowerWorkerLike
}

export function createMicFollower(
  model: ScoreModel,
  tempo: TempoMapData,
  multiplier: number,
  onEstimate: (estimate: MicEstimate) => void,
  options: MicFollowerOptions = {},
): MicFollowerLike {
  const log = options.log ?? ((message: string, detail?: unknown) => console.error(message, detail))
  let worker: FollowerWorkerLike | null = null
  let capture: MicCapture | null = null
  let disposed = false
  let speed = multiplier
  let last: Rational | null = null

  const send = (message: FollowerRequest, transfer?: Transferable[]): void => {
    if (!disposed) worker?.postMessage(message, transfer)
  }

  return {
    async start(position) {
      if (disposed || worker) return
      last = position
      const w = (options.createWorker ?? defaultWorker)()
      worker = w
      w.onmessage = (event) => {
        if (disposed || worker !== w) return
        const data = event.data
        if (data.type === 'estimate') onEstimate({ position: data.position, confidence: data.confidence })
        else log(`Microphone follower: ${data.message}`)
      }
      w.onerror = (event) => log(`Microphone follower worker failed: ${event.message ?? 'no message'}`)
      w.postMessage({ type: 'configure', model, tempo, multiplier: speed, position })
      let c: MicCapture
      try {
        c = await (options.capture ?? captureMicrophone)()
      } catch (e) {
        this.dispose()
        throw e
      }
      if (disposed) {
        c.close()
        return
      }
      capture = c
      c.port.onmessage = (event) => {
        const { samples, sampleRate } = event.data
        send({ type: 'samples', samples, sampleRate }, [samples.buffer])
      }
    },
    reset(position) {
      last = position
      send({ type: 'reset', position })
    },
    pause() {
      send({ type: 'pause' })
    },
    resume() {
      send({ type: 'resume' })
    },
    setMultiplier(next) {
      if (next === speed) return
      speed = next
      send({ type: 'configure', model, tempo, multiplier: next, position: last })
    },
    dispose() {
      if (disposed) return
      disposed = true
      capture?.close()
      capture = null
      worker?.terminate()
      worker = null
    },
  }
}

export const createMicFollowerDep: CreateMicFollower = (model, tempo, multiplier, onEstimate) =>
  createMicFollower(model, tempo, multiplier, onEstimate)
