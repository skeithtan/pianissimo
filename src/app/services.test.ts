import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from '../core/midi/fakeWebMidi'
import { DEFAULT_SETTINGS } from '../core/model/settings'
import type { PianissimoStorage } from '../core/storage'
import { openFresh } from '../core/storage/testkit'
import {
  STORAGE_UNAVAILABLE_NOTICE,
  connectSettingsStorage,
  getMidi,
  getMidiService,
  getStorage,
  resetServicesForTests,
  startServices,
} from './services'
import {
  SETTINGS_SAVE_DEBOUNCE_MS,
  connectionStatus,
  flushSettings,
  notices,
  resetAppStateForTests,
  settings,
  settingsLoading,
  updateSettings,
} from './state'

const opened: PianissimoStorage[] = []

function freshStorage(): Promise<PianissimoStorage> {
  return openFresh().then((s) => {
    opened.push(s)
    return s
  })
}

beforeEach(() => {
  resetAppStateForTests()
  resetServicesForTests()
})
afterEach(async () => {
  await flushSettings()
  resetServicesForTests()
  resetAppStateForTests()
  for (const s of opened.splice(0)) s.close()
  vi.useRealTimers()
})

describe('getStorage', () => {
  it('opens once, lazily, and attaches the history lifecycle once', async () => {
    const open = vi.fn(freshStorage)
    resetServicesForTests({ openStorage: open })
    expect(open).not.toHaveBeenCalled()
    const [a, b] = await Promise.all([getStorage(), getStorage()])
    expect(a).toBe(b)
    expect(open).toHaveBeenCalledTimes(1)
    const attach = vi.spyOn(a.history, 'attachLifecycle')
    await getStorage()
    expect(attach).not.toHaveBeenCalled() // already attached on open
  })

  it('does not cache a failed open, so a later call retries', async () => {
    let fail = true
    resetServicesForTests({
      openStorage: () => (fail ? Promise.reject(new Error('blocked')) : freshStorage()),
    })
    await expect(getStorage()).rejects.toThrow('blocked')
    fail = false
    await expect(getStorage()).resolves.toBeDefined()
  })
})

describe('connectSettingsStorage', () => {
  it('loads stored settings and saves later changes to IndexedDB', async () => {
    const storage = await freshStorage()
    await storage.saveSettings({ ...DEFAULT_SETTINGS, naming: { ...DEFAULT_SETTINGS.naming, system: 'fixed-do' } })
    resetServicesForTests({ openStorage: () => Promise.resolve(storage) })
    expect(await connectSettingsStorage()).toBe(true)
    expect(settings.value.naming.system).toBe('fixed-do')
    updateSettings({ route: { accompanimentLevel: 0.5 } })
    await flushSettings()
    expect((await storage.loadSettings()).route.accompanimentLevel).toBe(0.5)
  })

  it('falls back to memory with one warning when IndexedDB is unavailable', async () => {
    resetServicesForTests({ openStorage: () => Promise.reject(new Error('InvalidStateError')) })
    expect(await connectSettingsStorage()).toBe(false)
    expect(settingsLoading.value).toBe(false)
    expect(notices.value.map((n) => [n.kind, n.text])).toEqual([['warning', STORAGE_UNAVAILABLE_NOTICE]])
    vi.useFakeTimers()
    updateSettings({ route: { accompanimentLevel: 0.25 } })
    vi.advanceTimersByTime(SETTINGS_SAVE_DEBOUNCE_MS * 2)
    expect(settings.value.route.accompanimentLevel).toBe(0.25)
    expect(notices.value).toHaveLength(1) // no save-failure toast on top
  })
})

describe('MIDI service singleton', () => {
  it('creates the adapter on first use without requesting access', () => {
    const nav = fakeNavigator(new FakeAccess())
    resetServicesForTests({ navigator: nav })
    expect(getMidiService().peek()).toBeNull()
    const adapter = getMidi()
    expect(getMidi()).toBe(adapter)
    expect(adapter.status).toBe('idle')
    expect(nav.calls).toHaveLength(0)
  })

  it('drives the shell connection status', async () => {
    const access = new FakeAccess()
    access.addInput(new FakeInput('in-1', 'Digital Piano'))
    resetServicesForTests({ navigator: fakeNavigator(access) })
    await getMidiService().connect()
    expect(connectionStatus.value.state).toBe('disconnected')
    getMidiService().selectInput('in-1')
    expect(connectionStatus.value).toEqual({ state: 'connected', inputName: 'Digital Piano' })
    expect(settings.value.route.inputName).toBe('Digital Piano')
  })
})

describe('startServices', () => {
  function pianoAccess() {
    const access = new FakeAccess()
    access.addInput(new FakeInput('in-1', 'Digital Piano'))
    access.addOutput(new FakeOutput('out-1', 'Digital Piano'))
    return access
  }

  it('loads settings, then silently reconnects a remembered route when permission is granted', async () => {
    const storage = await freshStorage()
    await storage.saveSettings({
      ...DEFAULT_SETTINGS,
      route: {
        ...DEFAULT_SETTINGS.route,
        inputId: 'in-1',
        inputName: 'Digital Piano',
        outputId: 'out-1',
        outputName: 'Digital Piano',
      },
    })
    const nav = { ...fakeNavigator(pianoAccess()), permissions: { query: () => Promise.resolve({ state: 'granted' }) } }
    resetServicesForTests({ navigator: nav, openStorage: () => Promise.resolve(storage) })
    await startServices()
    expect(nav.calls).toHaveLength(1)
    expect(connectionStatus.value).toEqual({
      state: 'connected',
      inputName: 'Digital Piano',
      outputName: 'Digital Piano',
    })
    expect(notices.value).toEqual([])
  })

  it('asks for access at boot even when the permission would prompt, and connects the piano', async () => {
    const storage = await freshStorage()
    await storage.saveSettings({
      ...DEFAULT_SETTINGS,
      route: { ...DEFAULT_SETTINGS.route, inputId: 'in-1', inputName: 'Digital Piano' },
    })
    const nav = { ...fakeNavigator(pianoAccess()), permissions: { query: () => Promise.resolve({ state: 'prompt' }) } }
    resetServicesForTests({ navigator: nav, openStorage: () => Promise.resolve(storage) })
    await startServices()
    expect(nav.calls).toHaveLength(1)
    expect(connectionStatus.value.state).toBe('connected')
  })
})
