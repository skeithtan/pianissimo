// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { $, $$, byLabel, byText, click, mount, type Mounted } from '../views/shared/testing'
import { ALL_FEATURES } from '../views/settings/testkit'
import { discardLabelDraft } from '../views/settings/labelDraft'
import { App } from './App'
import { resetCapabilityBannerForTests } from './CapabilityBanner'
import { detectFeatures } from './features'
import { resetViewCacheForTests } from './LazyView'
import { connectionOpen, currentView, navigate, openConnection, openSettings, settingsOpen } from './navigation'
import { applyTheme, startThemeSync } from './theme'
import {
  connectionStatus,
  notices,
  pushNotice,
  resetAppStateForTests,
  setSettingsPersistence,
  settings,
  updateSettings,
} from './state'
import { overlayScreens, views } from './views'
import { resetServicesForTests } from './services'
import { openFresh } from '../core/storage/testkit'

let view: Mounted | null = null
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

beforeEach(() => {
  // The Library (first screen) opens storage: give it a fresh in-memory database.
  resetServicesForTests({ openStorage: () => openFresh() })
  resetAppStateForTests()
  resetViewCacheForTests()
  resetCapabilityBannerForTests()
  discardLabelDraft()
  settingsOpen.value = false
  connectionOpen.value = false
  currentView.value = 'library'
})
afterEach(() => {
  view?.unmount()
  view = null
  vi.useRealTimers()
})

async function open(features = ALL_FEATURES) {
  view = mount(<App features={features} />)
  await settle()
  return view.container
}

describe('<App> shell', () => {
  it('renders the library view with the app bar', async () => {
    const root = await open()
    expect(byLabel(root, 'Pianissimo, go to the library')).not.toBeNull() // app bar
    expect(byLabel(root, 'Settings')).not.toBeNull()
    expect(root.textContent).toContain('Pianissimo')
    expect(byText(root, 'Library')).not.toBeNull()
    expect($(root, 'main')?.getAttribute('data-view')).toBe('library')
  })

  it('navigates between views through the registry, lazily', async () => {
    const root = await open()
    act(() => navigate('results'))
    // The real Results view is a larger lazy chunk: wait for it rather than a fixed delay.
    for (let i = 0; i < 100 && !byText(root, 'Results'); i++) await settle()
    expect(byText(root, 'Results')).not.toBeNull()
    expect($(root, 'main')?.getAttribute('data-view')).toBe('results')
  })

  it('gives the practice view the whole viewport: no app bar', async () => {
    currentView.value = 'practice'
    const root = await open()
    expect(views.practice.chrome).toBe('none')
    expect(byLabel(root, 'Pianissimo, go to the library')).toBeNull() // no app bar
    expect($(root, 'main')?.getAttribute('data-chrome')).toBe('none')
    // The real Practice view is a larger lazy chunk: wait for it.
    for (let i = 0; i < 100 && !byText(root, 'Practice'); i++) await settle()
    expect(byText(root, 'Practice')).not.toBeNull()
  })

  it('has an entry for every view: the Library bundled, the others lazy', async () => {
    expect(typeof views.library.component).toBe('function')
    for (const name of ['practice', 'results'] as const) {
      const entry = views[name]
      expect(entry.component === undefined ? typeof entry.load : 'component').toBe('function')
    }
    // The Connection setup is a lazy modal screen, not a view.
    expect('connection' in views).toBe(false)
    expect(typeof overlayScreens.connection.load).toBe('function')
  })

  it('moves focus into the new view after navigation', async () => {
    const root = await open()
    act(() => navigate('results'))
    await settle()
    expect(document.activeElement).toBe($(root, 'main'))
  })

  it('opens Settings over the current view without unmounting it', async () => {
    const root = await open()
    const heading = byText(root, 'Library')
    click(byLabel(root, 'Settings'))
    await settle()
    expect(settingsOpen.value).toBe(true)
    expect($(root, 'dialog[open]')?.querySelectorAll('[role="tab"]').length).toBe(7)
    expect(byText(root, 'Library')).toBe(heading) // same node: view stayed mounted
    click(byLabel($(root, 'dialog[open]')!, 'Close'))
    expect(currentView.value).toBe('library')
    expect(settingsOpen.value).toBe(false)
  })
})

