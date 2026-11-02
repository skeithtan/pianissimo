import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, TREBLE_PRESET, type AppSettings, type PersistentLabelSettings } from '../core/model/settings'
import {
  MAX_NOTICES,
  SETTINGS_SAVE_DEBOUNCE_MS,
  applyLabelSettings,
  connectionStatus,
  dismissNotice,
  flushSettings,
  notices,
  onBeforeApplyLabels,
  pushNotice,
  resetAppStateForTests,
  setConnectionStatus,
  setSettingsPersistence,
  settings,
  settingsLoading,
  updateSettings,
  type SettingsPersistence,
} from './state'

beforeEach(() => {
  vi.useFakeTimers()
  resetAppStateForTests()
})
afterEach(() => {
  resetAppStateForTests()
  vi.useRealTimers()
})

function memoryStore(initial: unknown = null) {
  const saves: AppSettings[] = []
  const store: SettingsPersistence & { saves: AppSettings[]; failNext: boolean } = {
    saves,
    failNext: false,
    load: () => initial,
    save: (s) => {
      if (store.failNext) throw new Error('disk full')
      saves.push(s)
    },
  }
  return store
}

describe('updateSettings', () => {
  it('starts from the spec defaults', () => {
    expect(settings.value).toBe(DEFAULT_SETTINGS)
    expect(settings.value.naming.alwaysShowEffectiveAccidentals).toBe(true)
    expect(settings.value.naming.simplifyEnharmonics).toBe(false)
    expect(settings.value.labels.mode).toBe('off')
    expect(settings.value.sound.destination).toBe('auto')
  })

  it('merges immutably and notifies once per real change', () => {
    const seen: AppSettings[] = []
    const stop = settings.subscribe((s) => seen.push(s))
    updateSettings({ naming: { showOctave: false } })
    updateSettings({ naming: { showOctave: false } }) // no change
    stop()
    expect(seen).toHaveLength(2) // initial + one change
    expect(settings.value.naming.showOctave).toBe(false)
    expect(DEFAULT_SETTINGS.naming.showOctave).toBe(true)
  })

  it('merges per-clef rules per key and leaves other clefs alone', () => {
    updateSettings({
      labels: { rules: { F4: { below: { enabled: true, threshold: { step: 'E', alter: 0, octave: 2 } } } } },
    })
    expect(settings.value.labels.rules['G2']).toBe(TREBLE_PRESET)
    expect(settings.value.labels.rules['F4']?.below.enabled).toBe(true)
    expect(settings.value.labels.rules['F4']?.above.enabled).toBe(false)
  })
})

