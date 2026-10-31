// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'preact/test-utils'
import { getMidiService, resetServicesForTests } from '../../app/services'
import { resetAppStateForTests, settings, updateSettings } from '../../app/state'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from '../../core/midi/fakeWebMidi'
import { byLabel, click, flush, mount, type Mounted } from '../shared/testing'
import { EchoStep, type EchoClock } from './EchoStep'
import { echoStatus } from './status'

let view: Mounted | null = null

beforeEach(() => {
  resetAppStateForTests()
  resetServicesForTests()
})
afterEach(() => {
  view?.unmount()
  view = null
  resetServicesForTests()
  resetAppStateForTests()
})

/** A clock whose timers fire only when the test says so. */
function manualClock(): EchoClock & { fire(): void } {
  const timers: (() => void)[] = []
  return {
    now: () => performance.now(),
    setTimeout: (fn) => {
      timers.push(fn)
      return timers.length
    },
    fire: () => {
      for (const fn of timers.splice(0)) fn()
    },
  }
}

/**
 * Mount the echo step on a connected route. `echo`: the output feeds its notes back to the
 * input, like a piano or interface with MIDI Thru on.
 */
async function rig(behavior: 'echo' | 'silent' | 'one-soft') {
  const access = new FakeAccess()
  const piano = access.addInput(new FakeInput('in-1', 'Digital Piano'))
  const out = access.addOutput(new FakeOutput('out-1', 'Digital Piano'))
  if (behavior !== 'silent') {
    const send = out.send.bind(out)
    out.send = (data, time) => {
      send(data, time)
      if (behavior === 'echo') piano.emit(data, time ?? performance.now())
      else if ((data[0]! & 0xf0) === 0x90 && data[1] === 61) piano.emit([0x90, 61, 20], time ?? performance.now())
    }
  }
  resetServicesForTests({ navigator: fakeNavigator(access) })
  const service = getMidiService()
  await service.connect()
  service.selectInput('in-1')
  service.selectOutput('out-1')
  const clock = manualClock()
  const render = () => {
    const snap = service.snapshot
    return (
      <EchoStep index={4} status={echoStatus(snap, settings.value.route)} snap={snap} service={service} clock={clock} />
    )
  }
  view = mount(render())
  return {
    out,
    clock,
    root: view.container,
    async run() {
      click(byLabel(view!.container, 'Run echo test') ?? byLabel(view!.container, 'Run again'))
      await act(async () => {
        clock.fire()
        await Promise.resolve()
      })
      flush(() => view!.rerender(render()))
    },
  }
}

describe('EchoStep (spec: disable graded accompaniment while output echoes back)', () => {
  it('detects an echo, stores it and explains what it disables', async () => {
    const r = await rig('echo')
    await r.run()
    expect(r.out.sent).toHaveLength(6) // three probe notes, on and off
    expect(settings.value.route.echo).toBe('echo-detected')
    expect(r.root.textContent).toContain('Echo detected')
    expect(r.root.textContent).toContain('graded one-hand practice is off for this route')
    expect(r.root.textContent).toContain('Preview still works')
    expect(r.root.textContent).toContain('turn off MIDI Thru')
  })

  it('reports no echo on a clean route', async () => {
    const r = await rig('silent')
    await r.run()
    expect(settings.value.route.echo).toBe('none')
    expect(r.root.textContent).toContain('No echo')
  })

  it('keeps the previous result when the test is inconclusive', async () => {
    const r = await rig('one-soft')
    flush(() => updateSettings({ route: { echo: 'none' } }))
    await r.run()
    expect(settings.value.route.echo).toBe('none')
    expect(r.root.textContent).toContain('Inconclusive')
  })
})
