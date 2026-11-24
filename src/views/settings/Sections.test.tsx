// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectFeatures } from '../../app/features'
import { settings, updateSettings } from '../../app/state'
import { APP_VERSION } from '../../app/version'
import { $, $$, byLabel, click, flush, type, type Mounted } from '../shared/testing'
import { useCatalog } from '../shared/catalogTesting'
import { msg, percentage } from '../../i18n/messages'
import { ALL_FEATURES, openOverlay, openSection, openTab, radio, resetSettingsTestState, toggle } from './testkit'
import { SALAMANDER_LICENSE_URL } from './AboutSection'

let view: Mounted | null = null
beforeEach(() => {
  resetSettingsTestState()
})
afterEach(() => {
  view?.unmount()
  view = null
})

function open(features = ALL_FEATURES) {
  const opened = openOverlay(features)
  view = opened.view
  return opened.root
}

const DEFAULT_HINTS = settings.peek().hints

const example = (panel: HTMLElement, id: string) => $(panel, `[data-testid="example-${id}"]`)?.textContent

describe('Naming style', () => {
  it('shows the spec examples under the default naming', () => {
    const panel = openSection(open(), 'Reading help', 'Naming style')
    expect(example(panel, 'b-sharp-c-sharp-major')).toBe('B♯4')
    expect(example(panel, 'c-sharp-d-major')).toBe('C♯4')
    expect(example(panel, 'f-double-sharp')).toBe('F𝄪4')
    expect(example(panel, 'b-flat-f-major')).toBe('B♭4')
  })

  it('defaults: effective accidentals on, simplify off, octave on, letter names', () => {
    const panel = openSection(open(), 'Reading help', 'Naming style')
    expect(toggle(panel, 'Always show effective accidentals').checked).toBe(true)
    expect(toggle(panel, 'Simplify enharmonic names').checked).toBe(false)
    expect(toggle(panel, 'Show octave number').checked).toBe(true)
    expect(radio(panel, 'Naming system', 'Letter names').getAttribute('aria-checked')).toBe('true')
  })

  it('updates the examples at once as options change, and applies them to settings immediately', () => {
    const panel = openSection(open(), 'Reading help', 'Naming style')
    click(toggle(panel, 'Simplify enharmonic names'))
    expect(settings.value.naming.simplifyEnharmonics).toBe(true)
    expect(example(panel, 'b-sharp-c-sharp-major')).toBe('C5')
    expect(example(panel, 'f-double-sharp')).toBe('G4')
    expect(example(panel, 'c-sharp-d-major')).toBe('C♯4') // ordinary spellings stay

    click(toggle(panel, 'Always show effective accidentals'))
    expect(example(panel, 'b-sharp-c-sharp-major')).toBe('C♮5') // the spec's contextual case
    expect(example(panel, 'c-sharp-d-major')).toBe('C4') // sharp implied by the key signature

    click(toggle(panel, 'Simplify enharmonic names'))
    expect(example(panel, 'b-sharp-c-sharp-major')).toBe('B4')
  })

  it('switches to fixed do with a si/ti choice and hides octaves on request', () => {
    const panel = openSection(open(), 'Reading help', 'Naming style')
    expect($$(panel, '[role="radiogroup"]').some((g) => g.getAttribute('aria-label') === 'Seventh note')).toBe(false)
    click(radio(panel, 'Naming system', 'Fixed do'))
    expect(settings.value.naming.system).toBe('fixed-do')
    expect(example(panel, 'b-sharp-c-sharp-major')).toBe('si♯4')
    click(radio(panel, 'Seventh note', 'ti'))
    expect(example(panel, 'b-sharp-c-sharp-major')).toBe('ti♯4')
    expect(example(panel, 'c-sharp-d-major')).toBe('do♯4')
    click(toggle(panel, 'Show octave number'))
    expect(example(panel, 'c-sharp-d-major')).toBe('do♯')
    expect(settings.value.naming.showOctave).toBe(false)
  })

  it('does not touch label rules or interrupt anything', () => {
    const before = settings.value.labels
    const panel = openSection(open(), 'Reading help', 'Naming style')
    click(radio(panel, 'Naming system', 'Fixed do'))
    expect(settings.value.labels).toBe(before)
  })
})

