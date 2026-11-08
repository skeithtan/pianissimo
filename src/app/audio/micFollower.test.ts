import { describe, expect, it } from 'vitest'
import type { FollowerRequest, FollowerResponse } from '../../core/audio/protocol'
import { buildScore } from '../../core/engine/testkit'
import { rat } from '../../core/music/rational'
import type { MicEstimate } from '../session/types'
import { type FollowerWorkerLike, type MicCapture, createMicFollower } from './micFollower'

const model = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
  ],
})

class FakeWorker implements FollowerWorkerLike {
  posted: FollowerRequest[] = []
  transfers: (Transferable[] | undefined)[] = []
  onmessage: ((event: { data: FollowerResponse }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  terminated = false
  postMessage(message: FollowerRequest, transfer?: Transferable[]): void {
    this.posted.push(message)
    this.transfers.push(transfer)
  }
  terminate(): void {
    this.terminated = true
  }
}

function setup(captureFails?: Error) {
  const worker = new FakeWorker()
  const port: MicCapture['port'] = { onmessage: null }
  let closed = 0
  const capture = async (): Promise<MicCapture> => {
    if (captureFails) throw captureFails
    return { port, close: () => closed++ }
  }
  const estimates: MicEstimate[] = []
  const logs: string[] = []
  const mic = createMicFollower(model, model.tempo, 1, (e) => estimates.push(e), {
    createWorker: () => worker,
    capture,
    log: (m) => logs.push(m),
  })
  return { worker, port, mic, estimates, logs, closed: () => closed }
}

describe('createMicFollower', () => {
  it('configures the worker, opens the capture and relays samples and estimates', async () => {
    const { worker, port, mic, estimates, closed } = setup()
    await mic.start(rat(1, 4))
    expect(worker.posted).toEqual([
      { type: 'configure', model, tempo: model.tempo, multiplier: 1, position: rat(1, 4) },
    ])
    expect(port.onmessage).not.toBeNull()
    const samples = new Float32Array(512)
    port.onmessage!({ data: { samples, sampleRate: 48000 } })
    expect(worker.posted[1]).toEqual({ type: 'samples', samples, sampleRate: 48000 })
    expect(worker.transfers[1]).toEqual([samples.buffer])
    worker.onmessage!({ data: { type: 'estimate', position: 0.5, confidence: 0.7 } })
    expect(estimates).toEqual([{ position: 0.5, confidence: 0.7 }])
    mic.reset(rat(1, 2))
    mic.pause()
    mic.resume()
    mic.setMultiplier(0.8)
    mic.setMultiplier(0.8)
    expect(worker.posted.slice(2)).toEqual([
      { type: 'reset', position: rat(1, 2) },
      { type: 'pause' },
      { type: 'resume' },
      { type: 'configure', model, tempo: model.tempo, multiplier: 0.8, position: rat(1, 2) },
    ])
    expect(closed()).toBe(0)
    mic.dispose()
    expect(closed()).toBe(1)
    expect(worker.terminated).toBe(true)
    mic.reset(rat(3, 4))
    worker.onmessage!({ data: { type: 'estimate', position: 0.75, confidence: 0.9 } })
    expect(worker.posted.length).toBe(6)
    expect(estimates.length).toBe(1)
    mic.dispose()
    expect(closed()).toBe(1)
  })

  it('rejects start with the capture reason and leaves nothing open', async () => {
    const { worker, mic, closed } = setup(new Error('Microphone access was not allowed.'))
    await expect(mic.start(rat(0))).rejects.toThrow('Microphone access was not allowed.')
    expect(worker.terminated).toBe(true)
    expect(closed()).toBe(0)
  })

  it('logs worker errors instead of reporting positions', async () => {
    const { worker, mic, estimates, logs } = setup()
    await mic.start(rat(0))
    worker.onmessage!({ data: { type: 'error', message: 'The audio follower needs a tempo' } })
    worker.onerror!({ message: 'boom' })
    expect(estimates).toEqual([])
    expect(logs).toEqual([
      'Microphone follower: The audio follower needs a tempo',
      'Microphone follower worker failed: boom',
    ])
  })
})
