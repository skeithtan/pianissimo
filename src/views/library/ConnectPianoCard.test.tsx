// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { connectionOpen, settingsOpen } from '../../app/navigation'
import { getMidiService, resetServicesForTests } from '../../app/services'
import {
  beginSettingsLoad,
  resetAppStateForTests,
  setSettingsPersistence,
  settings,
  updateSettings,
} from '../../app/state'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from '../../core/midi/fakeWebMidi'
import { $, byLabel, click, flush, mount, type Mounted } from '../shared/testing'
import { untranslatedText, usePseudoCatalog } from '../shared/catalogTesting'
import { msg } from '../../i18n/messages'
import { ConnectPiano } from './ConnectPianoCard'

let view: Mounted | null = null
let access: FakeAccess

beforeEach(() => {
  resetAppStateForTests()
  access = new FakeAccess()
})
afterEach(() => {
  view?.unmount()
  view = null
  vi.useRealTimers()
  settingsOpen.value = false
  resetServicesForTests()
  resetAppStateForTests()
})

const plugIn = (name: string) => {
  const input = new FakeInput(`in-${name}`, name)
  access.addInput(input)
  access.addOutput(new FakeOutput(`out-${name}`, name))
  return input
}
function open(outcome: 'grant' | 'deny' = 'grant'): HTMLElement {
  resetServicesForTests({ navigator: fakeNavigator(access, outcome) })
  view = mount(<ConnectPiano service={getMidiService()} />)
  return view.container
}
const settle = (change: () => void) =>
  act(async () => {
    change()
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
const press = (root: HTMLElement, text: string) => settle(() => click(byLabel(root, text)))
const key = (input: FakeInput) => flush(() => input.emit([0x90, 60, 80], performance.now()))

describe('the connect card (U149)', () => {
  it('takes the only piano, waits for a key and goes away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const piano = plugIn('Digital Piano')
    const root = open()
    expect(root.textContent).toContain('Or open any piece to listen and read.')
    await press(root, 'Connect')
    expect(root.textContent).toContain('Play any key to check it.')
    expect(settings.value.route).toMatchObject({ inputName: 'Digital Piano', outputName: 'Digital Piano' })
    await act(async () => key(piano))
    expect(root.textContent).toContain('Your piano is ready.')
    await act(async () => void vi.advanceTimersByTime(3000))
    expect(root.textContent).toBe('')
  })

  it('lists several pianos; the chosen one plays through its own output', async () => {
    plugIn('Stage')
    plugIn('Upright')
    const root = open()
    await press(root, 'Connect')
    await press(root, 'Upright')
    expect(root.textContent).toContain('Play any key to check it.')
    expect(settings.value.route).toMatchObject({ inputName: 'Upright', outputName: 'Upright' })
  })

  it('says when there is none, and takes one that is plugged in', async () => {
    const root = open()
    await press(root, 'Connect')
    expect(root.textContent).toContain('No piano found.')
    await press(root, 'More help')
    expect(connectionOpen.value).toBe(true)
    await settle(() => void plugIn('Digital Piano'))
    await settle(() => undefined)
    expect(root.textContent).toContain('Play any key to check it.')
  })

  it('says plainly that the browser blocks it', async () => {
    const restore = usePseudoCatalog()
    try {
      plugIn('Digital Piano')
      const root = open('deny')
      expect(untranslatedText(root)).toEqual([])
      await press(root, msg('Connect'))
      expect(root.textContent).toContain(
        msg('The browser is blocking your piano. Allow it for this site in the browser’s settings.'),
      )
      expect(untranslatedText(root)).toEqual([])
    } finally {
      restore()
    }
  })

  it('waits for stored settings and stays away once a piano is remembered', async () => {
    beginSettingsLoad()
    const root = open()
    expect($(root, '[data-testid="connect-piano"]')).toBeNull()
    await act(async () => void (await setSettingsPersistence(null)))
    expect($(root, '[data-testid="connect-piano"]')).not.toBeNull()
    act(() => updateSettings({ route: { inputId: 'in-1', inputName: 'Digital Piano' } }))
    expect($(root, '[data-testid="connect-piano"]')).toBeNull()
  })
})