describe('Hints', () => {
  const numberInput = (panel: HTMLElement, label: string) =>
    $(panel, `input[aria-label="${label}"]`) as HTMLInputElement

  it('defaults to one mistake, 30 seconds and a 300 ms fade', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    expect(radio(panel, 'Show note names automatically', '1 mistake').getAttribute('aria-checked')).toBe('true')
    expect(radio(panel, 'Hint lifetime', '30 s').getAttribute('aria-checked')).toBe('true')
    expect($(panel, 'output')?.textContent).toBe('300 ms')
  })

  it('chooses 1, 2, 3 or off for the automatic threshold', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    click(radio(panel, 'Show note names automatically', '1 mistake'))
    expect(settings.value.hints.autoThreshold).toBe(1)
    click(radio(panel, 'Show note names automatically', '3 mistakes'))
    expect(settings.value.hints.autoThreshold).toBe(3)
    click(radio(panel, 'Show note names automatically', 'Off'))
    expect(settings.value.hints.autoThreshold).toBeNull()
    expect(radio(panel, 'Show note names automatically', 'Off').getAttribute('aria-checked')).toBe('true')
  })

  it('accepts a custom positive threshold and rejects zero, negatives and text', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    click(radio(panel, 'Show note names automatically', 'Custom'))
    const input = numberInput(panel, 'Custom number of wrong attacks')
    type(input, '5')
    expect(settings.value.hints.autoThreshold).toBe(5)
    type(input, '0')
    expect($(panel, '[role="alert"]')?.textContent).toMatch(/greater than zero/u)
    expect(settings.value.hints.autoThreshold).toBe(5) // an invalid entry changes nothing
    type(input, '-2')
    expect($(panel, '[role="alert"]')).not.toBeNull()
    type(input, '2.5')
    expect($(panel, '[role="alert"]')?.textContent).toMatch(/whole number/u)
    type(input, 'lots')
    expect($(panel, '[role="alert"]')?.textContent).toMatch(/not a number/u)
    type(input, '7')
    expect($(panel, '[role="alert"]')).toBeNull()
    expect(settings.value.hints.autoThreshold).toBe(7)
  })

  it('keeps Custom selected while the typed value equals a preset', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    click(radio(panel, 'Show note names automatically', 'Custom'))
    type(numberInput(panel, 'Custom number of wrong attacks'), '3')
    expect(radio(panel, 'Show note names automatically', 'Custom').getAttribute('aria-checked')).toBe('true')
    expect(settings.value.hints.autoThreshold).toBe(3)
  })

  it('shows a stored non-preset threshold as Custom', () => {
    updateSettings({ hints: { autoThreshold: 6 } })
    const panel = openSection(open(), 'Reading help', 'Hints')
    expect(radio(panel, 'Show note names automatically', 'Custom').getAttribute('aria-checked')).toBe('true')
    expect(numberInput(panel, 'Custom number of wrong attacks').value).toBe('6')
  })

  it('chooses the lifetime: 10 / 20 / 30 / 60 s, custom, or until correct', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    for (const [label, expected] of [
      ['10 s', 10],
      ['20 s', 20],
      ['60 s', 60],
    ] as const) {
      click(radio(panel, 'Hint lifetime', label))
      expect(settings.value.hints.lifetime).toBe(expected)
    }
    click(radio(panel, 'Hint lifetime', 'Until correct'))
    expect(settings.value.hints.lifetime).toBe('until-correct')
    click(radio(panel, 'Hint lifetime', 'Custom'))
    const input = numberInput(panel, 'Custom hint lifetime in seconds')
    type(input, '45')
    expect(settings.value.hints.lifetime).toBe(45)
    type(input, '0')
    expect($(panel, '[role="alert"]')).not.toBeNull()
    expect(settings.value.hints.lifetime).toBe(45)
    type(input, '0.05') // under the 0.1 s the stored settings keep: rejected, not replaced by 30
    expect($(panel, '[role="alert"]')?.textContent).toMatch(/at least 0\.1/u)
    expect(settings.value.hints.lifetime).toBe(45)
    type(input, '12.5')
    expect(settings.value.hints.lifetime).toBe(12.5)
  })

  it('changes the fade duration from the slider', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    type($(panel, 'input[type="range"]'), '500')
    expect(settings.value.hints.fadeMs).toBe(500)
    expect($(panel, 'output')?.textContent).toBe('500 ms')
  })

  it('turns the red flash on a wrong note off and on (on by default)', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    const flash = toggle(panel, 'Red flash on a wrong note')
    expect(flash.checked).toBe(true)
    expect(panel.textContent).toContain('Flash the screen edges red when you play a wrong note.')
    click(flash)
    expect(settings.value.hints.damageFlash).toBe(false)
    expect(toggle(panel, 'Red flash on a wrong note').checked).toBe(false)
    expect(settings.value.hints.autoThreshold).toBe(1) // nothing else changes
    click(toggle(panel, 'Red flash on a wrong note'))
    expect(settings.value.hints.damageFlash).toBe(true)
  })
})

