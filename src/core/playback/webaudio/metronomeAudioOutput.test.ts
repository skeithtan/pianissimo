/**
 * `metronomeAudioOutput` with a selectable output device (DECISIONS U114): a fake AudioContext
 * with `setSinkId`, and a navigator that can list devices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAudioContext } from '../fakeWebAudio'

/** A device context: `setSinkId` fails for the ids in `failing`. */
class SinkContext extends FakeAudioContext {
  static created: SinkContext[] = []
  static failing = new Set<string>()
  readonly sinks: string[] = []
  closes = 0
  constructor() {
    super()
    SinkContext.created.push(this)
  }
  setSinkId(id: string): Promise<void> {
    this.sinks.push(id)
    return SinkContext.failing.has(id) ? Promise.reject(new Error('NotFoundError')) : Promise.resolve()
  }
  close(): Promise<void> {
    this.state = 'closed'
    this.closes++
    return Promise.resolve()
  }
}

/** A fresh module (its selection state is module-level), with system audio already created. */
async function load(): Promise<typeof import('./metronomeOutput')> {
  vi.resetModules()
  const { sharedAudioContext } = await import('./context')
  sharedAudioContext(() => new FakeAudioContext() as unknown as AudioContext)
  return import('./metronomeOutput')
}

beforeEach(() => {
  SinkContext.created = []
  SinkContext.failing = new Set()
  vi.stubGlobal('AudioContext', SinkContext)
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => [] } })
})
afterEach(() => vi.unstubAllGlobals())

describe('metronomeAudioOutput', () => {
  it('selects the device and shares one request between overlapping callers', async () => {
    const { metronomeAudioOutput } = await load()
    const [a, b] = await Promise.all([metronomeAudioOutput('dev-1'), metronomeAudioOutput('dev-1')])
    expect(SinkContext.created).toHaveLength(1)
    expect(SinkContext.created[0]!.sinks).toEqual(['dev-1'])
    expect(a).toEqual({ context: SinkContext.created[0], deviceSelected: true })
    expect(b).toEqual(a)
  })

  it('does not try a device that failed again until another device is configured', async () => {
    SinkContext.failing.add('dev-1')
    const { metronomeAudioOutput } = await load()
    const first = await metronomeAudioOutput('dev-1')
    expect(first.deviceSelected).toBe(false)
    expect(first.context.state).toBe('running')
    // Every later Start (the tap, then the load) gets system audio at once: no new context.
    const again = metronomeAudioOutput('dev-1')
    expect(again).not.toBeInstanceOf(Promise)
    expect((await again).deviceSelected).toBe(false)
    await metronomeAudioOutput('dev-1')
    expect(SinkContext.created).toHaveLength(1)
    expect(SinkContext.created[0]!.closes).toBe(1)
    // A changed setting forgets the failure: choosing the device again tries it once more.
    await metronomeAudioOutput(null)
    await metronomeAudioOutput('dev-1')
    expect(SinkContext.created).toHaveLength(2)
  })

  it('a request overtaken by another device gets system audio and is not remembered as failed', async () => {
    SinkContext.failing.add('dev-1')
    const { metronomeAudioOutput } = await load()
    const a = metronomeAudioOutput('dev-1')
    const b = metronomeAudioOutput('dev-2')
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.deviceSelected).toBe(false)
    expect(ra.context.state).toBe('running')
    expect(rb).toEqual({ context: SinkContext.created[1], deviceSelected: true })
    SinkContext.failing.delete('dev-1')
    expect(await metronomeAudioOutput('dev-1')).toMatchObject({ deviceSelected: true })
    expect(SinkContext.created).toHaveLength(3)
  })
})
