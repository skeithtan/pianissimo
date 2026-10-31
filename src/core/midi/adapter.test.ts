import { describe, expect, it } from 'vitest'
import {
  MIDI_DENIED_EXPLANATION,
  MIDI_UNSUPPORTED_EXPLANATION,
  MidiAdapter,
  type MidiRouteEvent,
  isWebMidiSupported,
} from './adapter'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from './fakeWebMidi'
import type { MidiInputEvent } from './types'

async function granted(now = () => 1000) {
  const access = new FakeAccess()
  const piano = access.addInput(new FakeInput('in-1', 'Digital Piano'))
  const other = access.addInput(new FakeInput('in-2', 'Pad'))
  const out = access.addOutput(new FakeOutput('out-1', 'Digital Piano'))
  const nav = fakeNavigator(access)
  const adapter = new MidiAdapter({ navigator: nav, now })
  expect(await adapter.request()).toBe('granted')
  return { access, piano, other, out, nav, adapter }
}

describe('MidiAdapter: access and permission (spec "Delivery and device compatibility")', () => {
  it('reports unsupported browsers with an explanation and never requests', async () => {
    const adapter = new MidiAdapter({ navigator: {} })
    expect(isWebMidiSupported({})).toBe(false)
    expect(adapter.status).toBe('unsupported')
    expect(adapter.statusMessage).toBe(MIDI_UNSUPPORTED_EXPLANATION)
    expect(await adapter.request()).toBe('unsupported')
    expect(await adapter.permission()).toBe('unknown')
    expect(new MidiAdapter({ navigator: undefined }).status).toBe('unsupported')
  })

  it('requests access with sysex disabled, once even if asked twice concurrently', async () => {
    const access = new FakeAccess()
    const nav = fakeNavigator(access)
    const adapter = new MidiAdapter({ navigator: nav })
    const statuses: string[] = []
    adapter.onStatus((s) => statuses.push(s))
    const [a, b] = await Promise.all([adapter.request(), adapter.request()])
    expect([a, b]).toEqual(['granted', 'granted'])
    expect(nav.calls).toEqual([{ sysex: false }])
    expect(statuses).toEqual(['requesting', 'granted'])
    await adapter.request()
    expect(nav.calls).toHaveLength(1)
  })

  it('distinguishes denied access from other failures and allows a retry', async () => {
    const denied = new MidiAdapter({ navigator: fakeNavigator(new FakeAccess(), 'deny') })
    expect(await denied.request()).toBe('denied')
    expect(denied.statusMessage).toBe(MIDI_DENIED_EXPLANATION)
    const failed = new MidiAdapter({ navigator: fakeNavigator(new FakeAccess(), 'fail') })
    expect(await failed.request()).toBe('error')
    expect(failed.statusMessage).toMatch(/boom/)
  })

  it('reads the permission state (granted / denied / prompt) without prompting', async () => {
    for (const state of ['granted', 'denied', 'prompt'] as const) {
      const nav = { ...fakeNavigator(new FakeAccess()), permissions: { query: () => Promise.resolve({ state }) } }
      expect(await new MidiAdapter({ navigator: nav }).permission()).toBe(state)
    }
    const throwing = {
      ...fakeNavigator(new FakeAccess()),
      permissions: { query: () => Promise.reject(new TypeError('midi')) },
    }
    expect(await new MidiAdapter({ navigator: throwing }).permission()).toBe('unknown')
    expect(await new MidiAdapter({ navigator: fakeNavigator(new FakeAccess()) }).permission()).toBe('unknown')
  })
})

describe('MidiAdapter: ports and input', () => {
  it('lists inputs and outputs separately', async () => {
    const { adapter } = await granted()
    expect(adapter.inputs().map((p) => p.name)).toEqual(['Digital Piano', 'Pad'])
    expect(adapter.outputs().map((p) => [p.id, p.type])).toEqual([['out-1', 'output']])
  })

  it('decodes only the selected input, in order, updating physical state before subscribers', async () => {
    const { adapter, piano, other } = await granted()
    const seen: Array<[MidiInputEvent, boolean]> = []
    adapter.subscribe((ev) => seen.push([ev, adapter.physical.isHeld(60)]))
    expect(adapter.selectInput('in-1')).toBe(true)
    piano.emit([0x90, 60, 90], 500)
    other.emit([0x90, 61, 90], 501)
    piano.emit([0x90, 60, 0], 502)
    expect(seen.map(([e, held]) => [e.kind, e.seq, held])).toEqual([
      ['noteon', 1, true],
      ['noteoff', 2, false],
    ])
    expect(adapter.lastSeq).toBe(2)
  })

  it('replaces a missing or foreign-timebase timestamp with the monotonic clock', async () => {
    const { adapter, piano } = await granted(() => 1000)
    const times: number[] = []
    adapter.subscribe((ev) => times.push(ev.time))
    adapter.selectInput('in-1')
    piano.emit([0x90, 60, 90], 0)
    piano.emit([0x90, 61, 90], 1_700_000_000_000)
    piano.emit([0x90, 62, 90], 990)
    expect(times).toEqual([1000, 1000, 990])
  })

  it('switching input detaches the previous port and resets physical state', async () => {
    const { adapter, piano, other } = await granted()
    adapter.selectInput('in-1')
    piano.emit([0x90, 60, 90], 1)
    expect(adapter.physical.heldCount).toBe(1)
    adapter.selectInput('in-2')
    expect(piano.onmidimessage).toBeNull()
    expect(adapter.physical.heldCount).toBe(0)
    other.emit([0x90, 61, 90], 2)
    expect(adapter.physical.heldNotes()).toEqual([61])
    expect(adapter.selectInput('nope')).toBe(false)
  })
})

