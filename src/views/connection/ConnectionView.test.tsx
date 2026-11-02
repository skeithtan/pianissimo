// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'preact/test-utils'
import { getMidiService, resetServicesForTests } from '../../app/services'
import { connectionStatus, resetAppStateForTests, settings, updateSettings } from '../../app/state'
import { connectionOpen, currentView } from '../../app/navigation'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from '../../core/midi/fakeWebMidi'
import type { MidiNavigatorLike } from '../../core/midi/webmidi'
import { NO_MIDDLE_PEDAL_EXPLANATION } from '../../core/midi/hintPedal'
import { $, $$, byLabel, byText, click, flush, mount, type, type Mounted } from '../shared/testing'
import { ALL_FEATURES } from '../settings/testkit'
import { detectFeatures } from '../../app/features'
import { ConnectionSetup } from './ConnectionView'
import { manualClock } from './testkit'

const settle = (ms = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

let view: Mounted | null = null

beforeEach(() => {
  resetAppStateForTests()
  resetServicesForTests()
  currentView.value = 'library'
  connectionOpen.value = true
})
afterEach(() => {
  view?.unmount()
  view = null
  resetServicesForTests()
  resetAppStateForTests()
  delete document.documentElement.dataset['theme']
})

interface Rig {
  readonly access: FakeAccess
  readonly piano: FakeInput
  readonly out: FakeOutput
  readonly nav: ReturnType<typeof fakeNavigator>
  readonly root: HTMLElement
  readonly clock: ReturnType<typeof manualClock>
  /** Send raw MIDI bytes from the piano. */
  play(bytes: number[]): Promise<void>
}

async function open(
  opts: {
    permission?: 'granted' | 'prompt' | 'denied'
    outcome?: 'grant' | 'deny'
    navigator?: MidiNavigatorLike
  } = {},
): Promise<Rig> {
  const access = new FakeAccess()
  const piano = access.addInput(new FakeInput('in-1', 'Digital Piano'))
  const out = access.addOutput(new FakeOutput('out-1', 'Digital Piano'))
  const nav = fakeNavigator(access, opts.outcome ?? 'grant')
  const permission = opts.permission ?? 'prompt'
  resetServicesForTests({
    navigator: opts.navigator ?? { ...nav, permissions: { query: () => Promise.resolve({ state: permission }) } },
  })
  const clock = manualClock()
  view = mount(<ConnectionSetup features={ALL_FEATURES} clock={clock} />)
  await settle()
  const root = view.container
  return {
    access,
    piano,
    out,
    nav,
    root,
    clock,
    async play(bytes) {
      flush(() => piano.emit(bytes, performance.now()))
      await settle()
    },
  }
}

function section(root: HTMLElement, step: string): HTMLElement {
  const found = $(root, `[data-step="${step}"]`)
  if (!found) throw new Error(`No step ${step}`)
  return found
}

function radioFor(root: ParentNode, label: string): HTMLInputElement {
  const row = $$(root, 'label').find((l) => l.textContent?.includes(label))
  const input = row && $(row, 'input[type="radio"]')
  if (!input) throw new Error(`No radio "${label}"`)
  return input as HTMLInputElement
}

async function connectAll(rig: Rig): Promise<void> {
  click(byLabel(rig.root, 'Allow MIDI access'))
  await settle()
  click(radioFor(section(rig.root, 'piano'), 'Digital Piano'))
  click(radioFor(section(rig.root, 'playback'), 'Digital Piano'))
  await settle()
}

/** Tap Play test notes, answer Yes, and let the listening window elapse. */
async function hearTestNotes(rig: Rig): Promise<void> {
  click(byLabel(rig.root, 'Play test notes'))
  click(byLabel(rig.root, 'Yes, I heard them'))
  await act(async () => {
    rig.clock.fire()
    await Promise.resolve()
  })
  await settle()
}

describe('Piano step: MIDI access (spec "Delivery and device compatibility")', () => {
  it('explains a browser without Web MIDI and never offers to request it', async () => {
    resetServicesForTests({ navigator: {} })
    const features = detectFeatures({ navigator: {} })
    view = mount(<ConnectionSetup features={features} />)
    await settle()
    const root = view.container
    expect(root.textContent).toContain('This browser cannot connect a piano')
    expect(root.textContent).toContain('MIDIWeb Browser')
    expect(root.textContent).toContain('desktop Chrome')
    expect(byLabel(root, 'Allow MIDI access')).toBeNull()
    expect(connectionStatus.value.state).toBe('unsupported')
  })

  it('asks only after the button is pressed, then lists inputs and outputs separately', async () => {
    const rig = await open({ permission: 'prompt' })
    expect(rig.nav.calls).toHaveLength(0)
    expect(rig.root.textContent).toContain('Your browser will ask')
    click(byLabel(rig.root, 'Allow MIDI access'))
    await settle()
    expect(rig.nav.calls).toEqual([{ sysex: false }])
    // Once granted, the same step is the piano input: no access text or button remains.
    expect(byLabel(rig.root, 'Allow MIDI access')).toBeNull()
    expect($$(section(rig.root, 'piano'), 'input[type="radio"]')).toHaveLength(1)
    // Outputs are a separate list, with an explicit "no output" choice.
    expect($$(section(rig.root, 'playback'), 'input[type="radio"]')).toHaveLength(2)
  })

  it('connects straight away when the permission is already granted (no prompt possible)', async () => {
    const rig = await open({ permission: 'granted' })
    expect(rig.nav.calls).toHaveLength(1)
    expect(byLabel(rig.root, 'Allow MIDI access')).toBeNull()
    expect(section(rig.root, 'piano').textContent).toContain('Choose your piano')
  })

  it('explains how to re-allow a blocked permission and lets the learner try again', async () => {
    const rig = await open({ outcome: 'deny' })
    click(byLabel(rig.root, 'Allow MIDI access'))
    await settle()
    const access = section(rig.root, 'piano')
    expect(access.textContent).toContain('MIDI access is blocked')
    expect(access.textContent).toContain('Site settings')
    expect(connectionStatus.value.state).toBe('denied')
    click(byLabel(rig.root, 'Try again'))
    await settle()
    expect(rig.nav.calls).toHaveLength(2)
  })

  it('keeps Bluetooth pairing with the system and says Bluetooth audio is not enough', async () => {
    const rig = await open()
    const guide = $(section(rig.root, 'piano'), 'details')
    expect(guide?.textContent).toContain('this website never pairs devices')
    expect(guide?.textContent).toContain('Bluetooth audio alone is not enough')
    expect(guide?.textContent).toContain('interface’s MIDI Out goes to the piano’s MIDI In')
  })
})

describe('Piano step: input and live test (spec "MIDI input, output, and pedal controls")', () => {
  it('selects and remembers the piano input and drives the connection status', async () => {
    const rig = await open()
    click(byLabel(rig.root, 'Allow MIDI access'))
    await settle()
    click(radioFor(section(rig.root, 'piano'), 'Digital Piano'))
    await settle()
    expect(settings.value.route).toMatchObject({ inputId: 'in-1', inputName: 'Digital Piano' })
    expect(connectionStatus.value).toMatchObject({ state: 'connected', inputName: 'Digital Piano' })
    expect(rig.root.textContent).toContain('Listening to Digital Piano')
    expect(rig.root.textContent).toContain('Remembered:')
  })

  it('shows held keys with velocity, counts every event once and lists the last events', async () => {
    const rig = await open()
    await connectAll(rig)
    await rig.play([0x90, 60, 100])
    const key = $(rig.root, '[data-midi="60"]')
    expect(key?.hasAttribute('data-held')).toBe(true)
    expect($(rig.root, 'svg[role="img"]')?.getAttribute('aria-label')).toBe('Held keys: C4')
    expect(byText(rig.root, 'C4 (60)')).not.toBeNull()
    expect(byText(rig.root, 'vel 100')).not.toBeNull()
    // Note On velocity 0 is a release; a sustained key is outlined, not held.
    await rig.play([0xb0, 64, 127])
    await rig.play([0x90, 60, 0])
    expect($(rig.root, '[data-midi="60"]')?.hasAttribute('data-held')).toBe(false)
    expect($(rig.root, '[data-midi="60"]')?.hasAttribute('data-sustained')).toBe(true)
    expect($(rig.root, '[data-testid="count-noteon"]')?.textContent).toBe('1')
    expect($(rig.root, '[data-testid="count-noteoff"]')?.textContent).toBe('1')
    expect($(rig.root, '[data-testid="count-cc"]')?.textContent).toBe('1')
  })

  it('meters every controller with its value and threshold and records the observed pedals', async () => {
    const rig = await open()
    await connectAll(rig)
    await rig.play([0xb0, 64, 127])
    await rig.play([0xb0, 67, 40])
    await rig.play([0xb0, 0, 1]) // bank select: shown, never recorded as a pedal
    const meter = $$(rig.root, '[role="meter"]').find((m) => m.getAttribute('aria-label') === 'Sustain · CC 64 value')
    expect(meter?.getAttribute('aria-valuenow')).toBe('127')
    expect(meter?.getAttribute('aria-valuetext')).toBe('127, down')
    expect(rig.root.textContent).toContain('Threshold 64 (conventional)')
    expect(settings.value.pedal.observedControllers).toEqual([64, 67])
  })

  it('preserves legacy route metadata while selecting MIDI ports', async () => {
    updateSettings({ route: { connection: 'bluetooth' } })
    const rig = await open()
    await connectAll(rig)
    expect(settings.value.route).toMatchObject({
      inputId: 'in-1',
      outputId: 'out-1',
      connection: 'bluetooth',
    })
  })
})

describe('Playback step: test notes, confirmation and echo (DECISIONS C11)', () => {
  it('plays the probe on the chosen channel and records the answer and the echo verdict', async () => {
    const rig = await open()
    await connectAll(rig)
    type($(section(rig.root, 'playback'), 'select'), '2')
    expect(settings.value.route.outputChannel).toBe(2)
    click(byLabel(rig.root, 'Play test notes'))
    expect(rig.out.sent.map((m) => m.data)).toEqual([
      [0x92, 61, 37],
      [0x82, 61, 0],
      [0x92, 66, 83],
      [0x82, 66, 0],
      [0x92, 70, 59],
      [0x82, 70, 0],
    ])
    expect(rig.root.textContent).toContain('Did the piano itself play three short notes?')
    click(byLabel(rig.root, 'Yes, I heard them'))
    expect(settings.value.route.outputVerified).toBe(true)
    await settle()
    expect(section(rig.root, 'playback').textContent).toContain('The piano sounds on channel 3')
    expect(section(rig.root, 'playback').getAttribute('data-tone')).toBe('action') // echo still listening
    await act(async () => {
      rig.clock.fire()
      await Promise.resolve()
    })
    await settle()
    expect(settings.value.route.echo).toBe('none')
    expect(section(rig.root, 'playback').getAttribute('data-tone')).toBe('done')
    expect(rig.root.textContent).toContain('ready for both-hands and one-hand practice')
  })

  it('on "No sound" suggests channel, cable direction and that a port is not proof', async () => {
    const rig = await open()
    await connectAll(rig)
    click(byLabel(rig.root, 'Play test notes'))
    click(byLabel(rig.root, 'No sound'))
    const text = section(rig.root, 'playback').textContent ?? ''
    expect(settings.value.route.outputVerified).toBe(false)
    expect(text).toContain('Try another receive channel')
    expect(text).toContain('MIDI Out must go to the piano’s MIDI In')
    expect(text).toContain('not proof')
  })

  it('a new channel clears the verification and the echo verdict of the old one', async () => {
    const rig = await open()
    await connectAll(rig)
    await hearTestNotes(rig)
    expect(settings.value.route).toMatchObject({ outputVerified: true, echo: 'none' })
    type($(section(rig.root, 'playback'), 'select'), '5')
    expect(settings.value.route).toMatchObject({ outputChannel: 5, outputVerified: false, echo: 'untested' })
    expect(section(rig.root, 'playback').textContent).toContain('Play the test notes')
  })
})

describe('Hint pedal (spec acceptance "Pedal hints")', () => {
  it('learns the middle pedal, confirms one trigger per press, and saves it', async () => {
    const rig = await open()
    await connectAll(rig)
    const pedal = () => section(rig.root, 'pedal')
    click(byLabel(pedal(), 'Set hint pedal'))
    await settle()
    expect(pedal().textContent).toContain('Press and release the pedal you want to use')
    await rig.play([0xb0, 66, 127])
    await rig.play([0xb0, 66, 0])
    expect(pedal().textContent).toContain('Detected: Sostenuto (middle pedal)')
    expect(pedal().textContent).toContain('Now press it once more')
    await rig.play([0xb0, 66, 127])
    expect(pedal().textContent).toContain('Hint! Now release the pedal.')
    await rig.play([0xb0, 66, 0])
    expect(pedal().textContent).toContain('It works: one press, one hint')
    // Holding (with a wobble) never retriggers; the next press after release does.
    await rig.play([0xb0, 66, 127])
    await rig.play([0xb0, 66, 120])
    await rig.play([0xb0, 66, 127])
    expect($(pedal(), '[data-testid="hint-trigger-count"]')?.textContent).toBe('2')
    await rig.play([0xb0, 66, 0])
    await rig.play([0xb0, 66, 127])
    expect($(pedal(), '[data-testid="hint-trigger-count"]')?.textContent).toBe('3')
    click(byLabel(pedal(), 'Save hint pedal'))
    expect(settings.value.pedal.hintPedal).toMatchObject({
      controller: 66,
      channel: 0,
      inverted: false,
      verified: true,
    })
    expect(pedal().textContent).toContain('Hint pedal saved')
    expect(pedal().getAttribute('data-tone')).toBe('done')
  })

  it('explains alternative hints when the middle pedal is not transmitted', async () => {
    const rig = await open()
    await connectAll(rig)
    click(byLabel(section(rig.root, 'pedal'), 'Set hint pedal'))
    await rig.play([0xb0, 67, 127])
    await rig.play([0xb0, 67, 0])
    const text = section(rig.root, 'pedal').textContent ?? ''
    expect(text).toContain('Detected: Soft (left pedal)')
    expect(text).toContain(NO_MIDDLE_PEDAL_EXPLANATION)
    expect(text).toContain('You can enable automatic hints in Settings without a pedal')
  })

  it('mirrors the hint pedal action from Settings → Pedal', async () => {
    const rig = await open()
    const keys = $$(section(rig.root, 'pedal'), '[role="radio"]').find((r) => r.textContent === 'Show keys')
    click(keys)
    expect(settings.value.pedal.hintPedalAction).toBe('keys')
  })

  it('adjusting the inversion of a saved pedal requires a new test', async () => {
    updateSettings({
      pedal: {
        hintPedal: {
          channel: 0,
          controller: 66,
          threshold: 64,
          inverted: false,
          observedMin: 0,
          observedMax: 127,
          verified: true,
        },
      },
    })
    const rig = await open()
    await connectAll(rig)
    const pedal = section(rig.root, 'pedal')
    const inverted = $$(pedal, 'label').find((l) => l.textContent?.startsWith('Inverted pedal'))
    click($(inverted!, 'input'))
    await settle()
    expect(pedal.textContent).toContain('Now press it once more')
    expect(byLabel(pedal, 'Save hint pedal')).toBeNull()
  })
})

describe('Playback step: accompaniment options', () => {
  it('says in its status what graded accompaniment still needs', async () => {
    const rig = await open()
    await connectAll(rig)
    expect(section(rig.root, 'playback').textContent).toContain('Play the test notes')
    expect(rig.root.textContent).toContain('ready for both-hands practice. One-hand practice needs')
    updateSettings({ route: { outputVerified: true, echo: 'echo-detected' } })
    await settle()
    expect(section(rig.root, 'playback').textContent).toContain('Echo detected')
    updateSettings({ route: { echo: 'none' } })
    await settle()
    expect(section(rig.root, 'playback').textContent).toContain('Piano sounds on channel 1')
    expect(section(rig.root, 'playback').getAttribute('data-tone')).toBe('done')
  })

  it('keeps score pedals in one-hand practice off by default and lets the learner opt in', async () => {
    const rig = await open()
    const row = $$(rig.root, 'label').find((l) => l.textContent?.startsWith('Send score pedals in one-hand practice'))
    const input = $(row!, 'input') as HTMLInputElement
    expect(input.checked).toBe(false)
    click(input)
    expect(settings.value.route.automaticPedalsInHandPractice).toBe(true)
  })

  it('Stop sound sends All Notes Off on the app channel only', async () => {
    const rig = await open()
    await connectAll(rig)
    type($(section(rig.root, 'playback'), 'select'), '3')
    let ownerCalls = 0
    getMidiService().registerSoundOwner(() => ownerCalls++)
    click(byLabel(rig.root, 'Stop sound'))
    expect(ownerCalls).toBe(1)
    expect(rig.out.sent.map((m) => m.data)).toEqual([[0xb3, 123, 0]])
    expect(section(rig.root, 'playback').textContent).toContain('Sent “all notes off” to Digital Piano on channel 4')
  })
})

describe('Route memory and exit', () => {
  it('reselects the remembered piano when it is plugged in later', async () => {
    updateSettings({ route: { inputId: 'in-9', inputName: 'Stage Piano' } })
    const rig = await open({ permission: 'granted' })
    expect(rig.root.textContent).toContain('Your remembered piano, Stage Piano, is not connected')
    flush(() => rig.access.addInput(new FakeInput('in-9', 'Stage Piano')))
    await settle()
    expect(connectionStatus.value).toMatchObject({ state: 'connected', inputName: 'Stage Piano' })
    expect(section(rig.root, 'piano').textContent).toContain('Remembered')
  })

  it('reports a disconnected piano in the input step', async () => {
    const rig = await open()
    await connectAll(rig)
    flush(() => rig.access.setState(rig.piano, 'disconnected'))
    await settle()
    expect(section(rig.root, 'piano').textContent).toContain('Digital Piano is disconnected')
    expect(section(rig.root, 'piano').getAttribute('data-tone')).toBe('action')
  })

  it('offers a clear exit: Done closes the modal and leaves the current view alone', async () => {
    currentView.value = 'practice'
    const rig = await open()
    click(byLabel(rig.root, 'Done'))
    expect(connectionOpen.value).toBe(false)
    expect(currentView.value).toBe('practice')
  })

  it('shows each setup section with a text status without redundant navigation or connection type', async () => {
    const rig = await open()
    const sections = $$(rig.root, 'section[data-step]')
    expect(sections.map((step) => $(step, 'h2')?.textContent)).toEqual([
      'Step 1: Your piano',
      'Step 2: Playback to the piano',
      'Step 3: Hint pedal',
    ])
    for (const [index, status] of ['Not allowed yet', 'Needs MIDI access', 'Optional'].entries()) {
      expect($(sections[index]!, 'header')?.textContent).toContain(status)
    }
    expect($(rig.root, 'nav[aria-label="Setup steps"]')).toBeNull()
    expect($(rig.root, '[role="radiogroup"][aria-label="Connection type"]')).toBeNull()
  })
})

describe('Dark theme', () => {
  it('renders every step under data-theme="dark"', async () => {
    document.documentElement.dataset['theme'] = 'dark'
    const rig = await open()
    await connectAll(rig)
    await rig.play([0x90, 64, 90])
    expect($$(rig.root, 'section[data-step]')).toHaveLength(3)
    expect($(rig.root, 'aside')).not.toBeNull()
    expect($(rig.root, '[data-midi="64"]')?.hasAttribute('data-held')).toBe(true)
  })
})
