import { describe, expect, it } from 'vitest'
import { ManualClock } from '../../core/playback/testkit'
import { createPieceSaver } from './persistence'
import type { PiecePatch } from './types'

describe('createPieceSaver', () => {
  it('debounces and merges patches; immediate saves write at once', async () => {
    const clock = new ManualClock()
    const writes: PiecePatch[] = []
    const saver = createPieceSaver(async (p) => void writes.push(p), clock, 1000)
    saver.save({ lastMultiplier: 0.8 })
    saver.save({ lastHands: 'left' })
    expect(writes).toHaveLength(0)
    clock.advance(1000)
    await saver.flush()
    expect(writes).toEqual([{ lastMultiplier: 0.8, lastHands: 'left' }])
    saver.save({ repeatTarget: 3 }, true)
    await saver.flush()
    expect(writes).toHaveLength(2)
    saver.save({ lastPassage: null })
    saver.dispose()
    await saver.flush()
    expect(writes.at(-1)).toEqual({ lastPassage: null })
    saver.save({ lastMultiplier: 2 }, true)
    await saver.flush()
    expect(writes).toHaveLength(3)
  })

  it('coalesces saves made during a slow write into one following write', async () => {
    const clock = new ManualClock()
    const writes: PiecePatch[] = []
    const releases: (() => void)[] = []
    const saver = createPieceSaver(
      (p) =>
        new Promise<void>((resolve) => {
          writes.push(p)
          releases.push(resolve)
        }),
      clock,
      1000,
    )
    saver.save({ lastMultiplier: 0.8 }, true)
    await Promise.resolve()
    expect(writes).toHaveLength(1)
    saver.save({ lastHands: 'left' }, true)
    saver.save({ mode: 'time' }, true)
    saver.save({ lastMultiplier: 0.9 }, true)
    expect(writes).toHaveLength(1)
    let flushed = false
    void saver.flush().then(() => (flushed = true))
    releases[0]!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual({ lastHands: 'left', mode: 'time', lastMultiplier: 0.9 })
    expect(flushed).toBe(false)
    releases[1]!()
    await saver.flush()
    expect(flushed).toBe(true)
    expect(writes).toHaveLength(2)
    // Idle again: a new immediate save starts a new write.
    saver.save({ repeatTarget: 2 }, true)
    await Promise.resolve()
    expect(writes).toHaveLength(3)
    releases[2]!()
    await saver.flush()
  })

  it('a failed write does not block later ones', async () => {
    const clock = new ManualClock()
    const writes: PiecePatch[] = []
    let fail = true
    const saver = createPieceSaver(
      async (p) => {
        writes.push(p)
        if (fail) throw new Error('quota')
      },
      clock,
      1000,
    )
    saver.save({ lastMultiplier: 0.8 }, true)
    await saver.flush()
    fail = false
    saver.save({ lastHands: 'right' }, true)
    await saver.flush()
    expect(writes).toEqual([{ lastMultiplier: 0.8 }, { lastHands: 'right' }])
  })

  it('a write that throws synchronously does not block later saves', async () => {
    const clock = new ManualClock()
    const writes: PiecePatch[] = []
    let fail = true
    const saver = createPieceSaver(
      (p) => {
        writes.push(p)
        if (fail) {
          fail = false
          throw new Error('sync')
        }
        return Promise.resolve()
      },
      clock,
      1000,
    )
    saver.save({ lastMultiplier: 0.8 }, true)
    await saver.flush()
    saver.save({ lastHands: 'right' }, true)
    await saver.flush()
    saver.save({ lastHands: 'left' }, true)
    await saver.flush()
    expect(writes).toEqual([{ lastMultiplier: 0.8 }, { lastHands: 'right' }, { lastHands: 'left' }])
  })

  it('flush with nothing pending resolves and writes nothing; the debounce fires once', async () => {
    const clock = new ManualClock()
    const writes: PiecePatch[] = []
    const saver = createPieceSaver(async (p) => void writes.push(p), clock, 1000)
    await saver.flush()
    expect(writes).toHaveLength(0)
    saver.save({ lastMultiplier: 0.8 })
    clock.advance(999)
    expect(writes).toHaveLength(0)
    clock.advance(1)
    await saver.flush()
    expect(writes).toHaveLength(1)
    clock.advance(5000)
    await saver.flush()
    expect(writes).toHaveLength(1)
  })

  it('writes nothing after dispose except the final flush', async () => {
    const clock = new ManualClock()
    const writes: PiecePatch[] = []
    const saver = createPieceSaver(async (p) => void writes.push(p), clock, 1000)
    saver.save({ lastMultiplier: 0.8 })
    saver.dispose()
    saver.save({ lastHands: 'left' }, true)
    saver.save({ lastHands: 'right' })
    clock.advance(5000)
    await saver.flush()
    expect(writes).toEqual([{ lastMultiplier: 0.8 }])
  })
})
