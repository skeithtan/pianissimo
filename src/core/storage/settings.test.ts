import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../model/settings'
import type { AppSettings } from '../model/settings'
import { normalizeSettings } from './settings'

const custom: AppSettings = {
  ...DEFAULT_SETTINGS,
  naming: {
    system: 'fixed-do',
    seventh: 'ti',
    showOctave: false,
    alwaysShowEffectiveAccidentals: false,
    simplifyEnharmonics: true,
  },
  labels: {
    mode: 'conditional',
    rules: {
      G2: {
        below: { enabled: true, threshold: { step: 'D', alter: 1, octave: 4 } },
        above: { enabled: true, threshold: { step: 'C', alter: 0, octave: 6 } },
      },
      F4: {
        below: { enabled: false, threshold: null },
        above: { enabled: true, threshold: { step: 'E', alter: -1, octave: 3 } },
      },
      'G2-8': {
        below: { enabled: true, threshold: { step: 'C', alter: 0, octave: 3 } },
        above: { enabled: false, threshold: null },
      },
    },
  },
  hints: { autoThreshold: null, lifetime: 'until-correct', fadeMs: 150, damageFlash: false },
  pedal: {
    hintPedal: {
      channel: 2,
      controller: 66,
      threshold: 40,
      inverted: true,
      observedMin: 3,
      observedMax: 120,
      verified: true,
    },
    hintPedalAction: 'keys',
    observedControllers: [64, 66, 67],
  },
  route: {
    inputId: 'in-1',
    inputName: 'Piano',
    outputId: 'out-1',
    outputName: 'Piano',
    outputChannel: 3,
    outputVerified: true,
    echo: 'none',
    automaticPedalsInHandPractice: true,
    accompanimentLevel: 0.5,
    connection: 'bluetooth',
  },
  sound: { destination: 'browser', browserVolume: 0.25, monitorInput: true },
  metronome: { enabled: true, volume: 0.1 },
  view: { zoom: 1.75, theme: 'dark', scorePaper: 'light' },
  suggestions: { enabled: false },
}

