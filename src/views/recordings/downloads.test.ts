import { expect, it } from 'vitest'
import { recordingName } from './downloads'

const take = { title: 'Prelude', createdAt: Date.UTC(2026, 10, 21, 2, 4, 56, 789) }

it('uses the local date and fractional-hour offset at the start of the take', () => {
  expect(recordingName({ ...take, startUtcOffsetMinutes: -210 })).toBe('Prelude - 2026-11-20 22-34-56.789 UTC-0330')
})

it('uses the absolute start time for an older recording with no stored offset', () => {
  expect(recordingName(take)).toBe('Prelude - 2026-11-21 02-04-56.789 UTC+0000')
})
