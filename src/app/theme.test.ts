// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { resetAppStateForTests, setSettingsPersistence, updateSettings } from './state'
import { startThemeSync } from './theme'

describe('startThemeSync before stored settings load (boot order)', () => {
  afterEach(() => {
    resetAppStateForTests()
    localStorage.removeItem('pianissimo.theme')
  })

  it('keeps the cached theme while only the defaults are known, then follows the stored settings', async () => {
    localStorage.setItem('pianissimo.theme', 'dark')
    const root = document.createElement('div')
    const stop = startThemeSync(root) // the shell starts theme sync before the services
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('pianissimo.theme')).toBe('dark')
    let finish: (v: unknown) => void = () => undefined
    const ready = setSettingsPersistence({
      load: () => new Promise((resolve) => (finish = resolve)),
      save: () => undefined,
    })
    expect(root.getAttribute('data-theme')).toBe('dark')
    finish({ view: { theme: 'light' } })
    await ready
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('pianissimo.theme')).toBe('light')
    stop()
  })

  it('a change made before settings load still applies at once', () => {
    localStorage.setItem('pianissimo.theme', 'dark')
    const root = document.createElement('div')
    const stop = startThemeSync(root)
    updateSettings({ view: { theme: 'light' } })
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('pianissimo.theme')).toBe('light')
    stop()
  })

  it('without a cached theme the defaults apply at once', () => {
    const root = document.createElement('div')
    root.setAttribute('data-theme', 'dark')
    const stop = startThemeSync(root)
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem('pianissimo.theme')).toBe('system')
    stop()
  })
})