describe('normalizeSettings', () => {
  it('returns the defaults for nothing or garbage', () => {
    for (const raw of [undefined, null, 5, 'text', [], {}]) {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('keeps every valid stored value, including deliberate nulls', () => {
    expect(normalizeSettings(custom)).toEqual(custom)
    expect(normalizeSettings(JSON.parse(JSON.stringify(custom)))).toEqual(custom)
  })

  it('is idempotent', () => {
    const once = normalizeSettings(custom)
    expect(normalizeSettings(once)).toEqual(once)
  })

  it('fills fields missing from an older version with defaults', () => {
    const { metronome: _m, view: _v, suggestions: _s, ...older } = custom
    const loaded = normalizeSettings(older)
    expect(loaded.metronome).toEqual(DEFAULT_SETTINGS.metronome)
    expect(loaded.view).toEqual(DEFAULT_SETTINGS.view)
    expect(loaded.suggestions).toEqual(DEFAULT_SETTINGS.suggestions)
    expect(loaded.naming).toEqual(custom.naming)
  })

  it('merges within sections: a missing field takes its default, present ones are kept', () => {
    const loaded = normalizeSettings({ naming: { system: 'fixed-do' }, hints: { fadeMs: 500 } })
    expect(loaded.naming).toEqual({ ...DEFAULT_SETTINGS.naming, system: 'fixed-do' })
    expect(loaded.hints).toEqual({ ...DEFAULT_SETTINGS.hints, fadeMs: 500 })
  })

  it('falls back per field for wrong types and unknown enum values', () => {
    const loaded = normalizeSettings({
      naming: { system: 'solfege', seventh: 3, showOctave: 'yes' },
      labels: { mode: 'sometimes' },
      hints: { autoThreshold: 0, lifetime: -5, fadeMs: 'fast', damageFlash: 'no' },
      route: { outputChannel: 16, accompanimentLevel: 2, echo: 'maybe', connection: 'wifi' },
      sound: { destination: 'speaker', browserVolume: -1 },
      view: { zoom: 0, theme: 'sepia' },
    })
    expect(loaded.naming).toEqual(DEFAULT_SETTINGS.naming)
    expect(loaded.labels.mode).toBe('off')
    expect(loaded.hints).toEqual(DEFAULT_SETTINGS.hints)
    expect(loaded.route).toEqual(DEFAULT_SETTINGS.route)
    expect(loaded.sound).toEqual(DEFAULT_SETTINGS.sound)
    expect(loaded.view).toEqual(DEFAULT_SETTINGS.view)
  })

  describe('automatic hint threshold (version 3)', () => {
    it('defaults to one wrong attack', () => {
      expect(DEFAULT_SETTINGS.hints.autoThreshold).toBe(1)
      expect(normalizeSettings({}).hints.autoThreshold).toBe(1)
    })

    it('reads a stored 2 (the old default) from an older version as 1, once', () => {
      for (const version of [undefined, 1, 2]) {
        const old = { ...custom, version, hints: { ...custom.hints, autoThreshold: 2 } }
        const migrated = normalizeSettings(old)
        expect(migrated.version).toBe(SETTINGS_VERSION)
        expect(migrated.hints.autoThreshold).toBe(1)
        expect(normalizeSettings(migrated).hints.autoThreshold).toBe(1)
      }
    })

    it('keeps any other stored value from an older version, and a 2 chosen in the current version', () => {
      for (const autoThreshold of [null, 1, 3, 5]) {
        expect(normalizeSettings({ ...custom, version: 2, hints: { ...custom.hints, autoThreshold } }).hints).toEqual({
          ...custom.hints,
          autoThreshold,
        })
      }
      const current = { ...custom, hints: { ...custom.hints, autoThreshold: 2 } }
      expect(current.version).toBe(SETTINGS_VERSION)
      expect(normalizeSettings(current).hints.autoThreshold).toBe(2)
    })
  })

  describe('damage flash (DECISIONS S5)', () => {
    it('defaults to on, also for settings stored before the field existed (no version bump)', () => {
      expect(DEFAULT_SETTINGS.hints.damageFlash).toBe(true)
      expect(normalizeSettings({}).hints.damageFlash).toBe(true)
      const before = { ...custom, hints: { autoThreshold: 3, lifetime: 20, fadeMs: 300 } }
      const loaded = normalizeSettings(before)
      expect(loaded.hints).toEqual({ autoThreshold: 3, lifetime: 20, fadeMs: 300, damageFlash: true })
      expect(loaded.version).toBe(SETTINGS_VERSION)
    })

    it('keeps a stored choice and falls back to on for a wrong type', () => {
      expect(normalizeSettings({ hints: { damageFlash: false } }).hints.damageFlash).toBe(false)
      expect(normalizeSettings({ hints: { damageFlash: true } }).hints.damageFlash).toBe(true)
      expect(normalizeSettings({ hints: { damageFlash: 0 } }).hints.damageFlash).toBe(true)
      expect(normalizeSettings({ hints: { damageFlash: null } }).hints.damageFlash).toBe(true)
    })
  })

  describe('sound destination (DECISIONS S4)', () => {
    it('defaults to Auto', () => {
      expect(DEFAULT_SETTINGS.sound.destination).toBe('auto')
      expect(normalizeSettings({}).sound.destination).toBe('auto')
    })

    it('reads a version 1 "midi" (the old default) as Auto, once', () => {
      const old = { ...custom, version: 1, sound: { ...custom.sound, destination: 'midi' } }
      const migrated = normalizeSettings(old)
      expect(migrated.version).toBe(SETTINGS_VERSION)
      expect(migrated.sound.destination).toBe('auto')
      expect(normalizeSettings({ sound: { destination: 'midi' } }).sound.destination).toBe('auto')
    })

    it('keeps an explicit choice made in the current version, and browser sound from any version', () => {
      expect(normalizeSettings({ ...custom, sound: { ...custom.sound, destination: 'midi' } }).sound.destination).toBe(
        'midi',
      )
      expect(
        normalizeSettings({ ...custom, version: 1, sound: { ...custom.sound, destination: 'browser' } }).sound
          .destination,
      ).toBe('browser')
      expect(normalizeSettings({ ...custom, sound: { ...custom.sound, destination: 'auto' } }).sound.destination).toBe(
        'auto',
      )
    })
  })

  describe('label rules merge per clef', () => {
    it('keeps the default treble preset and bass rule when nothing was stored', () => {
      expect(normalizeSettings({ labels: { mode: 'all' } }).labels.rules).toEqual(DEFAULT_SETTINGS.labels.rules)
    })

    it('lets a stored clef override the default and keeps the other defaults', () => {
      const rules = normalizeSettings({
        labels: { rules: { F4: { below: { enabled: true, threshold: { step: 'C', alter: 0, octave: 3 } } } } },
      }).labels.rules
      expect(rules['G2']).toEqual(DEFAULT_SETTINGS.labels.rules['G2'])
      expect(rules['F4']?.below).toEqual({ enabled: true, threshold: { step: 'C', alter: 0, octave: 3 } })
      expect(rules['F4']?.above).toEqual(DEFAULT_SETTINGS.labels.rules['F4']?.above)
    })

    it('does not copy treble thresholds into the bass rule', () => {
      const rules = normalizeSettings({ labels: { rules: { G2: custom.labels.rules['G2'] } } }).labels.rules
      expect(rules['F4']).toEqual(DEFAULT_SETTINGS.labels.rules['F4'])
    })

    it('a cleared threshold stays cleared instead of reverting to the preset', () => {
      const rules = normalizeSettings({
        labels: {
          rules: { G2: { below: { enabled: false, threshold: null }, above: { enabled: false, threshold: null } } },
        },
      }).labels.rules
      expect(rules['G2']).toEqual({
        below: { enabled: false, threshold: null },
        above: { enabled: false, threshold: null },
      })
    })

    it('adds an unknown clef with both conditions disabled unless stored', () => {
      const rules = normalizeSettings({ labels: { rules: { C3: {} } } }).labels.rules
      expect(rules['C3']).toEqual({
        below: { enabled: false, threshold: null },
        above: { enabled: false, threshold: null },
      })
    })

    it('rejects malformed thresholds and keeps the preset value', () => {
      const bad = [
        { step: 'H', alter: 0, octave: 4 },
        { step: 'C', alter: 3, octave: 4 },
        { step: 'C', alter: 0.5, octave: 4 },
        { step: 'C', alter: 0, octave: 40 },
        { step: 'C', alter: 0 },
        'C4',
      ]
      for (const threshold of bad) {
        const rules = normalizeSettings({ labels: { rules: { G2: { below: { enabled: true, threshold } } } } }).labels
          .rules
        expect(rules['G2']?.below).toEqual({
          enabled: true,
          threshold: DEFAULT_SETTINGS.labels.rules['G2']?.below.threshold,
        })
      }
    })
  })

  it('drops a malformed hint pedal mapping to the unset default but keeps a deliberate null', () => {
    expect(normalizeSettings({ pedal: { hintPedal: { controller: 'sustain' } } }).pedal.hintPedal).toBeNull()
    expect(normalizeSettings({ pedal: { hintPedal: null } }).pedal.hintPedal).toBeNull()
    expect(normalizeSettings({ pedal: { hintPedal: { controller: 200 } } }).pedal.hintPedal).toBeNull()
    const ok = normalizeSettings({ pedal: { hintPedal: { channel: null, controller: 66 } } }).pedal.hintPedal
    expect(ok).toMatchObject({ channel: null, controller: 66, threshold: 64, inverted: false, verified: false })
  })

  it('sanitizes the observed controller list', () => {
    expect(
      normalizeSettings({ pedal: { observedControllers: [64, 64, 66, 'x', 300, -1, 1.5] } }).pedal.observedControllers,
    ).toEqual([64, 66])
    expect(normalizeSettings({ pedal: { observedControllers: 'no' } }).pedal.observedControllers).toEqual([])
  })

  it('never returns shared mutable defaults', () => {
    const a = normalizeSettings(undefined)
    const b = normalizeSettings(undefined)
    expect(a.labels.rules).not.toBe(b.labels.rules)
    expect(a.labels.rules['G2']).not.toBe(DEFAULT_SETTINGS.labels.rules['G2'])
  })
})
