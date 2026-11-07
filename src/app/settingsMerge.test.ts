import { describe, expect, it } from 'vitest'
import { DEFAULT_RHYTHM_TOLERANCE_MS } from '../core/engine'
import { DEFAULT_SETTINGS, DISABLED_RULE, TREBLE_PRESET, type AppSettings } from '../core/model/settings'
import { deepEqual, mergeSettings, normalizeSettings, settingsFromStored } from './settingsMerge'

describe('mergeSettings', () => {
  it('merges nested objects without mutating the base', () => {
    const base = structuredClone(DEFAULT_SETTINGS)
    const frozen = JSON.stringify(base)
    const next = mergeSettings(base, { naming: { showOctave: false }, hints: { fadeMs: 150 } })
    expect(next.naming.showOctave).toBe(false)
    expect(next.naming.system).toBe('letter') // sibling kept
    expect(next.hints).toEqual({ autoThreshold: 1, lifetime: 30, fadeMs: 150, damageFlash: true })
    expect(JSON.stringify(base)).toBe(frozen)
  })

  it('keeps the identity of untouched branches', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { naming: { showOctave: false } })
    expect(next.hints).toBe(DEFAULT_SETTINGS.hints)
    expect(next.labels).toBe(DEFAULT_SETTINGS.labels)
    expect(next.naming).not.toBe(DEFAULT_SETTINGS.naming)
  })

  it('returns the base itself when nothing changes', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, {})).toBe(DEFAULT_SETTINGS)
    expect(mergeSettings(DEFAULT_SETTINGS, { naming: { system: 'letter' } })).toBe(DEFAULT_SETTINGS)
    expect(mergeSettings(DEFAULT_SETTINGS, { hints: { fadeMs: undefined } })).toBe(DEFAULT_SETTINGS)
  })

  it('merges per-clef label rules per key', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, {
      labels: { rules: { F4: { below: { enabled: true, threshold: { step: 'C', alter: 0, octave: 3 } } } } },
    })
    expect(next.labels.rules['G2']).toBe(TREBLE_PRESET) // treble untouched
    expect(next.labels.rules['F4']?.below).toEqual({ enabled: true, threshold: { step: 'C', alter: 0, octave: 3 } })
    expect(next.labels.rules['F4']?.above).toEqual(DISABLED_RULE.above) // sibling condition kept
  })

  it('adds a rule for a clef that had none', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { labels: { rules: { C3: TREBLE_PRESET } } })
    expect(Object.keys(next.labels.rules).sort()).toEqual(['C3', 'F4', 'G2'])
  })

  it('replaces nullable and array values whole', () => {
    const withThreshold = mergeSettings(DEFAULT_SETTINGS, {
      labels: { rules: { G2: { below: { threshold: { step: 'D', alter: 1, octave: 3 } } } } },
    })
    expect(withThreshold.labels.rules['G2']?.below.threshold).toEqual({ step: 'D', alter: 1, octave: 3 })
    const cleared = mergeSettings(withThreshold, { labels: { rules: { G2: { below: { threshold: null } } } } })
    expect(cleared.labels.rules['G2']?.below.threshold).toBeNull()
    const controllers = mergeSettings(DEFAULT_SETTINGS, { pedal: { observedControllers: [64, 66] } })
    expect(controllers.pedal.observedControllers).toEqual([64, 66])
  })

  it('ignores prototype-polluting keys from untrusted data', () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "naming": {"__proto__": {"polluted": true}, "showOctave": false}}',
    )
    const next = mergeSettings(DEFAULT_SETTINGS, hostile)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect((next.naming as unknown as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(next.naming.showOctave).toBe(false)
  })
})

describe('deepEqual', () => {
  it('compares structure, not identity', () => {
    expect(deepEqual(DEFAULT_SETTINGS, structuredClone(DEFAULT_SETTINGS))).toBe(true)
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual([], {})).toBe(false)
  })
})

describe('normalizeSettings', () => {
  it('returns the same object when settings are already sound', () => {
    expect(normalizeSettings(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS)
  })

  it('completes a partial rule with both disabled conditions', () => {
    const partial = mergeSettings(DEFAULT_SETTINGS, {
      labels: { rules: { C3: { below: { enabled: true } } } },
    }) as AppSettings
    const fixed = normalizeSettings(partial)
    expect(fixed.labels.rules['C3']).toEqual({
      below: { enabled: true, threshold: null },
      above: { enabled: false, threshold: null },
    })
  })

  it('falls back per field for invalid enumerations and out-of-range numbers', () => {
    const junk = mergeSettings(DEFAULT_SETTINGS, {
      labels: { mode: 'sometimes' },
      hints: { autoThreshold: 0, lifetime: -5, fadeMs: -1 },
      sound: { destination: 'cloud', browserVolume: 7 },
      view: { theme: 'neon' },
    } as never)
    const fixed = normalizeSettings(junk)
    expect(fixed.labels.mode).toBe('off')
    expect(fixed.hints).toEqual(DEFAULT_SETTINGS.hints)
    expect(fixed.sound.destination).toBe('auto')
    expect(fixed.sound.browserVolume).toBe(DEFAULT_SETTINGS.sound.browserVolume)
    expect(fixed.view.theme).toBe('system')
  })

  it('replaces a threshold that is not a pitch with the default threshold', () => {
    const junk = mergeSettings(DEFAULT_SETTINGS, {
      labels: { rules: { G2: { below: { threshold: { step: 'H', alter: 0, octave: 4 } } } } },
    } as never)
    expect(normalizeSettings(junk).labels.rules['G2']?.below.threshold).toEqual(
      DEFAULT_SETTINGS.labels.rules['G2']?.below.threshold,
    )
  })
})

describe('settingsFromStored', () => {
  it('fills settings added in later versions from the defaults', () => {
    const stored = { naming: { system: 'fixed-do' } }
    const loaded = settingsFromStored(stored)
    expect(loaded.naming.system).toBe('fixed-do')
    expect(loaded.naming.showOctave).toBe(true)
    expect(loaded.metronome).toEqual(DEFAULT_SETTINGS.metronome)
    expect(loaded.rhythm).toEqual(DEFAULT_SETTINGS.rhythm)
  })

  it("defaults the Keep time tolerance to the engine's default", () => {
    expect(DEFAULT_SETTINGS.rhythm.toleranceMs).toBe(DEFAULT_RHYTHM_TOLERANCE_MS)
  })

  it('merges a tolerance patch and clamps an out-of-range one', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { rhythm: { toleranceMs: 80 } })
    expect(normalizeSettings(next).rhythm).toEqual({ toleranceMs: 80 })
    expect(normalizeSettings(mergeSettings(DEFAULT_SETTINGS, { rhythm: { toleranceMs: 2 } })).rhythm).toEqual({
      toleranceMs: 40,
    })
  })

  it('survives garbage', () => {
    expect(settingsFromStored(null)).toBe(DEFAULT_SETTINGS)
    expect(settingsFromStored('text')).toBe(DEFAULT_SETTINGS)
    expect(settingsFromStored({ naming: 5, hints: null, unknownSection: { a: 1 } })).toBe(DEFAULT_SETTINGS)
  })
})

describe('score paper setting', () => {
  it('defaults to following the theme and repairs unknown values', () => {
    expect(DEFAULT_SETTINGS.view.scorePaper).toBe('theme')
    const broken = { ...DEFAULT_SETTINGS, view: { ...DEFAULT_SETTINGS.view, scorePaper: 'sepia' as never } }
    expect(normalizeSettings(broken).view.scorePaper).toBe('theme')
  })
})
