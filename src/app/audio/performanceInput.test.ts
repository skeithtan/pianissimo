import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingSettings } from '../../core/model/settings'
import { RecordingError, openPerformanceInput } from './performanceInput'

interface FakeTrack {
  readonly label: string
  readyState: string
  stopped: boolean
  getSettings(): { deviceId: string; channelCount: number }
  stop(): void
  addEventListener(type: string, listener: () => void): void
}

const INTERNAL = { kind: 'audioinput', deviceId: 'internal', label: 'Tablet microphone' }
const USB = { kind: 'audioinput', deviceId: 'usb', label: 'Fake Piano' }
const REMEMBERED: RecordingSettings = { inputId: 'usb', inputLabel: 'Fake Piano' }

let devices: { kind: string; deviceId: string; label: string }[] = []
let tracks: FakeTrack[] = []
let asked: string[] = []
let contexts: FakeContext[] = []
let posted: unknown[] = []
let getUserMedia: (constraints: MediaStreamConstraints) => Promise<unknown>

class FakeContext {
  state = 'running'
  sampleRate = 48_000
  destination = {}
  onstatechange: (() => void) | null = null
  audioWorklet = { addModule: async () => undefined }
  constructor() {
    contexts.push(this)
  }
  resume = async () => undefined
  close = async () => {
    this.state = 'closed'
  }
  createMediaStreamSource = () => ({ connect: () => undefined })
  createAnalyser = () => ({ fftSize: 32, connect: () => undefined, getFloatTimeDomainData: () => undefined })
}

class FakeNode {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: unknown) => {
      posted.push(message)
      if (message === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: 'stopped' }))
    },
    close: () => undefined,
  }
  onprocessorerror: (() => void) | null = null
  connect = () => undefined
}

function streamOf(device: { deviceId: string; label: string }) {
  const track: FakeTrack = {
    label: device.label,
    readyState: 'live',
    stopped: false,
    getSettings: () => ({ deviceId: device.deviceId, channelCount: 2 }),
    stop() {
      track.stopped = true
    },
    addEventListener: () => undefined,
  }
  tracks.push(track)
  return { getTracks: () => [track], getAudioTracks: () => [track] }
}

const wantedId = (constraints: MediaStreamConstraints): string => {
  const audio = constraints.audio
  return typeof audio === 'object' ? ((audio.deviceId as { exact?: string } | undefined)?.exact ?? '') : ''
}

const named = (name: string) => Object.assign(new Error('raw browser text'), { name })

beforeEach(() => {
  devices = [INTERNAL, USB]
  tracks = []
  asked = []
  contexts = []
  posted = []
  // A real browser's answer: the device with that ID, else none; without an ID, the first.
  getUserMedia = async (constraints) => {
    const id = wantedId(constraints)
    const device = id ? devices.find((d) => d.deviceId === id) : devices[0]
    if (!device) throw named(id ? 'OverconstrainedError' : 'NotFoundError')
    return streamOf(device)
  }
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: (constraints: MediaStreamConstraints) => {
        asked.push(wantedId(constraints))
        return getUserMedia(constraints)
      },
      enumerateDevices: async () => devices,
    },
  })
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeNode)
})
afterEach(() => vi.unstubAllGlobals())

const live = () => tracks.filter((t) => !t.stopped).map((t) => t.label)
const openRemembered = (remembered: RecordingSettings, signal = new AbortController().signal) =>
  openPerformanceInput('', () => {}, signal, { remembered, context: new AudioContext() })

