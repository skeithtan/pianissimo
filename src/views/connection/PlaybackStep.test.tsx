// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'preact/test-utils'
import { getMidiService, resetServicesForTests } from '../../app/services'
import { resetAppStateForTests, settings, updateSettings } from '../../app/state'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from '../../core/midi/fakeWebMidi'
import { byLabel, click, flush, mount, type Mounted } from '../shared/testing'
import { PlaybackStep } from './PlaybackStep'
import { playbackStatus } from './status'
import { manualClock } from './testkit'

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

/**
 * Mount the playback step on a connected route. `echo`: the output feeds its notes back to the
 * input, like a piano or interface with MIDI Thru on. `noInput`: the piano input is not chosen.
 */
async function rig(behavior: 'echo' | 'silent' | 'one-soft', opts: { noInput?: boolean } = {}) {
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
  if (!opts.noInput) service.selectInput('in-1')
  service.selectOutput('out-1')
  const clock = manualClock()
  const render = () => {
    const snap = service.snapshot
    return (
      <PlaybackStep
        index={2}
        status={playbackStatus(snap, settings.value.route)}
        snap={snap}
        service={service}
        clock={clock}
      />
    )
  }
  view = mount(render())
  const rerender = () => flush(() => view!.rerender(render()))
  return {
    out,
    clock,
    root: view.container,
    rerender,
    /** Tap Play test notes and let the listening window elapse. */
    async play() {
      click(byLabel(view!.container, 'Play test notes'))
      await act(async () => {
        clock.fire()
        await Promise.resolve()
      })
      rerender()
    },
  }
}

const step = (root: HTMLElement) => root.querySelector('[data-step="playback"]')!

describe('PlaybackStep: the test notes double as the echo probe (DECISIONS C11)', () => {
  it('sends the three-note probe, asks whether the piano sounded, and finds no echo on a clean route', async () => {
    const r = await rig('silent')
    click(byLabel(r.root, 'Play test notes'))
    expect(r.out.sent).toHaveLength(6) // three probe notes, on and off
    expect(r.out.sent[0]!.data).toEqual([0x90, 61, 37])
    expect(r.root.textContent).toContain('Did the piano itself play three short notes?')
    click(byLabel(r.root, 'Yes, I heard them'))
    expect(settings.value.route.outputVerified).toBe(true)
    r.rerender()
    // The listening window is still open: the step waits for the echo verdict.
    expect(settings.value.route.echo).toBe('untested')
    expect(step(r.root).getAttribute('data-tone')).toBe('action')
    await act(async () => {
      r.clock.fire()
      await Promise.resolve()
    })
    r.rerender()
    expect(settings.value.route.echo).toBe('none')
    expect(step(r.root).getAttribute('data-tone')).toBe('done')
    expect(r.root.textContent).toContain('The piano sounds on channel 1')
    expect(r.root.textContent).toContain('do not come back as if you had played them')
    expect(r.root.textContent).not.toContain('Echo')
  })

  it('detects an echo, stores it and explains what it disables', async () => {
    const r = await rig('echo')
    await r.play()
    expect(settings.value.route.echo).toBe('echo-detected')
    expect(r.root.textContent).toContain('Echo detected')
    expect(r.root.textContent).toContain('graded one-hand practice is off for this route')
    expect(r.root.textContent).toContain('Preview still works')
    expect(r.root.textContent).toContain('turn off MIDI Thru')
    click(byLabel(r.root, 'Yes, I heard them'))
    r.rerender()
    expect(step(r.root).getAttribute('data-tone')).toBe('action')
  })

  it('keeps the previous result when the echo check is inconclusive', async () => {
    const r = await rig('one-soft')
    flush(() => updateSettings({ route: { echo: 'none' } }))
    await r.play()
    expect(settings.value.route.echo).toBe('none')
    expect(r.root.textContent).toContain('inconclusive')
  })

  it('without a piano input the sound is verified but the echo stays unchecked', async () => {
    const r = await rig('silent', { noInput: true })
    await r.play()
    click(byLabel(r.root, 'Yes, I heard them'))
    r.rerender()
    expect(settings.value.route).toMatchObject({ outputVerified: true, echo: 'untested' })
    expect(r.root.textContent).toContain('Echo not checked yet')
    expect(r.root.textContent).toContain('Connect the piano input')
    expect(step(r.root).getAttribute('data-tone')).toBe('action')
  })

  it('reports when the notes could not be sent', async () => {
    const r = await rig('silent')
    r.out.send = () => {
      throw new Error('port closed')
    }
    click(byLabel(r.root, 'Play test notes'))
    await act(async () => {
      await Promise.resolve()
    })
    r.rerender()
    expect(r.root.textContent).toContain('The test notes could not be sent')
    expect(settings.value.route.outputVerified).toBe(false)
  })
})