describe('connection setup modal', () => {
  it('opens over the current view, loads its content lazily, and closes with the close button', async () => {
    const root = await open()
    const heading = byText(root, 'Library')
    expect($(root, 'dialog[open]')).toBeNull()
    act(() => openConnection())
    for (let i = 0; i < 100 && !$(root, 'nav[aria-label="Setup steps"]'); i++) await settle()
    expect($(root, 'dialog[open]')?.getAttribute('aria-label')).toBe('Connection and Pedal Setup')
    expect($(root, 'nav[aria-label="Setup steps"]')).not.toBeNull()
    expect(currentView.value).toBe('library') // not a page: the view stays
    expect(byText(root, 'Library')).toBe(heading)
    click(byLabel($(root, 'dialog[open]')!, 'Close'))
    expect(connectionOpen.value).toBe(false)
    for (let i = 0; i < 50 && $(root, 'dialog[open]'); i++) await settle() // the sheet fades out first
    expect($(root, 'dialog[open]')).toBeNull()
  })

  it('keeps navigate("connection") working as an alias that opens the modal', async () => {
    currentView.value = 'practice'
    const root = await open()
    act(() => navigate('connection'))
    await settle()
    expect(connectionOpen.value).toBe(true)
    expect(currentView.value).toBe('practice')
    expect($(root, 'main')?.getAttribute('data-view')).toBe('practice')
  })

  it('is one overlay at a time: Settings replaces it and a page change closes it', async () => {
    await open()
    act(() => openConnection())
    expect(connectionOpen.value).toBe(true)
    act(() => openSettings())
    expect([settingsOpen.value, connectionOpen.value]).toEqual([true, false])
    act(() => openConnection())
    expect([settingsOpen.value, connectionOpen.value]).toEqual([false, true])
    act(() => navigate('results'))
    expect([settingsOpen.value, connectionOpen.value]).toEqual([false, false])
  })
})

describe('connection chip', () => {
  const chip = (root: HTMLElement) => $(root, '[data-state]') as HTMLElement

  it('follows the connection status signal', async () => {
    const root = await open()
    expect(chip(root).getAttribute('data-state')).toBe('disconnected')
    expect(chip(root).textContent).toMatch(/Piano not connected/u)
    act(() => {
      connectionStatus.value = { state: 'connecting' }
    })
    expect(chip(root).textContent).toMatch(/Connecting/u)
    act(() => {
      connectionStatus.value = { state: 'connected', inputName: 'Roland FP-30X', outputName: 'Roland FP-30X' }
    })
    expect(chip(root).textContent).toContain('Roland FP-30X')
    expect(chip(root).getAttribute('data-tone')).toBe('good')
    act(() => {
      connectionStatus.value = { state: 'denied', detail: 'Permission denied' }
    })
    expect(chip(root).textContent).toMatch(/MIDI access blocked/u)
    expect(chip(root).title).toBe('Permission denied')
    act(() => {
      connectionStatus.value = { state: 'unsupported' }
    })
    expect(chip(root).textContent).toMatch(/No MIDI in this browser/u)
    expect(chip(root).getAttribute('data-tone')).toBe('warn')
  })

  it('opens the Connection setup modal when tapped, over the current view', async () => {
    const root = await open()
    click(chip(root))
    await settle()
    expect(connectionOpen.value).toBe(true)
    expect(currentView.value).toBe('library')
  })
})

