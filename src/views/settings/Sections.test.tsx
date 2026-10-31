// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectFeatures } from '../../app/features'
import { connectionOpen, currentView, settingsOpen } from '../../app/navigation'
import { settings, updateSettings } from '../../app/state'
import { APP_VERSION } from '../../app/version'
import { $, $$, byLabel, click, type, type Mounted } from '../shared/testing'
import { ALL_FEATURES, openOverlay, openTab, radio, resetSettingsTestState, toggle } from './testkit'
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

const example = (panel: HTMLElement, id: string) => $(panel, `[data-testid="example-${id}"]`)?.textContent

describe('Note names', () => {
  it('shows the spec examples under the default naming', () => {
    const panel = openTab(open(), 'Note names')
    expect(example(panel, 'b-sharp-c-sharp-major')).toBe('B♯4')
    expect(example(panel, 'c-sharp-d-major')).toBe('C♯4')
    expect(example(panel, 'f-double-sharp')).toBe('F𝄪4')
    expect(example(panel, 'b-flat-f-major')).toBe('B♭4')
  })

  it('defaults: effective accidentals on, simplify off, octave on, letter names', () => {
    const panel = openTab(open(), 'Note names')
    expect(toggle(panel, 'Always show effective accidentals').checked).toBe(true)
    expect(toggle(panel, 'Simplify enharmonic names').checked).toBe(false)
    expect(toggle(panel, 'Show octave number').checked).toBe(true)
    expect(radio(panel, 'Naming system', 'Letter names').getAttribute('aria-checked')).toBe('true')
  })

  it('updates the examples at once as options change, and applies them to settings immediately', () => {
    const panel = openTab(open(), 'Note names')
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
    const panel = openTab(open(), 'Note names')
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
    const panel = openTab(open(), 'Note names')
    click(radio(panel, 'Naming system', 'Fixed do'))
    expect(settings.value.labels).toBe(before)
  })
})

describe('Hints', () => {
  const numberInput = (panel: HTMLElement, label: string) =>
    $(panel, `input[aria-label="${label}"]`) as HTMLInputElement

  it('defaults to one mistake, 30 seconds and a 300 ms fade', () => {
    const panel = openTab(open(), 'Hints')
    expect(radio(panel, 'Show note names automatically', '1 mistake').getAttribute('aria-checked')).toBe('true')
    expect(radio(panel, 'Hint lifetime', '30 s').getAttribute('aria-checked')).toBe('true')
    expect($(panel, 'output')?.textContent).toBe('300 ms')
  })

  it('chooses 1, 2, 3 or off for the automatic threshold', () => {
    const panel = openTab(open(), 'Hints')
    click(radio(panel, 'Show note names automatically', '1 mistake'))
    expect(settings.value.hints.autoThreshold).toBe(1)
    click(radio(panel, 'Show note names automatically', '3 mistakes'))
    expect(settings.value.hints.autoThreshold).toBe(3)
    click(radio(panel, 'Show note names automatically', 'Off'))
    expect(settings.value.hints.autoThreshold).toBeNull()
    expect(radio(panel, 'Show note names automatically', 'Off').getAttribute('aria-checked')).toBe('true')
  })

  it('accepts a custom positive threshold and rejects zero, negatives and text', () => {
    const panel = openTab(open(), 'Hints')
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
    const panel = openTab(open(), 'Hints')
    click(radio(panel, 'Show note names automatically', 'Custom'))
    type(numberInput(panel, 'Custom number of wrong attacks'), '3')
    expect(radio(panel, 'Show note names automatically', 'Custom').getAttribute('aria-checked')).toBe('true')
    expect(settings.value.hints.autoThreshold).toBe(3)
  })

  it('shows a stored non-preset threshold as Custom', () => {
    updateSettings({ hints: { autoThreshold: 6 } })
    const panel = openTab(open(), 'Hints')
    expect(radio(panel, 'Show note names automatically', 'Custom').getAttribute('aria-checked')).toBe('true')
    expect(numberInput(panel, 'Custom number of wrong attacks').value).toBe('6')
  })

  it('chooses the lifetime: 10 / 20 / 30 / 60 s, custom, or until correct', () => {
    const panel = openTab(open(), 'Hints')
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
    type(input, '12.5')
    expect(settings.value.hints.lifetime).toBe(12.5)
  })

  it('changes the fade duration from the slider', () => {
    const panel = openTab(open(), 'Hints')
    type($(panel, 'input[type="range"]'), '500')
    expect(settings.value.hints.fadeMs).toBe(500)
    expect($(panel, 'output')?.textContent).toBe('500 ms')
  })

  it('turns the red flash on a wrong note off and on (on by default)', () => {
    const panel = openTab(open(), 'Hints')
    const flash = toggle(panel, 'Red flash on a wrong note')
    expect(flash.checked).toBe(true)
    expect(panel.textContent).toContain('The red cursor tint and hints stay on.')
    click(flash)
    expect(settings.value.hints.damageFlash).toBe(false)
    expect(toggle(panel, 'Red flash on a wrong note').checked).toBe(false)
    expect(settings.value.hints.autoThreshold).toBe(1) // nothing else changes
    click(toggle(panel, 'Red flash on a wrong note'))
    expect(settings.value.hints.damageFlash).toBe(true)
  })
})

