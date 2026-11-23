// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { currentView, navigate, settingsOpen } from '../../app/navigation'
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
  it('opens a titled dialog with eight sections', () => {
    const root = open()
    expect($(root, 'dialog')?.getAttribute('aria-label')).toBe('Settings')
    expect($$(root, '[role="tab"]').map((t) => t.textContent?.trim())).toEqual([
      'Note names',
      'Score labels',
      'Hints',
      'Pedal',
      'Sound',
      'General',
      'Backup',
      'About',
    ])
  })

  it('does not render the sections while closed', () => {
    view = mount(<SettingsOverlay features={ALL_FEATURES} />)
    expect($$(view.container, '[role="tab"]')).toHaveLength(0)
  })

  it('shows one panel at a time and keeps the others mounted', () => {
    const root = open()
    const panels = $$(root, '[role="tabpanel"]')
    expect(panels).toHaveLength(8)
    expect(panels.filter((p) => !p.hidden)).toHaveLength(1)
    expect(tab(root, 'Note names').getAttribute('aria-selected')).toBe('true')
    const hints = openTab(root, 'Hints')
    expect(hints.hidden).toBe(false)
    expect(tab(root, 'Hints').getAttribute('aria-selected')).toBe('true')
    expect(panels.filter((p) => !p.hidden)).toEqual([hints])
  })

  it('moves between tabs with the arrow keys', () => {
    const root = open()
    press(tab(root, 'Note names'), 'ArrowDown')
    expect(tab(root, 'Score labels').getAttribute('aria-selected')).toBe('true')
    press(tab(root, 'Score labels'), 'End')
    expect(tab(root, 'About').getAttribute('aria-selected')).toBe('true')
    press(tab(root, 'About'), 'ArrowDown') // wraps
    expect(tab(root, 'Note names').getAttribute('aria-selected')).toBe('true')
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

  it('applies the theme choice from the General tab', () => {
    const root = open()
    const general = openTab(root, 'General')
    click(radio(general, 'Theme', 'Dark'))
    expect(settings.value.view.theme).toBe('dark')
  })

  it('warns on close when staged label edits are discarded', () => {
    const root = open()
    const labels = openTab(root, 'Score labels')
    click(radio(labels, 'Persistent labels', 'All notes'))
    expect(isLabelDraftDirty()).toBe(true)
    expect(tab(root, 'Score labels').textContent).toContain('changes not applied')
    click(byLabel(root, 'Close'))
    expect(notices.value.some((n) => /not applied/u.test(n.text))).toBe(true)
    expect(isLabelDraftDirty()).toBe(false)
    expect(settings.value.labels.mode).toBe('off') // nothing was applied
  })

  it('does not warn when nothing was staged', () => {
    const root = open()
    openTab(root, 'Score labels')
    click(byLabel(root, 'Close'))
    expect(notices.value).toEqual([])
  })

  it('shows the settings that are currently applied', () => {
    updateSettings({ naming: { system: 'fixed-do' } })
    const root = open()
    const names = openTab(root, 'Note names')
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
      for (const name of ['Note names', 'Score labels', 'Hints', 'Pedal', 'Sound', 'General', 'Backup', 'About'])
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
    ['Set up in Connection', (root: HTMLElement) => click(byLabel(openTab(root, 'Pedal'), 'Set up in Connection'))],
  ])('writes pending preferences at once when Settings closes through %s', async (_, close) => {
    vi.useFakeTimers()
    const saves: AppSettings[] = []
    await setSettingsPersistence({ load: () => null, save: (next) => void saves.push(next) })
    const root = open()
    click(radio(openTab(root, 'General'), 'Theme', 'Dark'))
    expect(saves).toHaveLength(0) // debounced
    close(root)
    await act(async () => {
      await Promise.resolve()
    })
    expect(settingsOpen.value).toBe(false)
    expect(saves.at(-1)?.view.theme).toBe('dark')
  })
})