describe('settings persistence', () => {
  it('is in-memory by default: nothing is written anywhere', () => {
    updateSettings({ hints: { fadeMs: 100 } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('loads saved settings over the defaults', async () => {
    const store = memoryStore({ naming: { system: 'fixed-do', seventh: 'ti' } })
    await setSettingsPersistence(store)
    expect(settings.value.naming.system).toBe('fixed-do')
    expect(settings.value.naming.seventh).toBe('ti')
    expect(settings.value.naming.showOctave).toBe(true)
    expect(store.saves).toHaveLength(0) // loading does not write back
  })

  it('debounces saves into a single write', async () => {
    const store = memoryStore()
    await setSettingsPersistence(store)
    updateSettings({ hints: { fadeMs: 100 } })
    updateSettings({ hints: { fadeMs: 200 } })
    updateSettings({ hints: { fadeMs: 300 } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS - 1)
    expect(store.saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]?.hints.fadeMs).toBe(300)
  })

  it('flushes immediately on request', async () => {
    const store = memoryStore()
    await setSettingsPersistence(store)
    updateSettings({ view: { theme: 'dark' } })
    await flushSettings()
    expect(store.saves).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS * 2)
    expect(store.saves).toHaveLength(1) // the debounce timer was canceled
  })

  it('keeps changes made while the load is pending', async () => {
    let finishLoad: (v: unknown) => void = () => undefined
    const store = memoryStore()
    store.load = () => new Promise((resolve) => (finishLoad = resolve))
    const ready = setSettingsPersistence(store)
    updateSettings({ view: { theme: 'light' } })
    finishLoad({ view: { theme: 'dark' }, hints: { fadeMs: 500 } })
    await ready
    expect(settings.value.view.theme).toBe('light') // the user's change wins
    expect(settings.value.hints.fadeMs).toBe(500) // stored values still load
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 1)
    expect(store.saves).toHaveLength(1)
  })

  it('reports loading until the stored settings have arrived', async () => {
    let finishLoad: (v: unknown) => void = () => undefined
    const store = memoryStore()
    store.load = () => new Promise((resolve) => (finishLoad = resolve))
    expect(settingsLoading.value).toBe(false)
    const ready = setSettingsPersistence(store)
    expect(settingsLoading.value).toBe(true)
    finishLoad(null)
    await ready
    expect(settingsLoading.value).toBe(false)
  })

  it('does not save while the load is still pending', async () => {
    let finishLoad: (v: unknown) => void = () => undefined
    const store = memoryStore()
    store.load = () => new Promise((resolve) => (finishLoad = resolve))
    const ready = setSettingsPersistence(store)
    await vi.advanceTimersByTimeAsync(5000)
    expect(store.saves).toHaveLength(0)
    finishLoad(null)
    await ready
  })

  it('warns once when saving fails and recovers afterwards', async () => {
    const store = memoryStore()
    await setSettingsPersistence(store)
    store.failNext = true
    updateSettings({ hints: { fadeMs: 100 } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 1)
    updateSettings({ hints: { fadeMs: 110 } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 1)
    expect(notices.value.filter((n) => /could not be saved/u.test(n.text))).toHaveLength(1)
    store.failNext = false
    updateSettings({ hints: { fadeMs: 120 } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 1)
    expect(store.saves.at(-1)?.hints.fadeMs).toBe(120)
  })

  it('falls back to defaults with a notice when loading fails', async () => {
    const store = memoryStore()
    store.load = () => {
      throw new Error('corrupt')
    }
    await setSettingsPersistence(store)
    expect(settings.value).toBe(DEFAULT_SETTINGS)
    expect(notices.value.some((n) => /could not be read/u.test(n.text))).toBe(true)
  })

  it('can be detached', async () => {
    const store = memoryStore()
    await setSettingsPersistence(store)
    await setSettingsPersistence(null)
    updateSettings({ hints: { fadeMs: 100 } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS * 2)
    expect(store.saves).toHaveLength(0)
  })
})

describe('applyLabelSettings and onBeforeApplyLabels', () => {
  const conditional: PersistentLabelSettings = {
    mode: 'conditional',
    rules: DEFAULT_SETTINGS.labels.rules,
    tiedContinuations: false,
  }

  it('runs the hook before the new labels take effect', () => {
    const order: string[] = []
    onBeforeApplyLabels((next) => {
      order.push(`hook sees mode ${settings.peek().labels.mode} -> ${next.mode}`)
    })
    settings.subscribe(() => order.push('settings changed'))
    order.length = 0
    expect(applyLabelSettings(conditional)).toBe(true)
    expect(order).toEqual(['hook sees mode off -> conditional', 'settings changed'])
    expect(settings.value.labels.mode).toBe('conditional')
  })

  it('does nothing, and calls no hook, when nothing changed', () => {
    const hook = vi.fn()
    onBeforeApplyLabels(hook)
    expect(applyLabelSettings(settings.value.labels)).toBe(false)
    expect(applyLabelSettings(structuredClone(settings.value.labels))).toBe(false)
    expect(hook).not.toHaveBeenCalled()
  })

  it('is not triggered by naming-only changes', () => {
    const hook = vi.fn()
    onBeforeApplyLabels(hook)
    updateSettings({ naming: { system: 'fixed-do' } })
    expect(hook).not.toHaveBeenCalled()
  })

  it('unregisters', () => {
    const hook = vi.fn()
    const off = onBeforeApplyLabels(hook)
    off()
    applyLabelSettings(conditional)
    expect(hook).not.toHaveBeenCalled()
  })

  it('still applies when a hook throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    onBeforeApplyLabels(() => {
      throw new Error('boom')
    })
    expect(applyLabelSettings(conditional)).toBe(true)
    expect(settings.value.labels.mode).toBe('conditional')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('applies rule changes per clef', () => {
    const rules = {
      ...DEFAULT_SETTINGS.labels.rules,
      F4: {
        below: { enabled: true, threshold: { step: 'E' as const, alter: 0, octave: 2 } },
        above: { enabled: false, threshold: null },
      },
    }
    applyLabelSettings({ mode: 'conditional', rules, tiedContinuations: true })
    expect(settings.value.labels.rules['F4']?.below.threshold).toEqual({ step: 'E', alter: 0, octave: 2 })
    expect(settings.value.labels.tiedContinuations).toBe(true)
    expect(settings.value.labels.rules['G2']).toBe(TREBLE_PRESET)
  })
})

describe('connectionStatus', () => {
  it('starts disconnected and ignores identical updates', () => {
    expect(connectionStatus.value).toEqual({ state: 'disconnected' })
    const first = connectionStatus.value
    setConnectionStatus({ state: 'disconnected' })
    expect(connectionStatus.value).toBe(first)
    setConnectionStatus({ state: 'connected', inputName: 'Piano', outputName: 'Piano' })
    expect(connectionStatus.value).toEqual({ state: 'connected', inputName: 'Piano', outputName: 'Piano' })
  })
})

describe('notices', () => {
  it('queues, auto-dismisses by kind and keeps errors until dismissed', () => {
    const info = pushNotice({ kind: 'info', text: 'Saved' })
    const error = pushNotice({ kind: 'error', text: 'Import failed' })
    expect(notices.value.map((n) => n.id)).toEqual([info, error])
    vi.advanceTimersByTime(5001)
    expect(notices.value.map((n) => n.id)).toEqual([error])
    vi.advanceTimersByTime(60_000)
    expect(notices.value.map((n) => n.id)).toEqual([error])
    dismissNotice(error)
    expect(notices.value).toEqual([])
  })

  it('honors an explicit timeout, and null/0 as sticky', () => {
    pushNotice({ kind: 'info', text: 'short', timeoutMs: 100 })
    pushNotice({ kind: 'info', text: 'sticky', timeoutMs: null })
    pushNotice({ kind: 'warning', text: 'zero', timeoutMs: 0 })
    vi.advanceTimersByTime(200)
    expect(notices.value.map((n) => n.text)).toEqual(['sticky', 'zero'])
  })

  it('refreshes an identical message instead of stacking it', () => {
    const a = pushNotice({ kind: 'info', text: 'Same', timeoutMs: 1000 })
    vi.advanceTimersByTime(800)
    const b = pushNotice({ kind: 'info', text: 'Same', timeoutMs: 1000 })
    expect(b).toBe(a)
    expect(notices.value).toHaveLength(1)
    vi.advanceTimersByTime(800)
    expect(notices.value).toHaveLength(1) // timer restarted
    vi.advanceTimersByTime(300)
    expect(notices.value).toHaveLength(0)
  })

  it('shows at most MAX_NOTICES, dropping the oldest', () => {
    for (let i = 0; i < MAX_NOTICES + 2; i++) pushNotice({ kind: 'info', text: `n${i}`, timeoutMs: null })
    expect(notices.value).toHaveLength(MAX_NOTICES)
    expect(notices.value[0]?.text).toBe('n2')
  })

  it('dismissing an unknown id is harmless', () => {
    dismissNotice(12345)
    expect(notices.value).toEqual([])
  })
})