describe('Keep time', () => {
  it('chooses the timing window: Tight, Normal (the default) or Loose', () => {
    const panel = openSection(open(), 'Reading help', 'Hints')
    expect(panel.textContent).toContain('Keep time')
    expect(radio(panel, 'Keep time window', 'Normal ±150 ms').getAttribute('aria-checked')).toBe('true')
    click(radio(panel, 'Keep time window', 'Tight ±80 ms'))
    expect(settings.value.rhythm.toleranceMs).toBe(80)
    expect(radio(panel, 'Keep time window', 'Tight ±80 ms').getAttribute('aria-checked')).toBe('true')
    click(radio(panel, 'Keep time window', 'Loose ±250 ms'))
    expect(settings.value.rhythm.toleranceMs).toBe(250)
    expect(settings.value.hints).toEqual(DEFAULT_HINTS) // nothing else changes
  })

  it('shows a stored window that is not a preset in words, with no choice selected', () => {
    updateSettings({ rhythm: { toleranceMs: 120 } })
    const panel = openSection(open(), 'Reading help', 'Hints')
    for (const label of ['Tight ±80 ms', 'Normal ±150 ms', 'Loose ±250 ms']) {
      expect(radio(panel, 'Keep time window', label).getAttribute('aria-checked')).toBe('false')
    }
    expect(panel.textContent).toContain('Now ±120 ms.')
  })
})

