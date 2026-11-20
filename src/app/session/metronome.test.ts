import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '../../core/model/settings'
import { mergeSettings, type SettingsPatch } from '../settingsMerge'
import { metronomeOn, metronomePatch, metronomeScope } from './metronome'

describe('metronome scope (DECISIONS P20)', () => {
  it('uses the Keep time preference only with Keep time on and a hand selected', () => {
    expect(metronomeScope(true, 'both')).toBe('keepTime')
    expect(metronomeScope(true, 'right')).toBe('keepTime')
    expect(metronomeScope(true, 'left')).toBe('keepTime')
    expect(metronomeScope(true, 'none')).toBe('general')
    expect(metronomeScope(false, 'both')).toBe('general')
    expect(metronomeScope(false, 'none')).toBe('general')
  })

  it('reads the scope’s own switch', () => {
    const m = { ...DEFAULT_SETTINGS.metronome, enabled: true, keepTime: false, volume: 0.5 }
    expect(metronomeOn(m, 'general')).toBe(true)
    expect(metronomeOn(m, 'keepTime')).toBe(false)
    expect(metronomeOn(DEFAULT_SETTINGS.metronome, 'general')).toBe(false)
    expect(metronomeOn(DEFAULT_SETTINGS.metronome, 'keepTime')).toBe(true)
  })

  it('patches only the scope’s own switch', () => {
    expect(metronomePatch('general', true)).toEqual({ metronome: { enabled: true } })
    expect(metronomePatch('keepTime', false)).toEqual({ metronome: { keepTime: false } })
    // What `updateSettings` takes, without a cast.
    const patch: SettingsPatch<AppSettings> = metronomePatch('keepTime', false)
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.metronome).toEqual({ ...DEFAULT_SETTINGS.metronome, keepTime: false })
    expect(mergeSettings(next, metronomePatch('general', true)).metronome).toEqual({
      ...DEFAULT_SETTINGS.metronome,
      enabled: true,
      keepTime: false,
    })
  })
})
