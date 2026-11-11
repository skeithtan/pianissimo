import { describe, expect, it } from 'vitest'
import type { FollowerRequest, FollowerResponse } from '../../core/audio/protocol'
import { buildScore } from '../../core/engine/testkit'
import { rat } from '../../core/music/rational'
import type { MicEstimate } from '../session/types'
import { type FollowerWorkerLike, MIC_FAILED, MIC_LOST, type MicCapture, createMicFollower } from './micFollower'

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
  let woken = 0
  let captureLost: (() => void) | null = null
  const capture = async (onLost: () => void): Promise<MicCapture> => {
    if (captureFails) throw captureFails
    captureLost = onLost
    return { port, close: () => closed++, wake: () => woken++ }
  }
  const estimates: MicEstimate[] = []
  const lost: string[] = []
  const logs: string[] = []
  const mic = createMicFollower(
    model,
    (e) => estimates.push(e),
    (reason) => lost.push(reason),
    { createWorker: () => worker, capture, log: (m) => logs.push(m) },
  )
  return {
    worker,
    port,
    mic,
    estimates,
    lost,
    logs,
    closed: () => closed,
    woken: () => woken,
    loseCapture: () => captureLost?.(),
  }
}

describe('createMicFollower', () => {
  it('configures the worker, opens the capture and relays samples and estimates', async () => {
    const { worker, port, mic, estimates, closed, woken } = setup()
    await mic.start(rat(1, 4))
    expect(worker.posted).toEqual([{ type: 'configure', model, position: rat(1, 4) }])
    expect(port.onmessage).not.toBeNull()
    const samples = new Float32Array(512)
    port.onmessage!({ data: { samples, sampleRate: 48000 } })
    expect(worker.posted[1]).toEqual({ type: 'samples', samples, sampleRate: 48000 })
    expect(worker.transfers[1]).toEqual([samples.buffer])
    worker.onmessage!({ data: { type: 'estimate', position: 0.5, confidence: 0.7 } })
    expect(estimates).toEqual([{ position: 0.5, confidence: 0.7 }])
    mic.reset(rat(1, 2))
    mic.pause()
    expect(woken()).toBe(0)
    mic.resume()
    // Start is a user gesture: a context the system suspended is asked back there.
    expect(woken()).toBe(1)
    expect(worker.posted.slice(2)).toEqual([
      { type: 'reset', position: rat(1, 2) },
      { type: 'pause' },
      { type: 'resume' },
    ])
    expect(closed()).toBe(0)
    mic.dispose()
    expect(closed()).toBe(1)
    expect(worker.terminated).toBe(true)
    mic.reset(rat(3, 4))
    worker.onmessage!({ data: { type: 'estimate', position: 0.75, confidence: 0.9 } })
    expect(worker.posted.length).toBe(5)
    expect(estimates.length).toBe(1)
    mic.dispose()
    expect(closed()).toBe(1)
  })

  it('rejects start with the capture reason and leaves nothing open', async () => {
    const { worker, mic, closed, lost } = setup(new Error('Microphone access was not allowed.'))
    await expect(mic.start(rat(0))).rejects.toThrow('Microphone access was not allowed.')
    expect(worker.terminated).toBe(true)
    expect(closed()).toBe(0)
    expect(lost).toEqual([])
  })

  it('reports a capture that ends by itself once, with what to do', async () => {
    const { mic, lost, loseCapture } = setup()
    await mic.start(rat(0))
    loseCapture()
    loseCapture()
    expect(lost).toEqual([MIC_LOST])
    mic.dispose()
    loseCapture()
    expect(lost.length).toBe(1)
  })

  it('logs a failing worker and gives up instead of reporting positions', async () => {
    const { worker, mic, estimates, lost, logs } = setup()
    await mic.start(rat(0))
    worker.onmessage!({ data: { type: 'error', message: 'boom in the follower' } })
    worker.onmessage!({ data: { type: 'error', message: 'boom in the follower' } })
    worker.onmessage!({ data: { type: 'estimate', position: 0.25, confidence: 0.9 } })
    worker.onerror!({ message: 'boom' })
    expect(estimates).toEqual([])
    expect(lost).toEqual([MIC_FAILED])
    expect(logs).toEqual(['Microphone follower: boom in the follower', 'Microphone follower worker failed: boom'])
  })
})
