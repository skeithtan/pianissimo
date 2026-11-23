// @vitest-environment happy-dom
import { effect } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '../core/model/language'
import { messageLanguage, msg, readMessagesWith } from '../i18n/messages'
import { languageReady, startLanguageSync } from './language'
import { beginSettingsLoad, notices, resetAppStateForTests, setSettingsPersistence, updateSettings } from './state'

const CACHE_KEY = 'pianissimo.language'

/** A catalog loader whose loads finish when the test says so. */
function loader() {
  const pending: { language: Language; resolve: () => void; reject: () => void }[] = []
  const load = vi.fn(
    (language: Exclude<Language, 'en-US'>) =>
      new Promise<Record<string, string>>((resolve, reject) => {
        pending.push({
          language,
          resolve: () => resolve({ Library: `${language} Library` }),
          reject: () => reject(new Error('offline')),
        })
      }),
  )
  const settle = async (language: Language, ok = true) => {
    const index = pending.findIndex((p) => p.language === language)
    if (index < 0) throw new Error(`no pending load for ${language}`)
    const [entry] = pending.splice(index, 1)
    if (ok) entry!.resolve()
    else entry!.reject()
    await flush()
  }
  return { load, settle }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

let stop: (() => void) | null = null
let root: HTMLElement

beforeEach(() => {
  resetAppStateForTests()
  root = document.createElement('html')
  root.lang = 'en-US'
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR'])
})
afterEach(() => {
  stop?.()
  stop = null
  vi.restoreAllMocks()
  localStorage.removeItem(CACHE_KEY)
  readMessagesWith(() => ({ language: 'en-US', strings: {} }))
  resetAppStateForTests()
})

describe('startLanguageSync', () => {
  it('does nothing on the default setting while stored settings load, so an explicit choice wins over the device', async () => {
    const { load } = loader()
    beginSettingsLoad() // the shell starts the sync before the services load settings
    stop = startLanguageSync({ load, root })
    await flush()
    expect(load).not.toHaveBeenCalled()
    expect(messageLanguage()).toBe('en-US')
    await setSettingsPersistence({ load: () => ({ view: { language: 'en-US' } }), save: () => undefined })
    await flush()
    expect(load).not.toHaveBeenCalled()
    expect(messageLanguage()).toBe('en-US')
    expect(root.lang).toBe('en-US')
  })

  it('follows the device language once stored settings say "system"', async () => {
    const { load, settle } = loader()
    beginSettingsLoad()
    stop = startLanguageSync({ load, root })
    await setSettingsPersistence({ load: () => null, save: () => undefined })
    expect(load).toHaveBeenCalledWith('fr-FR')
    await settle('fr-FR')
    expect(messageLanguage()).toBe('fr-FR')
    expect(localStorage.getItem(CACHE_KEY)).toBe('fr-FR')
  })

  it('starts loading the cached language before settings load, and the first render can wait for it', async () => {
    localStorage.setItem(CACHE_KEY, 'ja-JP')
    const { load, settle } = loader()
    beginSettingsLoad()
    stop = startLanguageSync({ load, root })
    expect(load).toHaveBeenCalledWith('ja-JP')
    const ready = languageReady(10_000)
    expect(ready).not.toBeNull()
    await settle('ja-JP')
    await ready
    expect(messageLanguage()).toBe('ja-JP')
    expect(msg('Library')).toBe('ja-JP Library')
    expect(root.lang).toBe('ja-JP')
    // Stored settings agree: nothing loads again.
    await setSettingsPersistence({ load: () => ({ view: { language: 'ja-JP' } }), save: () => undefined })
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not hold the first render for a slow catalog', async () => {
    vi.useFakeTimers()
    try {
      localStorage.setItem(CACHE_KEY, 'es-ES')
      const { load } = loader()
      beginSettingsLoad()
      stop = startLanguageSync({ load, root })
      let rendered = false
      void languageReady(300)!.then(() => (rendered = true))
      await vi.advanceTimersByTimeAsync(299)
      expect(rendered).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(rendered).toBe(true)
      expect(messageLanguage()).toBe('en-US')
    } finally {
      vi.useRealTimers()
    }
  })

  it('has nothing to wait for without a cached language', () => {
    stop = startLanguageSync({ load: loader().load, root })
    expect(languageReady(300)).toBeNull()
  })

  it('switches to the stored choice when it differs from the cached language', async () => {
    localStorage.setItem(CACHE_KEY, 'ja-JP')
    const { load, settle } = loader()
    beginSettingsLoad()
    stop = startLanguageSync({ load, root })
    await setSettingsPersistence({ load: () => ({ view: { language: 'es-ES' } }), save: () => undefined })
    await settle('es-ES')
    await settle('ja-JP') // arrives late: ignored
    expect(messageLanguage()).toBe('es-ES')
    expect(root.lang).toBe('es-ES')
    expect(localStorage.getItem(CACHE_KEY)).toBe('es-ES')
  })

  it('ignores a catalog that arrives after a newer choice', async () => {
    const { load, settle } = loader()
    stop = startLanguageSync({ load, root })
    await settle('fr-FR') // the device language
    updateSettings({ view: { language: 'ja-JP' } })
    updateSettings({ view: { language: 'es-ES' } })
    await settle('es-ES')
    await settle('ja-JP')
    expect(messageLanguage()).toBe('es-ES')
    updateSettings({ view: { language: 'en-US' } })
    expect(messageLanguage()).toBe('en-US')
    expect(root.lang).toBe('en-US')
  })

  it('keeps the current language with a notice when a catalog fails, and retries online and on the next change', async () => {
    const { load, settle } = loader()
    updateSettings({ view: { language: 'en-US' } })
    stop = startLanguageSync({ load, root })
    updateSettings({ view: { language: 'fr-FR' } })
    await settle('fr-FR', false)
    expect(messageLanguage()).toBe('en-US')
    expect(root.lang).toBe('en-US')
    expect(notices.value.filter((n) => n.kind === 'warning' && /could not be loaded/u.test(n.text))).toHaveLength(1)

    window.dispatchEvent(new Event('online'))
    expect(load).toHaveBeenCalledTimes(2)
    await settle('fr-FR', false)
    expect(messageLanguage()).toBe('en-US')

    updateSettings({ view: { language: 'ja-JP' } })
    await settle('ja-JP')
    expect(messageLanguage()).toBe('ja-JP')
    window.dispatchEvent(new Event('online'))
    expect(load).toHaveBeenCalledTimes(3) // nothing failed since: no reload
  })

  it('changes <html lang> together with the strings', async () => {
    const { load, settle } = loader()
    updateSettings({ view: { language: 'en-US' } })
    stop = startLanguageSync({ load, root })
    const seen: [string, string][] = []
    const watch = effect(() => {
      seen.push([msg('Library'), root.lang])
    })
    updateSettings({ view: { language: 'fr-CA' } })
    expect(root.lang).toBe('en-US') // nothing changes while the catalog loads
    await settle('fr-CA')
    updateSettings({ view: { language: 'en-US' } })
    watch()
    expect(seen).toEqual([
      ['Library', 'en-US'],
      ['fr-CA Library', 'fr-CA'],
      ['Library', 'en-US'],
    ])
  })

  it('works when local storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { load, settle } = loader()
    stop = startLanguageSync({ load, root })
    await settle('fr-FR')
    expect(messageLanguage()).toBe('fr-FR')
  })
})
