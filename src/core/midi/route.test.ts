import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type MidiRouteSettings } from '../model/settings'
import { MidiAdapter, type MidiPortInfo } from './adapter'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from './fakeWebMidi'
import { applyRememberedRoute, findRememberedPort, gradedAccompanimentAllowed, rememberRoute } from './route'
import { playTestNote } from './testNote'

const port = (id: string, name: string, state: 'connected' | 'disconnected' = 'connected'): MidiPortInfo => ({
  id,
  name,
  manufacturer: '',
  type: 'output',
  state,
})

describe('route memory (spec: remember the route and its tested channel)', () => {
  it('finds a remembered port by id first, then by name', () => {
    const ports = [port('a', 'Piano'), port('b', 'Synth')]
    expect(findRememberedPort(ports, 'b', 'Piano')).toEqual({ port: ports[1], by: 'id' })
    expect(findRememberedPort(ports, 'zz', 'Piano')).toEqual({ port: ports[0], by: 'name' })
    expect(findRememberedPort(ports, null, null)).toBeNull()
    expect(findRememberedPort(ports, 'zz', 'Organ')).toBeNull()
  })

  it('prefers a connected port with the remembered name over a disconnected id match', () => {
    const ports = [port('old', 'Piano', 'disconnected'), port('new', 'Piano')]
    expect(findRememberedPort(ports, 'old', 'Piano')).toEqual({ port: ports[1], by: 'name' })
    expect(findRememberedPort([ports[0]!], 'old', 'Piano')).toEqual({ port: ports[0], by: 'id' })
  })

  it('keeps verification and echo results only for the same output and channel', () => {
    const tested: MidiRouteSettings = {
      ...DEFAULT_SETTINGS.route,
      outputId: 'a',
      outputName: 'Piano',
      outputChannel: 1,
      outputVerified: true,
      echo: 'none',
    }
    const input = { ...port('i', 'Piano'), type: 'input' as const }
    const same = rememberRoute(tested, input, port('a', 'Piano'))
    expect(same).toMatchObject({ inputId: 'i', outputVerified: true, echo: 'none', outputChannel: 1 })
    expect(rememberRoute(tested, input, port('a', 'Piano'), 2)).toMatchObject({
      outputVerified: false,
      echo: 'untested',
    })
    expect(rememberRoute(tested, input, port('c', 'Synth'))).toMatchObject({ outputVerified: false, echo: 'untested' })
    expect(rememberRoute(tested, input, null)).toMatchObject({ outputId: null, outputVerified: false })
  })

  it('allows graded accompaniment only on a verified, echo-free output', () => {
    const base = { ...DEFAULT_SETTINGS.route, outputId: 'a', outputVerified: true }
    expect(gradedAccompanimentAllowed({ ...base, echo: 'none' })).toBe(true)
    expect(gradedAccompanimentAllowed({ ...base, echo: 'echo-detected' })).toBe(false)
    expect(gradedAccompanimentAllowed({ ...base, echo: 'untested' })).toBe(false)
    expect(gradedAccompanimentAllowed({ ...base, echo: 'none', outputVerified: false })).toBe(false)
  })

  it('restores the remembered input and output on a granted adapter', async () => {
    const access = new FakeAccess()
    access.addInput(new FakeInput('in-7', 'Digital Piano'))
    access.addOutput(new FakeOutput('out-7', 'Digital Piano'))
    const adapter = new MidiAdapter({ navigator: fakeNavigator(access) })
    await adapter.request()
    const route = {
      ...DEFAULT_SETTINGS.route,
      inputId: 'in-1',
      inputName: 'Digital Piano',
      outputId: 'out-7',
      outputName: 'Digital Piano',
    }
    const restored = applyRememberedRoute(adapter, route)
    expect(restored.input).toMatchObject({ by: 'name', port: { id: 'in-7' } })
    expect(restored.output).toMatchObject({ by: 'id' })
    expect(adapter.selectedInput?.id).toBe('in-7')
    expect(adapter.selectedOutput?.id).toBe('out-7')
  })
})

describe('playTestNote', () => {
  it('sends one note on the tested channel with timestamps', () => {
    const out = new FakeOutput('o', 'Piano')
    expect(playTestNote(out, 500, { channel: 3 })).toBe(true)
    expect(out.sent).toEqual([
      { data: [0x93, 60, 80], time: 500 },
      { data: [0x83, 60, 64], time: 1200 },
    ])
    out.state = 'disconnected'
    expect(playTestNote(out, 600, { channel: 3 })).toBe(false)
  })
})