describe('openPerformanceInput with the remembered input (D20)', () => {
  it('opens that device alone, in the context started by the tap', async () => {
    const input = await openRemembered(REMEMBERED)
    expect(asked).toEqual(['usb'])
    expect(input).toMatchObject({ deviceId: 'usb', label: 'Fake Piano', deviceLabel: 'Fake Piano' })
    expect(contexts).toHaveLength(1)
    input.close()
    expect(live()).toEqual([])
    expect(contexts[0]!.state).toBe('closed')
  })

  it('finds it by its name when the browser has given out new IDs', async () => {
    devices = [INTERNAL, { ...USB, deviceId: 'usb-again' }]
    const input = await openRemembered(REMEMBERED)
    expect(asked).toEqual(['usb', '', 'usb-again'])
    expect(input).toMatchObject({ deviceId: 'usb-again', label: 'Fake Piano' })
    expect(live()).toEqual(['Fake Piano'])
  })

  it('refuses any other input, and leaves nothing open', async () => {
    devices = [INTERNAL]
    await expect(openRemembered(REMEMBERED)).rejects.toThrow(RecordingError)
    await expect(openRemembered(REMEMBERED)).rejects.toThrow(/^The selected audio input is not available/)
    expect(live()).toEqual([])
    expect(contexts.every((c) => c.state === 'closed')).toBe(true)
  })

  it('refuses a device the browser gave in its place', async () => {
    getUserMedia = async () => streamOf(INTERNAL)
    devices = [INTERNAL]
    await expect(openRemembered(REMEMBERED)).rejects.toThrow(/^The selected audio input is not available/)
    expect(live()).toEqual([])
  })

  it('never opens another input while the ID is missing and no name is known', async () => {
    devices = [INTERNAL]
    await expect(openRemembered({ inputId: 'usb', inputLabel: null })).rejects.toMatchObject({
      name: 'OverconstrainedError',
    })
    expect(asked).toEqual(['usb'])
  })

  it('checks the system’s choice by its name', async () => {
    const system = { kind: 'audioinput', deviceId: 'default', label: 'Default - Webcam' }
    devices = [system, INTERNAL]
    await expect(openRemembered({ inputId: 'default', inputLabel: 'Default - Fake Piano' })).rejects.toThrow(
      RecordingError,
    )
    devices = [{ ...system, label: 'Default - Fake Piano' }]
    const input = await openRemembered({ inputId: 'default', inputLabel: 'Default - Fake Piano' })
    expect(input.deviceId).toBe('default')
  })

  it('passes a refusal on', async () => {
    getUserMedia = async () => {
      throw named('NotAllowedError')
    }
    await expect(openRemembered(REMEMBERED)).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(asked).toEqual(['usb'])
    expect(contexts[0]!.state).toBe('closed')
  })

  it('stops a stream that arrives after the cancel', async () => {
    const controller = new AbortController()
    let arrive: (stream: unknown) => void = () => undefined
    getUserMedia = () => new Promise((resolve) => (arrive = resolve))
    const opening = openRemembered(REMEMBERED, controller.signal)
    controller.abort()
    arrive(streamOf(USB))
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(live()).toEqual([])
    expect(contexts[0]!.state).toBe('closed')
  })

  it('closes the context of the tap when this browser cannot open audio input at all', async () => {
    const context = new AudioContext()
    vi.stubGlobal('navigator', {})
    await expect(
      openPerformanceInput('', () => {}, new AbortController().signal, { remembered: REMEMBERED, context }),
    ).rejects.toThrow(/^Audio input is unavailable/)
    expect(contexts[0]!.state).toBe('closed')
  })
})

describe('openPerformanceInput from the setup sheet', () => {
  const open = (id: string, preferredName?: string) =>
    openPerformanceInput(id, () => {}, new AbortController().signal, { preferredName })

  it('prefers the input named like the piano, else keeps the system’s', async () => {
    expect((await open('', 'fake piano ')).deviceId).toBe('usb')
    expect(live()).toEqual(['Fake Piano'])
    expect((await open('', 'Another piano')).deviceId).toBe('internal')
  })

  it('opens a chosen input', async () => {
    expect((await open('usb')).deviceId).toBe('usb')
    expect(asked).toEqual(['usb'])
  })

  it('keeps no input open after Stop', async () => {
    const input = await open('usb')
    input.start()
    const wav = await input.stop()
    expect(posted).toEqual(['start', 'stop'])
    expect(wav.type).toBe('audio/wav')
    expect(live()).toEqual([])
    expect(contexts[0]!.state).toBe('closed')
  })
})
