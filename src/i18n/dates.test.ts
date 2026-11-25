import { expect, it } from 'vitest'
import { dateText, timeOfDay } from './dates'

const at = new Date(2026, 8, 5, 18, 4)
const long = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } as const

it('times are on the 24-hour clock', () => {
  expect([timeOfDay(at), timeOfDay(new Date(2026, 8, 5, 0, 30).getTime())]).toEqual(['18:04', '00:30'])
})

it('English dates are day, month, year, whatever the English; other languages keep their order', () => {
  for (const english of ['en-US', 'en-CA', 'en-PH', 'en-GB'])
    expect(dateText(at, long, english)).toBe('Saturday 5 September 2026')
  expect(dateText(at, { day: 'numeric', month: 'short' }, 'en-US')).toBe('5 Sep')
  expect(dateText(at, long, 'fr-CA')).toBe('samedi 5 septembre 2026')
  expect(dateText(at, { day: 'numeric', month: 'long', year: 'numeric' }, 'ja-JP')).toBe('2026年9月5日')
})
