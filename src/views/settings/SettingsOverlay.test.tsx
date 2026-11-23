// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import {
  closeSettings,
  currentView,
  navigate,
  noteRulesRequested,
  openNoteRules,
  openSettings,
  settingsOpen,
} from '../../app/navigation'
import { preloadView } from '../../app/LazyView'
import { notices, setSettingsPersistence, settings, updateSettings } from '../../app/state'
import type { AppSettings } from '../../core/model/settings'
import { $, $$, byLabel, click, mount, press, type Mounted } from '../shared/testing'
import { untranslatedText, usePseudoCatalog } from '../shared/catalogTesting'
import { msg } from '../../i18n/messages'
import { isLabelDraftDirty } from './labelDraft'
import { ALL_FEATURES, openOverlay, openTab, radio, resetSettingsTestState, tab } from './testkit'
import { SettingsOverlay, requestCloseSettings } from './SettingsOverlay'

let view: Mounted | null = null
beforeEach(() => {
  resetSettingsTestState()
})
afterEach(() => {
  view?.unmount()
  view = null
  vi.useRealTimers()
})

function open() {
  const opened = openOverlay(ALL_FEATURES)
  view = opened.view
  return opened.root
}

describe('Settings overlay shell', () => {
  it('opens a titled dialog with four tabs of sections', () => {
    const root = open()
    expect($(root, 'dialog')?.getAttribute('aria-label')).toBe('Settings')
    expect($$(root, '[role="tab"]').map((t) => t.textContent?.trim())).toEqual([
      'Reading help',
      'Piano and sound',
      'App',
      'Data',
    ])
    expect($$(openTab(root, 'Reading help'), 'h3').map((h) => h.textContent)).toEqual([
      'Note names',
      'Naming style',
      'Hints',
    ])
    expect($$(openTab(root, 'Piano and sound'), 'h3').map((h) => h.textContent)).toEqual([
      'Piano',
      'Sound',
      'Metronome',
      'Performance recording',
      'Microphone',
    ])
  })

  it('does not render the sections while closed', () => {
    view = mount(<SettingsOverlay features={ALL_FEATURES} />)
    expect($$(view.container, '[role="tab"]')).toHaveLength(0)
  })

  it('shows one panel at a time and keeps the others mounted', () => {
    const root = open()
    const panels = $$(root, '[role="tabpanel"]')
    expect(panels).toHaveLength(4)
    expect(panels.filter((p) => !p.hidden)).toHaveLength(1)
    expect(tab(root, 'Reading help').getAttribute('aria-selected')).toBe('true')
    const app = openTab(root, 'App')
    expect(app.hidden).toBe(false)
    expect(tab(root, 'App').getAttribute('aria-selected')).toBe('true')
    expect(panels.filter((p) => !p.hidden)).toEqual([app])
  })

  it('moves between tabs with the arrow keys', () => {
    const root = open()
    press(tab(root, 'Reading help'), 'ArrowDown')
    expect(tab(root, 'Piano and sound').getAttribute('aria-selected')).toBe('true')
    press(tab(root, 'Piano and sound'), 'End')
    expect(tab(root, 'Data').getAttribute('aria-selected')).toBe('true')
    press(tab(root, 'Data'), 'ArrowDown') // wraps
    expect(tab(root, 'Reading help').getAttribute('aria-selected')).toBe('true')
  })

  it('opens on the tab used last, and for the Note names rules on Reading help with them focused', async () => {
    const root = open()
    openTab(root, 'App')
    act(() => closeSettings())
    act(() => openSettings())
    expect(tab(root, 'App').getAttribute('aria-selected')).toBe('true')
    act(() => closeSettings())
    updateSettings({ labels: { mode: 'conditional' } })
    act(() => openNoteRules())
    expect(tab(root, 'Reading help').getAttribute('aria-selected')).toBe('true')
    await act(async () => void (await new Promise((resolve) => requestAnimationFrame(resolve))))
    expect(document.activeElement).toBe(byLabel(root, 'Choose which notes'))
    expect(noteRulesRequested.value).toBe(false)
  })

  it('mounts the piano setup with its tab only', async () => {
    const root = open()
    const setup = () => $(root, '[data-step="piano"]')
    await preloadView('connection')
    expect(setup()).toBeNull()
    openTab(root, 'Piano and sound')
    expect(setup()).not.toBeNull()
    openTab(root, 'App')
    expect(setup()).toBeNull()
  })

  it('closes from the close button', () => {
    const root = open()
    expect(settingsOpen.value).toBe(true)
    click(byLabel(root, 'Close'))
    expect(settingsOpen.value).toBe(false)
  })

  it('closes on Escape (the dialog cancel event)', () => {
    const root = open()
    act(() => {
      $(root, 'dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(settingsOpen.value).toBe(false)
  })

  it('is safe to close twice', () => {
    open()
    requestCloseSettings()
    expect(() => requestCloseSettings()).not.toThrow()
    expect(settingsOpen.value).toBe(false)
  })

  it('leaves the current view and everything it holds untouched', () => {
    currentView.value = 'practice'
    const root = open()
    click(byLabel(root, 'Close'))
    expect(currentView.value).toBe('practice')
  })

  it('closes the dialog element after the fade and returns focus to the opener', () => {
    vi.useFakeTimers()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const root = open()
    const dialog = $(root, 'dialog') as HTMLDialogElement
    expect(dialog.open).toBe(true)
    click(byLabel(root, 'Close'))
    expect(dialog.hasAttribute('data-leaving')).toBe(true) // fading, still open
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(dialog.open).toBe(false)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('applies the theme choice from the App tab', () => {
    const root = open()
    const app = openTab(root, 'App')
    click(radio(app, 'Theme', 'Dark'))
    expect(settings.value.view.theme).toBe('dark')
  })

  it('warns on close when staged label edits are discarded', () => {
    const root = open()
    const reading = openTab(root, 'Reading help')
    click(radio(reading, 'Note names on the score', 'All'))
    expect(isLabelDraftDirty()).toBe(true)
    expect(tab(root, 'Reading help').textContent).toContain('changes not applied')
    click(byLabel(root, 'Close'))
    expect(notices.value.some((n) => /not applied/u.test(n.text))).toBe(true)
    expect(isLabelDraftDirty()).toBe(false)
    expect(settings.value.labels.mode).toBe('off') // nothing was applied
  })

  it('does not warn when nothing was staged', () => {
    const root = open()
    openTab(root, 'Reading help')
    click(byLabel(root, 'Close'))
    expect(notices.value).toEqual([])
  })

  it('shows the settings that are currently applied', () => {
    updateSettings({ naming: { system: 'fixed-do' } })
    const root = open()
    const names = openTab(root, 'Reading help')
    expect(radio(names, 'Naming system', 'Fixed do').getAttribute('aria-checked')).toBe('true')
  })
})

describe('translation coverage', () => {
  // Note names, language names (each in its own language), product, format, license and browser
  // API names are literal data.
  const literal = [
    /\b[A-G][♯♭𝄪𝄫]?-?\d?\b/u,
    /\b(Do|Re|Mi|Fa|Sol|La|Si|Ti)\b/u,
    /^(English|Español|Français|Filipino|日本語)( \(.+\))?$/u,
    'iPad:',
    'MusicXML',
    'Pianissimo',
    'CC-BY',
    'Web MIDI',
    'Web Audio',
  ]

  it('shows no text that bypasses the catalogs in any section', () => {
    const restore = usePseudoCatalog()
    try {
      updateSettings({
        labels: { mode: 'conditional' },
        hints: { lifetime: 45, autoThreshold: 5 },
        pedal: {
          hintPedal: {
            controller: 66,
            channel: 0,
            threshold: 64,
            inverted: false,
            verified: true,
            observedMin: 0,
            observedMax: 127,
          },
          observedControllers: [64, 66, 67],
        },
        metronome: { enabled: true },
      })
      const root = open()
      for (const name of ['Reading help', 'Piano and sound', 'App', 'Data'])
        expect(untranslatedText(openTab(root, msg(name)), literal)).toEqual([])
      expect(untranslatedText(root, literal)).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('saving on the way out', () => {
  it.each([
    ['the close button', (root: HTMLElement) => click(byLabel(root, 'Close'))],
    ['the browser Back button', () => act(() => void (settingsOpen.value = false))],
    ['another view taking over', () => act(() => navigate('practice'))],
  ])('writes pending preferences at once when Settings closes through %s', async (_, close) => {
    vi.useFakeTimers()
    const saves: AppSettings[] = []
    await setSettingsPersistence({ load: () => null, save: (next) => void saves.push(next) })
    const root = open()
    click(radio(openTab(root, 'App'), 'Theme', 'Dark'))
    expect(saves).toHaveLength(0) // debounced
    close(root)
    await act(async () => {
      await Promise.resolve()
    })
    expect(settingsOpen.value).toBe(false)
    expect(saves.at(-1)?.view.theme).toBe('dark')
  })
})