describe('Sound', () => {
  it('defaults to Auto: the piano when connected, otherwise this device (S4)', () => {
    const panel = openTab(open(), 'Piano and sound')
    expect(radio(panel, 'Sound destination', 'Auto').getAttribute('aria-checked')).toBe('true')
    expect(panel.textContent).toMatch(
      /connected piano plays when there is one\. Otherwise sound comes from this device/u,
    )
  })

  it('pins the piano or browser sound by explicit choice', () => {
    const panel = openTab(open(), 'Piano and sound')
    click(radio(panel, 'Sound destination', 'Browser sound'))
    expect(settings.value.sound.destination).toBe('browser')
    expect(panel.textContent).toMatch(/always comes from this device's speakers/u)
    click(radio(panel, 'Sound destination', 'Connected piano (MIDI)'))
    expect(settings.value.sound.destination).toBe('midi')
    expect(panel.textContent).toMatch(/never switched to browser sound/u)
    click(radio(panel, 'Sound destination', 'Auto'))
    expect(settings.value.sound.destination).toBe('auto')
  })

  it('adjusts browser volume and accompaniment level', () => {
    const panel = openTab(open(), 'Piano and sound')
    const sliders = $$(panel, 'input[type="range"]')
    type(sliders[0], '0.5')
    expect(settings.value.sound.browserVolume).toBe(0.5)
    type(sliders[1], '0.7')
    expect(settings.value.route.accompanimentLevel).toBe(0.7)
  })

  it('toggles the metronome and its volume, off by default', () => {
    const panel = openTab(open(), 'Piano and sound')
    expect(toggle(panel, 'Metronome click').checked).toBe(false)
    const volume = $$(panel, 'input[type="range"]')[2] as HTMLInputElement
    // Keep time's click is on by default, so the volume still applies.
    expect(volume.disabled).toBe(false)
    click(toggle(panel, 'Metronome click'))
    expect(settings.value.metronome.enabled).toBe(true)
    expect(volume.disabled).toBe(false)
    type(volume, '0.3')
    expect(settings.value.metronome.volume).toBe(0.3)
  })

  it('has its own Keep time click switch (on by default); the volume is disabled only when both are off (P20)', () => {
    const panel = openTab(open(), 'Piano and sound')
    const volume = $$(panel, 'input[type="range"]')[2] as HTMLInputElement
    expect(toggle(panel, 'Click in Keep time').checked).toBe(true)
    click(toggle(panel, 'Click in Keep time'))
    expect(settings.value.metronome.keepTime).toBe(false)
    expect(settings.value.metronome.enabled).toBe(false)
    expect(volume.disabled).toBe(true)
    click(toggle(panel, 'Metronome click'))
    expect(volume.disabled).toBe(false)
    click(toggle(panel, 'Click in Keep time'))
    expect(settings.value.metronome).toMatchObject({ enabled: true, keepTime: true })
    click(toggle(panel, 'Metronome click'))
    expect(volume.disabled).toBe(false)
  })

  it('keeps monitoring through browser sound off by default', () => {
    const panel = openTab(open(), 'Piano and sound')
    expect(toggle(panel, 'Hear my keys through browser sound').checked).toBe(false)
    click(toggle(panel, 'Hear my keys through browser sound'))
    expect(settings.value.sound.monitorInput).toBe(true)
  })

  it('warns when browser sound is chosen but Web Audio is missing', () => {
    const panel = openTab(open(detectFeatures({})), 'Piano and sound')
    expect($$(panel, '[role="status"]').some((n) => /metronome click are unavailable/u.test(n.textContent ?? ''))).toBe(
      false,
    )
    click(radio(panel, 'Sound destination', 'Browser sound'))
    expect(panel.textContent).toMatch(/cannot play sound itself/u)
  })

  it('names the remembered recording input, and Choose again forgets it (D20)', () => {
    updateSettings({ recording: { inputId: 'usb', inputLabel: 'USB Audio' } })
    const group = openSection(open(), 'Piano and sound', 'Performance recording')
    expect(group.textContent).toContain('USB Audio')
    click(byLabel(group, 'Choose again'))
    expect(settings.value.recording).toEqual({ inputId: null, inputLabel: null })
    expect(group.textContent).not.toContain('USB Audio')
    expect(byLabel(group, 'Choose again')).toBeNull()
    expect(group.textContent).toContain('You choose the audio input the next time you record.')
  })

  it('says when the recording input is chosen while none is remembered, and names one without a name', () => {
    const group = openSection(open(), 'Piano and sound', 'Performance recording')
    expect(group.textContent).toContain('You choose the audio input the next time you record.')
    flush(() => updateSettings({ recording: { inputId: 'usb', inputLabel: null } }))
    expect(group.textContent).toContain('System audio input')
  })
})

describe('App', () => {
  it('toggles suggestions, enabled by default', () => {
    const panel = openTab(open(), 'App')
    expect(toggle(panel, 'Suggest passages to practice').checked).toBe(true)
    click(toggle(panel, 'Suggest passages to practice'))
    expect(settings.value.suggestions.enabled).toBe(false)
  })

  it('chooses the theme', () => {
    const panel = openTab(open(), 'App')
    expect(radio(panel, 'Theme', 'System').getAttribute('aria-checked')).toBe('true')
    click(radio(panel, 'Theme', 'Light'))
    expect(settings.value.view.theme).toBe('light')
    click(radio(panel, 'Theme', 'System'))
    expect(settings.value.view.theme).toBe('system')
  })
})

describe('About', () => {
  it('shows the version, MusicXML-only import, data locality and credits', () => {
    const panel = openTab(open(), 'Data')
    expect(panel.textContent).toContain(`version ${APP_VERSION}`)
    expect(panel.textContent).toMatch(/MusicXML is the only score format/u)
    expect(panel.textContent).toMatch(/never\s+uploaded/u)
    expect(panel.textContent).toContain('Salamander Grand Piano V3 by Alexander Holm')
    const link = $(panel, 'a') as HTMLAnchorElement
    expect(link.textContent).toBe('CC-BY 3.0')
    expect(link.getAttribute('href')).toBe(SALAMANDER_LICENSE_URL)
    expect(link.getAttribute('rel')).toContain('noopener')
    const scoreCredits = $(panel, 'a[href$="/scores/LICENSES.md"]')
    expect(scoreCredits?.textContent).toBe('Built-in score credits and licenses')
  })

  it('lists what this browser supports with the explanation for anything missing', () => {
    const panel = openTab(open(detectFeatures({})), 'Data')
    expect(panel.textContent).toMatch(/Web MIDI/u)
    expect(panel.textContent).toMatch(/Safari has no Web MIDI/u)
    expect(panel.textContent).toMatch(/MIDIWeb/u)
    const supported = openTab(open(ALL_FEATURES), 'Data')
    expect($$(supported, '[data-supported="false"]')).toHaveLength(0)
  })
})

describe('numbers in other languages', () => {
  it.each([
    ['fr-FR', '10\u00a0s'],
    ['ja-JP', '10秒'],
  ] as const)(
    '%s: volumes use the percent format of the language, and hint lifetimes its seconds',
    (language, seconds) => {
      const restore = useCatalog(language)
      try {
        const root = open()
        const outputs = $$(openTab(root, msg('Piano and sound')), 'output').map((o) => o.textContent)
        expect(outputs).toContain(percentage(settings.value.sound.browserVolume))
        expect(outputs).toContain(percentage(settings.value.metronome.volume))
        expect(radio(openTab(root, msg('Reading help')), msg('Hint lifetime'), seconds)).toBeTruthy()
      } finally {
        restore()
      }
    },
  )
})