describe('Pedal', () => {
  it('chooses what the hint pedal reveals', () => {
    const panel = openTab(open(), 'Pedal')
    expect(radio(panel, 'Hint pedal action', 'Note names').getAttribute('aria-checked')).toBe('true')
    click(radio(panel, 'Hint pedal action', 'Show keys'))
    expect(settings.value.pedal.hintPedalAction).toBe('keys')
  })

  it('says plainly that no pedal is set', () => {
    const panel = openTab(open(), 'Pedal')
    expect($(panel, '[data-testid="pedal-summary"]')?.textContent).toMatch(/No hint pedal is set/u)
  })

  it('summarizes the learned mapping from settings', () => {
    updateSettings({
      pedal: {
        hintPedal: {
          channel: 0,
          controller: 66,
          threshold: 64,
          inverted: false,
          observedMin: 0,
          observedMax: 127,
          verified: true,
        },
        observedControllers: [64, 66],
      },
    })
    const panel = openTab(open(), 'Pedal')
    const text = $(panel, '[data-testid="pedal-summary"]')?.textContent ?? ''
    expect(text).toMatch(/Sostenuto \(middle pedal\)/u)
    expect(text).toMatch(/channel 1/u)
    expect(text).toMatch(/at or above 64/u)
    expect(text).toMatch(/Tested/u)
    expect(panel.textContent).toMatch(/sustain \(right pedal\), sostenuto \(middle pedal\)/u)
  })

  it('closes Settings and opens Connection from Set up in Connection', () => {
    currentView.value = 'practice'
    const panel = openTab(open(), 'Pedal')
    click(byLabel(panel, 'Set up in Connection'))
    expect(settingsOpen.value).toBe(false)
    expect(connectionOpen.value).toBe(true) // the Connection setup modal opens over the same view
    expect(currentView.value).toBe('practice')
  })
})

describe('Sound', () => {
  it('defaults to Auto: the piano when connected, otherwise this device (S4)', () => {
    const panel = openTab(open(), 'Sound')
    expect(radio(panel, 'Sound destination', 'Auto').getAttribute('aria-checked')).toBe('true')
    expect(panel.textContent).toMatch(
      /connected piano plays when there is one; otherwise sound comes from this device/u,
    )
  })

  it('pins the piano or browser sound by explicit choice', () => {
    const panel = openTab(open(), 'Sound')
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
    const panel = openTab(open(), 'Sound')
    const sliders = $$(panel, 'input[type="range"]')
    type(sliders[0], '0.5')
    expect(settings.value.sound.browserVolume).toBe(0.5)
    type(sliders[1], '0.7')
    expect(settings.value.route.accompanimentLevel).toBe(0.7)
  })

  it('toggles the metronome and its volume, off by default', () => {
    const panel = openTab(open(), 'Sound')
    expect(toggle(panel, 'Metronome click').checked).toBe(false)
    const volume = $$(panel, 'input[type="range"]')[2] as HTMLInputElement
    expect(volume.disabled).toBe(true)
    click(toggle(panel, 'Metronome click'))
    expect(settings.value.metronome.enabled).toBe(true)
    expect(volume.disabled).toBe(false)
    type(volume, '0.3')
    expect(settings.value.metronome.volume).toBe(0.3)
  })

  it('keeps monitoring through browser sound off by default', () => {
    const panel = openTab(open(), 'Sound')
    expect(toggle(panel, 'Hear my keys through browser sound').checked).toBe(false)
    click(toggle(panel, 'Hear my keys through browser sound'))
    expect(settings.value.sound.monitorInput).toBe(true)
  })

  it('warns when browser sound is chosen but Web Audio is missing', () => {
    const panel = openTab(open(detectFeatures({})), 'Sound')
    expect($$(panel, '[role="status"]').some((n) => /metronome click are unavailable/u.test(n.textContent ?? ''))).toBe(
      false,
    )
    click(radio(panel, 'Sound destination', 'Browser sound'))
    expect(panel.textContent).toMatch(/cannot play sound itself/u)
  })
})

describe('General', () => {
  it('toggles suggestions, enabled by default', () => {
    const panel = openTab(open(), 'General')
    expect(toggle(panel, 'Suggest passages to practice').checked).toBe(true)
    click(toggle(panel, 'Suggest passages to practice'))
    expect(settings.value.suggestions.enabled).toBe(false)
  })

  it('chooses the theme', () => {
    const panel = openTab(open(), 'General')
    expect(radio(panel, 'Theme', 'System').getAttribute('aria-checked')).toBe('true')
    click(radio(panel, 'Theme', 'Light'))
    expect(settings.value.view.theme).toBe('light')
    click(radio(panel, 'Theme', 'System'))
    expect(settings.value.view.theme).toBe('system')
  })
})

describe('About', () => {
  it('shows the version, MusicXML-only import, data locality and the Salamander credit', () => {
    const panel = openTab(open(), 'About')
    expect(panel.textContent).toContain(`version ${APP_VERSION}`)
    expect(panel.textContent).toMatch(/MusicXML is the only score format/u)
    expect(panel.textContent).toMatch(/never\s+uploaded/u)
    expect(panel.textContent).toContain('Salamander Grand Piano V3 by Alexander Holm')
    const link = $(panel, 'a') as HTMLAnchorElement
    expect(link.textContent).toBe('CC-BY 3.0')
    expect(link.getAttribute('href')).toBe(SALAMANDER_LICENSE_URL)
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('lists what this browser supports with the explanation for anything missing', () => {
    const panel = openTab(open(detectFeatures({})), 'About')
    expect(panel.textContent).toMatch(/Web MIDI/u)
    expect(panel.textContent).toMatch(/Safari does not offer it/u)
    expect(panel.textContent).toMatch(/MIDIWeb/u)
    const supported = openTab(open(ALL_FEATURES), 'About')
    expect($$(supported, '[data-supported="false"]')).toHaveLength(0)
  })
})
