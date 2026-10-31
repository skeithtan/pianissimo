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
})
