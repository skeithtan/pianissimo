import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { MIN_HINT_LIFETIME_SECONDS, parsePositive } from './numbers'
import { controllerName, describeHintPedal, describeObservedPedals } from './pedalSummary'

describe('parsePositive', () => {
  const opts = { integer: true, max: 99, what: 'a number of wrong attacks' } as const

  it('reads positive numbers', () => {
    expect(parsePositive('3', opts)).toEqual({ ok: true, value: 3 })
    expect(parsePositive(' 12 ', opts)).toEqual({ ok: true, value: 12 })
    expect(parsePositive('0,5', { max: 10, what: 'seconds' })).toEqual({ ok: true, value: 0.5 })
    expect(parsePositive('.5', { max: 10, what: 'seconds' })).toEqual({ ok: true, value: 0.5 })
  })

  it('rejects empty, zero, negative, fractional-when-integer, huge and unreadable input', () => {
    expect(parsePositive('', opts)).toEqual({ ok: false, error: 'Enter a number of wrong attacks.' })
    expect(parsePositive('0', opts)).toMatchObject({ ok: false, error: expect.stringMatching(/greater than zero/u) })
    expect(parsePositive('-1', opts)).toMatchObject({ ok: false })
    expect(parsePositive('2.5', opts)).toEqual({ ok: false, error: 'Use a whole number.' })
    expect(parsePositive('100', opts)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 99/u) })
    expect(parsePositive('abc', opts)).toMatchObject({ ok: false, error: expect.stringMatching(/not a number/u) })
    expect(parsePositive('1e3', opts)).toMatchObject({ ok: false })
    expect(parsePositive('Infinity', opts)).toMatchObject({ ok: false })
  })

  it('rejects values under the minimum the stored settings keep (hint lifetime)', () => {
    const lifetime = { max: 3600, min: MIN_HINT_LIFETIME_SECONDS, what: 'a number of seconds' }
    expect(parsePositive('0.05', lifetime)).toEqual({ ok: false, error: 'A number of seconds must be at least 0.1.' })
    expect(parsePositive('0.1', lifetime)).toEqual({ ok: true, value: 0.1 })
  })
})

describe('pedal summary', () => {
  it('names the standard controllers', () => {
    expect(controllerName(64)).toBe('sustain (right pedal)')
    expect(controllerName(66)).toBe('sostenuto (middle pedal)')
    expect(controllerName(67)).toBe('soft (left pedal)')
    expect(controllerName(11)).toBe('controller 11')
  })

  it('explains an unset pedal', () => {
    expect(describeHintPedal(null)).toMatch(/enable automatic hints in Settings/u)
  })

  it('describes channel, direction and verification', () => {
    const base = {
      channel: null,
      controller: 67,
      threshold: 40,
      inverted: true,
      observedMin: 0,
      observedMax: 127,
      verified: false,
    }
    const text = describeHintPedal(base)
    expect(text).toMatch(/^Soft \(left pedal\), any channel\./u)
    expect(text).toMatch(/down at or below 40/u)
    expect(text).toMatch(/Not tested yet/u)
    expect(describeHintPedal({ ...base, channel: 2, inverted: false, verified: true })).toMatch(
      /channel 3\..*at or above 40.*Tested/u,
    )
  })

  it('lists observed pedals', () => {
    expect(describeObservedPedals(DEFAULT_SETTINGS.pedal)).toBeNull()
    expect(describeObservedPedals({ ...DEFAULT_SETTINGS.pedal, observedControllers: [64, 67] })).toBe(
      'sustain (right pedal), soft (left pedal)',
    )
  })
})
