import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_WAIT_MS, stageBoundary } from './boundary'

describe('stageBoundary', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('goes on one macrotask after the next frame, not before', async () => {
    vi.useFakeTimers()
    let frame: (() => void) | undefined
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frame = cb
      return 1
    })
    let resolved = false
    void stageBoundary().then(() => (resolved = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(resolved).toBe(false)
    frame!()
    await Promise.resolve()
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('goes on without a frame after the fallback delay (a hidden tab)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    let resolved = false
    void stageBoundary().then(() => (resolved = true))
    await vi.advanceTimersByTimeAsync(FRAME_WAIT_MS - 1)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(true)
  })
})