describe('capability banner', () => {
  it('explains missing Web MIDI on the library with the workaround, and can be dismissed', async () => {
    vi.useFakeTimers()
    const noMidi = detectFeatures({
      navigator: { wakeLock: {}, storage: { persist: () => undefined } },
      AudioContext: class {},
      Worker: class {
        constructor(_u: string, o?: { type?: string }) {
          void o?.type
        }
        terminate(): void {}
      },
      indexedDB: {},
    })
    view = mount(<App features={noMidi} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const root = view.container
    expect(root.textContent).toMatch(/Safari does not offer it/u)
    expect(root.textContent).toMatch(/MIDIWeb/u)
    click(byLabel(root, 'Dismiss'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(root.textContent).not.toMatch(/Safari does not offer it/u)
  })

  it('stays quiet when everything needed is present, and for optional features', async () => {
    const root = await open(
      detectFeatures({
        navigator: { requestMIDIAccess: () => undefined },
        AudioContext: class {},
        Worker: class {
          constructor(_u: string, o?: { type?: string }) {
            void o?.type
          }
          terminate(): void {}
        },
        indexedDB: {},
      }),
    )
    expect(root.textContent).not.toMatch(/Keep screen awake|Persistent storage/u)
    expect($$(root, '[role="status"]').some((n) => /unavailable|cannot/u.test(n.textContent ?? ''))).toBe(false)
  })
})

describe('notices', () => {
  it('shows toasts, fades them out and removes them', async () => {
    vi.useFakeTimers()
    view = mount(<App features={ALL_FEATURES} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const root = view.container
    act(() => {
      pushNotice({ kind: 'success', text: 'Score imported' })
    })
    expect(byText(root, 'Score imported')).not.toBeNull()
    const toast = byText(root, 'Score imported')!.closest<HTMLElement>('[data-kind]')!
    expect(toast.getAttribute('data-kind')).toBe('success')

    click(byLabel(toast, 'Dismiss'))
    expect(notices.value).toEqual([])
    // Still mounted, fading out.
    const fading = byText(root, 'Score imported')!.closest<HTMLElement>('[data-kind]')!
    expect(fading.style.opacity).toBe('0')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(byText(root, 'Score imported')).toBeNull()
  })

  it('announces errors assertively', async () => {
    const root = await open()
    act(() => {
      pushNotice({ kind: 'error', text: 'Import failed' })
    })
    expect(byText(root, 'Import failed')!.closest('[role="alert"]')).not.toBeNull()
  })
})

describe('theme', () => {
  it('applies data-theme from settings and clears it for system', () => {
    const root = document.createElement('div')
    const stop = startThemeSync(root)
    expect(root.hasAttribute('data-theme')).toBe(false)
    updateSettings({ view: { theme: 'dark' } })
    expect(root.getAttribute('data-theme')).toBe('dark')
    updateSettings({ view: { theme: 'light' } })
    expect(root.getAttribute('data-theme')).toBe('light')
    updateSettings({ view: { theme: 'system' } })
    expect(root.hasAttribute('data-theme')).toBe(false)
    stop()
    updateSettings({ view: { theme: 'dark' } })
    expect(root.hasAttribute('data-theme')).toBe(false) // stopped
  })

  it('keeps the cached theme on screen while stored settings load, then follows them', async () => {
    localStorage.setItem('pianissimo.theme', 'dark')
    let finishLoad: (v: unknown) => void = () => undefined
    const ready = setSettingsPersistence({
      load: () => new Promise((resolve) => (finishLoad = resolve)),
      save: () => undefined,
    })
    const root = document.createElement('div')
    const stop = startThemeSync(root)
    expect(root.getAttribute('data-theme')).toBe('dark') // not reset to the default "system"
    finishLoad({ view: { theme: 'light' } })
    await ready
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('pianissimo.theme')).toBe('light')
    stop()
    localStorage.removeItem('pianissimo.theme')
  })

  it('applyTheme sets and removes the attribute', () => {
    const root = document.createElement('div')
    applyTheme('dark', root)
    expect(root.getAttribute('data-theme')).toBe('dark')
    applyTheme('system', root)
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('survives unavailable localStorage', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked')
      },
    })
    try {
      const root = document.createElement('div')
      const stop = startThemeSync(root)
      updateSettings({ view: { theme: 'dark' } })
      expect(root.getAttribute('data-theme')).toBe('dark')
      stop()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
    expect(settings.value.view.theme).toBe('dark')
  })
})
