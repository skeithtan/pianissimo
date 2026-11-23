import { describe, expect, it, vi } from 'vitest'
import { TAKE_CLOCK_MS, TAKE_LIMIT_MS, TAKE_WARNING_MS, startTakeClock } from './takeClock'

function rig() {
  let now = 1_000
  let run: (() => void) | null = null
  const cancel = vi.fn(() => {
    run = null
  })
  const events = { tick: vi.fn(), warn: vi.fn(), limit: vi.fn() }
  const stop = startTakeClock(
    () => now,
    (fn, ms) => {
      expect(ms).toBe(TAKE_CLOCK_MS)
      run = fn
      return cancel
    },
    events,
  )
  const at = (ms: number) => {
    now = 1_000 + ms
    run?.()
  }
  return { at, events, cancel, stop }
}

describe('take length', () => {
  it('ticks whole seconds, warns once at 20 minutes and stops the take at 60', () => {
    const { at, events, cancel } = rig()
    at(1_500)
    expect(events.tick).toHaveBeenLastCalledWith(1)
    at(TAKE_WARNING_MS - 1)
    expect(events.warn).not.toHaveBeenCalled()
    at(TAKE_WARNING_MS)
    expect(events.warn).toHaveBeenCalledTimes(1)
    at(TAKE_WARNING_MS + 60_000)
    expect(events.warn).toHaveBeenCalledTimes(1)
    at(TAKE_LIMIT_MS - 1)
    expect(events.limit).not.toHaveBeenCalled()
    at(TAKE_LIMIT_MS)
    expect(events.limit).toHaveBeenCalledTimes(1)
    expect(events.tick).toHaveBeenLastCalledWith(3600)
    expect(cancel).toHaveBeenCalled()
    at(TAKE_LIMIT_MS + 1_000)
    expect(events.limit).toHaveBeenCalledTimes(1)
  })

  it('warns and stops even when the timer was late (a busy page)', () => {
    const { at, events } = rig()
    at(TAKE_LIMIT_MS + 5_000)
    expect(events.warn).toHaveBeenCalledTimes(1)
    expect(events.limit).toHaveBeenCalledTimes(1)
  })

  it('does nothing after it is stopped (Stop pressed)', () => {
    const { at, events, stop, cancel } = rig()
    stop()
    expect(cancel).toHaveBeenCalled()
    at(TAKE_LIMIT_MS)
    expect(events.limit).not.toHaveBeenCalled()
  })
})