describe('MidiAdapter: MIDI fidelity (spec acceptance "MIDI fidelity")', () => {
  it('a known sequence of chords, repeated notes, releases, velocities and pedal values arrives once each, in order', async () => {
    const { adapter, piano } = await granted()
    adapter.selectInput('in-1')
    const got: string[] = []
    const seqs: number[] = []
    adapter.subscribe((ev) => {
      seqs.push(ev.seq)
      got.push(ev.kind === 'cc' ? `cc${ev.controller}=${ev.value}` : `${ev.kind}${ev.note}v${ev.velocity}`)
    })
    const sent: number[][] = [
      [0x90, 60, 30],
      [0x90, 64, 64],
      [0x90, 67, 127],
      [0xb0, 64, 0],
      [0xb0, 64, 45],
      [0xb0, 64, 127],
      [0x80, 60, 0],
      [0x90, 64, 0],
      [0x80, 67, 10],
      ...Array.from({ length: 10 }, (_, i) => [
        [0x90, 72, 20 + i * 10],
        [0x80, 72, 0],
      ]).flat(),
      [0x90, 72, 90, 72, 0],
      [0xb0, 64, 0],
    ]
    sent.forEach((bytes, i) => piano.emit(bytes, 100 + i))
    expect(got.slice(0, 9)).toEqual([
      'noteon60v30',
      'noteon64v64',
      'noteon67v127',
      'cc64=0',
      'cc64=45',
      'cc64=127',
      'noteoff60v0',
      'noteoff64v0',
      'noteoff67v10',
    ])
    expect(got.filter((g) => g.startsWith('noteon72'))).toHaveLength(11)
    expect(got.filter((g) => g.startsWith('noteoff72'))).toHaveLength(11)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
    expect(got.at(-1)).toBe('cc64=0')
    expect(adapter.physical.heldCount).toBe(0)
  })
})

describe('MidiAdapter: disconnect and reconnect (statechange)', () => {
  it('reports input disconnect, resets physical state, and reattaches on reconnect by id', async () => {
    const { adapter, access, piano } = await granted()
    const routes: MidiRouteEvent[] = []
    let portChanges = 0
    adapter.onRoute((e) => routes.push(e))
    adapter.onPortsChanged(() => portChanges++)
    adapter.selectInput('in-1')
    piano.emit([0x90, 60, 90], 1)
    access.setState(piano, 'disconnected')
    expect(routes.map((r) => r.kind)).toEqual(['input-disconnected'])
    expect(adapter.physical.heldCount).toBe(0)
    expect(piano.onmidimessage).toBeNull()
    access.setState(piano, 'connected')
    expect(routes.map((r) => r.kind)).toEqual(['input-disconnected', 'input-reconnected'])
    const seen: number[] = []
    adapter.subscribe((ev) => seen.push(ev.seq))
    piano.emit([0x90, 62, 90], 2)
    expect(seen).toEqual([2])
    expect(portChanges).toBe(2)
  })

  it('recognizes a reconnected port with a new id by its name (Bluetooth)', async () => {
    const { adapter, access, piano } = await granted()
    const routes: string[] = []
    adapter.onRoute((e) => routes.push(`${e.kind}:${e.port.id}`))
    adapter.selectInput('in-1')
    access.setState(piano, 'disconnected')
    const again = access.addInput(new FakeInput('in-9', 'Digital Piano'))
    expect(routes).toEqual(['input-disconnected:in-1', 'input-reconnected:in-9'])
    expect(adapter.selectedInput?.id).toBe('in-9')
    expect(again.onmidimessage).not.toBeNull()
  })

  it('reports output disconnect and reconnect and exposes the output only while connected', async () => {
    const { adapter, access, out } = await granted()
    const routes: string[] = []
    adapter.onRoute((e) => routes.push(e.kind))
    expect(adapter.selectOutput('out-1')).toBe(true)
    expect(adapter.output).toBe(out)
    access.setState(out, 'disconnected')
    expect(adapter.output).toBeNull()
    access.setState(out, 'connected')
    expect(adapter.output).toBe(out)
    expect(routes).toEqual(['output-disconnected', 'output-reconnected'])
  })

  it('dispose detaches handlers and listeners', async () => {
    const { adapter, access, piano } = await granted()
    adapter.selectInput('in-1')
    adapter.dispose()
    expect(piano.onmidimessage).toBeNull()
    expect(access.onstatechange).toBeNull()
  })
})
