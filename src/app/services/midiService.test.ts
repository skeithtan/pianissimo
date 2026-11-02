import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MidiAdapter, MIDI_DENIED_EXPLANATION, type MidiRouteEvent } from '../../core/midi/adapter'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from '../../core/midi/fakeWebMidi'
import type { MidiNavigatorLike } from '../../core/midi/webmidi'
import { DEFAULT_SETTINGS, type MidiRouteSettings } from '../../core/model/settings'
import type { ConnectionStatus, NoticeInput } from '../state'
import { MidiService, ROUTE_NOTICE_COALESCE_MS, connectionStatusFor, hasRememberedRoute } from './midiService'

type Permission = 'granted' | 'denied' | 'prompt'

function withPermission(nav: MidiNavigatorLike, state: Permission): MidiNavigatorLike {
  return { ...nav, permissions: { query: () => Promise.resolve({ state }) } }
}

function harness(
  opts: { route?: Partial<MidiRouteSettings>; permission?: Permission; outcome?: 'grant' | 'deny' } = {},
) {
  const access = new FakeAccess()
  const piano = access.addInput(new FakeInput('in-1', 'Digital Piano'))
  const pianoOut = access.addOutput(new FakeOutput('out-1', 'Digital Piano'))
  const fake = fakeNavigator(access, opts.outcome ?? 'grant')
  const nav = opts.permission ? withPermission(fake, opts.permission) : fake
  let route: MidiRouteSettings = { ...DEFAULT_SETTINGS.route, ...opts.route }
  const statuses: ConnectionStatus[] = []
  const notices: NoticeInput[] = []
  const dismissed: number[] = []
  let created = 0
  const service = new MidiService({
    createAdapter: () => {
      created++
      return new MidiAdapter({ navigator: nav, now: () => 5000 })
    },
    getRoute: () => route,
    setRoute: (next) => {
      route = next
    },
    setStatus: (s) => statuses.push(s),
    notify: (n) => notices.push(n) - 1,
    dismiss: (id) => dismissed.push(id),
    now: () => 5000,
  })
  return {
    access,
    piano,
    pianoOut,
    fake,
    service,
    statuses,
    notices,
    dismissed,
    get route() {
      return route
    },
    get created() {
      return created
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MidiService: lazy adapter and access (spec "Delivery and device compatibility")', () => {
  it('creates the adapter only on first use and never requests access by itself', async () => {
    const h = harness({ permission: 'prompt' })
    expect(h.service.peek()).toBeNull()
    expect(h.created).toBe(0)
    expect(h.service.adapter).toBe(h.service.adapter)
    expect(h.created).toBe(1)
    expect(await h.service.readPermission()).toBe('prompt')
    expect(h.fake.calls).toHaveLength(0)
    expect(h.service.snapshot.permission).toBe('prompt')
    expect(h.statuses.at(-1)).toEqual({ state: 'disconnected' })
  })

  it('requests access on connect and lists inputs and outputs separately', async () => {
    const h = harness()
    expect(await h.service.connect()).toBe('granted')
    expect(h.fake.calls).toEqual([{ sysex: false }])
    expect(h.service.snapshot.inputs.map((p) => p.id)).toEqual(['in-1'])
    expect(h.service.snapshot.outputs.map((p) => p.id)).toEqual(['out-1'])
    expect(h.statuses.at(-1)).toEqual({ state: 'disconnected', detail: 'Choose your piano in Connection.' })
    expect(h.statuses).toContainEqual({ state: 'connecting' })
  })

  it('reports a denied permission with the explanation', async () => {
    const h = harness({ outcome: 'deny' })
    expect(await h.service.connect()).toBe('denied')
    expect(h.service.snapshot.permission).toBe('denied')
    expect(h.statuses.at(-1)).toEqual({ state: 'denied', detail: MIDI_DENIED_EXPLANATION })
  })

  it('maps unsupported browsers to the unsupported status with the feature explanation', () => {
    const service = new MidiService({
      createAdapter: () => new MidiAdapter({ navigator: {} }),
      getRoute: () => DEFAULT_SETTINGS.route,
      setRoute: () => undefined,
      setStatus: () => undefined,
      notify: () => undefined,
      unsupportedDetail: 'Use MIDIWeb on iPad.',
    })
    expect(service.adapter.status).toBe('unsupported')
    expect(connectionStatusFor(service.snapshot, 'Use MIDIWeb on iPad.')).toEqual({
      state: 'unsupported',
      detail: 'Use MIDIWeb on iPad.',
    })
  })
})

describe('MidiService: route memory', () => {
  it('remembers "No output" and does not bring the old output back on the next port change (C7)', async () => {
    const h = harness()
    await h.service.connect()
    h.service.selectInput('in-1')
    h.service.selectOutput('out-1')
    h.service.selectOutput(null)
    expect(h.route).toMatchObject({ inputId: 'in-1', outputId: null, outputName: null })
    expect(h.service.snapshot.output).toBeNull()
    h.access.addOutput(new FakeOutput('out-2', 'Other'))
    expect(h.service.snapshot.output).toBeNull()
    expect(h.service.adapter.selectedOutput).toBeNull()
  })

  it('keeps naming a lost output when another setting changes while it is unplugged', async () => {
    const h = harness({ route: { outputId: 'out-1', outputName: 'Digital Piano' } })
    await h.service.connect()
    h.access.setState(h.pianoOut, 'disconnected')
    h.access.outputs.delete('out-1') // gone from the browser's list
    h.service.selectInput('in-1')
    expect(h.route).toMatchObject({ inputId: 'in-1', outputId: 'out-1', outputName: 'Digital Piano' })
  })

  it('remembers chosen ports and channel; a new output or channel clears verification', async () => {
    const h = harness()
    await h.service.connect()
    expect(h.service.selectInput('in-1')).toBe(true)
    expect(h.service.selectOutput('out-1')).toBe(true)
    expect(h.route).toMatchObject({ inputId: 'in-1', inputName: 'Digital Piano', outputId: 'out-1', outputChannel: 0 })
    expect(h.statuses.at(-1)).toEqual({ state: 'connected', inputName: 'Digital Piano', outputName: 'Digital Piano' })

    // Verified and echo-free on channel 1 …
    const verified = { ...h.route, outputVerified: true, echo: 'none' as const }
    const h2 = harness({ route: verified })
    await h2.service.connect()
    expect(h2.route.outputVerified).toBe(true)
    // … but another channel is a new route that must be tested again.
    h2.service.setOutputChannel(3)
    expect(h2.route).toMatchObject({ outputChannel: 3, outputVerified: false, echo: 'untested' })
    expect(() => h2.service.setOutputChannel(16)).toThrow(RangeError)
  })

  it('asks for access at boot and connects the remembered route, or the only piano present', async () => {
    const remembered = { inputId: 'in-1', inputName: 'Digital Piano', outputId: 'out-1', outputName: 'Digital Piano' }

    // A remembered route: the prompt is shown at once (no waiting for the Connection setup).
    const prompt = harness({ route: remembered, permission: 'prompt' })
    expect(await prompt.service.connectOnBoot()).toBe(true)
    expect(prompt.fake.calls).toEqual([{ sysex: false }])
    expect(prompt.service.adapter.selectedInput?.id).toBe('in-1')
    expect(prompt.service.adapter.selectedOutput?.id).toBe('out-1')
    expect(prompt.statuses.at(-1)).toMatchObject({ state: 'connected', inputName: 'Digital Piano' })
    expect(prompt.notices).toEqual([]) // silent

    // Nothing remembered: the only input and output present are the piano, chosen and remembered.
    const nothing = harness({ permission: 'granted' })
    expect(await nothing.service.connectOnBoot()).toBe(true)
    expect(nothing.service.adapter.selectedInput?.id).toBe('in-1')
    expect(nothing.service.adapter.selectedOutput?.id).toBe('out-1')
    expect(nothing.route).toMatchObject({ inputId: 'in-1', outputId: 'out-1' })
    expect(nothing.statuses.at(-1)).toMatchObject({ state: 'connected', inputName: 'Digital Piano' })

    // Two inputs and nothing remembered: the choice stays with the learner (Connection).
    const two = harness()
    two.access.addInput(new FakeInput('in-9', 'Stage Piano'))
    expect(await two.service.connectOnBoot()).toBe(true)
    expect(two.service.adapter.selectedInput).toBeNull()
    expect(two.service.adapter.selectedOutput?.id).toBe('out-1')

    // Denied: the chip explains; nothing else happens.
    const denied = harness({ outcome: 'deny' })
    expect(await denied.service.connectOnBoot()).toBe(false)
    expect(denied.statuses.at(-1)).toMatchObject({ state: 'denied' })
  })

  it('finds a Bluetooth port that came back with a new id by name and keeps its tests', async () => {
    const h = harness({
      route: {
        inputId: 'old-in',
        inputName: 'Digital Piano',
        outputId: 'old-out',
        outputName: 'Digital Piano',
        outputVerified: true,
        echo: 'none',
      },
      permission: 'granted',
    })
    expect(await h.service.connectOnBoot()).toBe(true)
    expect(h.route).toMatchObject({ inputId: 'in-1', outputId: 'out-1', outputVerified: true, echo: 'none' })
    expect(h.service.snapshot.input?.matchedBy).toBe('name')
  })

  it('selects the remembered piano when it is switched on later, and says so', async () => {
    const h = harness({ route: { inputId: 'in-9', inputName: 'Stage Piano' } })
    await h.service.connect()
    expect(h.service.snapshot.input).toBeNull()
    h.access.addInput(new FakeInput('in-9', 'Stage Piano'))
    expect(h.service.snapshot.input).toMatchObject({ id: 'in-9', connected: true })
    expect(h.notices).toEqual([{ kind: 'success', text: 'Piano connected: Stage Piano.' }])
  })
})

describe('MidiService: disconnect and reconnect (spec: stop scheduling, interrupt, clean state)', () => {
  async function connected() {
    const h = harness()
    await h.service.connect()
    h.service.selectInput('in-1')
    h.service.selectOutput('out-1')
    return h
  }

  it('tells route subscribers immediately and shows one coalesced notice', async () => {
    const h = await connected()
    const events: MidiRouteEvent['kind'][] = []
    h.service.onRoute((ev) => events.push(ev.kind))
    h.access.setState(h.piano, 'disconnected')
    h.access.setState(h.pianoOut, 'disconnected')
    expect(events).toEqual(['input-disconnected', 'output-disconnected'])
    expect(h.statuses.at(-1)).toEqual({ state: 'disconnected', detail: 'Digital Piano is disconnected.' })
    expect(h.service.snapshot.input).toMatchObject({ name: 'Digital Piano', connected: false })
    expect(h.notices).toEqual([])
    vi.advanceTimersByTime(ROUTE_NOTICE_COALESCE_MS)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatchObject({ kind: 'warning' })
    expect(h.notices[0]!.text).toMatch(/Piano disconnected \(Digital Piano\)\. App playback stopped\./)

    h.access.setState(h.piano, 'connected')
    h.access.setState(h.pianoOut, 'connected')
    expect(events.slice(2)).toEqual(['input-reconnected', 'output-reconnected'])
    expect(h.statuses.at(-1)).toMatchObject({ state: 'connected' })
    vi.advanceTimersByTime(ROUTE_NOTICE_COALESCE_MS)
    expect(h.notices[1]).toMatchObject({ kind: 'success' })
    expect(h.notices[1]!.text).toMatch(/Release all keys and pedals/)
  })

  it('dismisses the disconnect notice once the piano is fully back', async () => {
    const h = await connected()
    h.access.setState(h.piano, 'disconnected')
    h.access.setState(h.pianoOut, 'disconnected')
    vi.advanceTimersByTime(ROUTE_NOTICE_COALESCE_MS)
    expect(h.notices.map((n) => n.kind)).toEqual(['warning'])

    // The input alone is not the whole piano: the notice still says playback stopped.
    h.access.setState(h.piano, 'connected')
    expect(h.dismissed).toEqual([])
    h.access.setState(h.pianoOut, 'connected')
    expect(h.dismissed).toEqual([0])
    vi.advanceTimersByTime(ROUTE_NOTICE_COALESCE_MS)
    expect(h.notices.map((n) => n.kind)).toEqual(['warning', 'success'])

    // A later disconnect gets its own notice, dismissed in turn.
    h.access.setState(h.piano, 'disconnected')
    vi.advanceTimersByTime(ROUTE_NOTICE_COALESCE_MS)
    h.access.setState(h.piano, 'connected')
    expect(h.dismissed).toEqual([0, 2])
  })

  it('a glitch that reconnects within the window only reports the reconnection', async () => {
    const h = await connected()
    h.access.setState(h.piano, 'disconnected')
    h.access.setState(h.piano, 'connected')
    vi.advanceTimersByTime(ROUTE_NOTICE_COALESCE_MS)
    expect(h.notices.map((n) => n.kind)).toEqual(['success'])
  })

  it('subscriptions registered before the adapter exists still receive events', async () => {
    const h = harness()
    const events: string[] = []
    h.service.onRoute((ev) => events.push(ev.kind))
    await h.service.connect()
    h.service.selectInput('in-1')
    h.access.setState(h.piano, 'disconnected')
    expect(events).toEqual(['input-disconnected'])
  })
})

describe('MidiService: Stop sound (spec: confine cleanup to the app output route)', () => {
  it('runs sound owners, then sends All Notes Off on the app channel only', async () => {
    const h = harness({ route: { outputChannel: 2 } })
    await h.service.connect()
    h.service.selectOutput('out-1')
    const owner = vi.fn()
    const unregister = h.service.registerSoundOwner(owner)
    expect(h.service.stopSound()).toEqual({ sent: true, outputName: 'Digital Piano', channel: 2 })
    expect(owner).toHaveBeenCalledTimes(1)
    expect(h.pianoOut.sent).toEqual([{ data: [0xb2, 123, 0], time: 5000 }])
    unregister()
    h.service.stopSound()
    expect(owner).toHaveBeenCalledTimes(1)
  })

  it('reports nothing sent without a connected output', async () => {
    const h = harness()
    await h.service.connect()
    expect(h.service.stopSound()).toEqual({ sent: false, outputName: null, channel: 0 })
  })
})

describe('hasRememberedRoute', () => {
  it('is true when any port id or name is stored', () => {
    expect(hasRememberedRoute(DEFAULT_SETTINGS.route)).toBe(false)
    expect(hasRememberedRoute({ ...DEFAULT_SETTINGS.route, outputName: 'X' })).toBe(true)
  })
})
