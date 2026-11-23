// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { resetAppStateForTests, settings, updateSettings } from '../../app/state'
import { msg } from '../../i18n/messages'
import { useCatalog } from '../shared/catalogTesting'
import { $, $$, byText, click, mount, type Mounted } from '../shared/testing'
import { MetronomeOutputSettings } from './MetronomeOutputSettings'

function output(deviceId: string, label: string): MediaDeviceInfo {
  return { deviceId, label, kind: 'audiooutput', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo
}

interface FakeMediaDevices {
  enumerateDevices: () => Promise<MediaDeviceInfo[]>
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<{ getTracks(): { stop(): void }[] }>
  selectAudioOutput?: () => Promise<MediaDeviceInfo>
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

/** Fake `navigator.mediaDevices` and an AudioContext with or without `setSinkId`. */
function install(media: Partial<FakeMediaDevices>, { canSelect = true } = {}): FakeMediaDevices {
  class FakeAudioContext {}
  if (canSelect) Object.assign(FakeAudioContext.prototype, { setSinkId: () => Promise.resolve() })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  const full: FakeMediaDevices = {
    enumerateDevices: vi.fn(async () => [output('default', 'Default'), output('usb', 'USB Audio')]),
    getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...media,
  }
  Object.defineProperty(navigator, 'mediaDevices', { value: full, configurable: true })
  return full
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })

let view: Mounted | null = null
beforeEach(() => {
  resetAppStateForTests()
})
afterEach(() => {
  view?.unmount()
  view = null
  vi.unstubAllGlobals()
  delete (navigator as { mediaDevices?: unknown }).mediaDevices
  resetAppStateForTests()
})

const select = () => $(view!.container, 'select') as HTMLSelectElement | null
const optionTexts = () => $$(view!.container, 'option').map((o) => o.textContent)
const showButton = () => byText(view!.container, msg('Show audio outputs'), 'button span')?.closest('button') ?? null

describe('<MetronomeOutputSettings>', () => {
  it('shows a saved output as loading, never as unavailable, until the list arrives', async () => {
    let resolve: (devices: MediaDeviceInfo[]) => void = () => undefined
    install({ enumerateDevices: () => new Promise((done) => (resolve = done)) })
    updateSettings({ metronome: { outputId: 'usb' } })
    view = mount(<MetronomeOutputSettings />)
    expect(view.container.textContent).not.toContain('Saved output unavailable')
    expect(select()?.disabled).toBe(true)
    expect(select()?.selectedOptions[0]?.textContent).toBe('Loading…')
    await act(async () => {
      resolve([output('default', 'Default'), output('usb', 'USB Audio')])
      await Promise.resolve()
    })
    await settle()
    expect(view.container.textContent).not.toContain('Saved output unavailable')
    expect(select()?.disabled).toBe(false)
    expect(select()?.value).toBe('usb')
    expect(select()?.selectedOptions[0]?.textContent).toBe('USB Audio')
  })

  it('still says when a saved output is gone once the list has loaded', async () => {
    install({ enumerateDevices: async () => [output('default', 'Default'), output('other', 'Speakers')] })
    updateSettings({ metronome: { outputId: 'usb' } })
    view = mount(<MetronomeOutputSettings />)
    await settle()
    expect(optionTexts()).toEqual(['System audio', 'Saved output unavailable', 'Speakers'])
  })

  it('hides the picker where the browser cannot send audio to a chosen output', async () => {
    const media = install({}, { canSelect: false })
    view = mount(<MetronomeOutputSettings />)
    await settle()
    expect(select()).toBeNull()
    expect(view.container.textContent).toContain('use your device’s audio output controls')
    expect(byText(view.container, 'Test click', 'button span')).not.toBeNull()
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })

  it('asks for the microphone only when Show audio outputs is tapped, stops it, and lists the outputs', async () => {
    const stop = vi.fn()
    let granted = false
    const media = install({
      enumerateDevices: vi.fn(async () =>
        granted ? [output('default', 'Default - Speakers'), output('usb', 'USB Audio')] : [output('', '')],
      ),
      getUserMedia: vi.fn(async () => {
        granted = true
        return { getTracks: () => [{ stop }, { stop }] }
      }),
    })
    view = mount(<MetronomeOutputSettings />)
    await settle()
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(optionTexts()).toEqual(['System audio'])
    expect(view.container.textContent).toContain('only after you allow the microphone')
    click(showButton())
    await settle()
    expect(media.getUserMedia).toHaveBeenCalledTimes(1)
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(stop).toHaveBeenCalledTimes(2)
    expect(optionTexts()).toEqual(['System audio', 'USB Audio'])
    expect(showButton()).toBeNull()
    expect(view.container.textContent).not.toContain('allow the microphone')
  })

  it('explains a refusal in the interface language and keeps the button', async () => {
    const restore = useCatalog('es-ES')
    try {
      install({
        enumerateDevices: async () => [output('', '')],
        getUserMedia: async () => {
          throw new DOMException('Permission denied', 'NotAllowedError')
        },
      })
      view = mount(<MetronomeOutputSettings />)
      await settle()
      click(showButton())
      await settle()
      expect(view.container.textContent).toContain(
        'El navegador no lo ha permitido, así que sus salidas de audio siguen ocultas. Se usa el audio del sistema.',
      )
      expect(showButton()?.disabled).toBe(false)
      expect(settings.value.metronome.outputId).toBeNull()
    } finally {
      restore()
    }
  })

  it('uses the browser’s own output picker where there is one, and saves the chosen output', async () => {
    let chosen = false
    const media = install({
      enumerateDevices: vi.fn(async () => (chosen ? [output('usb', 'USB Audio')] : [output('', '')])),
      selectAudioOutput: vi.fn(async () => {
        chosen = true
        return output('usb', 'USB Audio')
      }),
    })
    view = mount(<MetronomeOutputSettings />)
    await settle()
    expect(view.container.textContent).toContain('choose one in its own list')
    click(showButton())
    await settle()
    expect(media.selectAudioOutput).toHaveBeenCalledTimes(1)
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(settings.value.metronome.outputId).toBe('usb')
    expect(select()?.value).toBe('usb')
  })
})
