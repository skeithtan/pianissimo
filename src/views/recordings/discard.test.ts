import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { notices, resetAppStateForTests } from '../../app/state'
import type { PianissimoStorage } from '../../core/storage'
import { discarded, discardHeld, discardTakes, resetDiscardForTests, UNDO_MANY_MS, UNDO_MS } from './discard'

const calls = {
  discardRecordings: vi.fn(async (_: readonly string[]) => undefined),
  restoreRecordings: vi.fn(async (_: readonly string[]) => undefined),
  removeDiscardedRecordings: vi.fn(async (_: readonly string[]) => undefined),
}
const storage = async () => calls as unknown as PianissimoStorage
const texts = () => notices.value.map((n) => n.text)
const undo = async () => {
  notices.value.find((n) => n.action)!.action!.run()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetAppStateForTests()
  for (const call of Object.values(calls)) call.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  resetDiscardForTests()
  resetAppStateForTests()
  vi.useRealTimers()
})

it('takes a recording out at once, and Undo brings it back', async () => {
  await discardTakes(storage, ['a'])
  expect(calls.discardRecordings).toHaveBeenCalledWith(['a'])
  expect([...discarded.value]).toEqual(['a'])
  expect(texts()).toEqual(['Recording discarded'])
  await undo()
  expect(calls.restoreRecordings).toHaveBeenCalledWith(['a'])
  expect([...discarded.value]).toEqual([])
  expect(texts()).toEqual(['Recording restored'])
  await vi.advanceTimersByTimeAsync(UNDO_MANY_MS)
  expect(calls.removeDiscardedRecordings).not.toHaveBeenCalled()
})

it('removes it for good once Undo is gone', async () => {
  await discardTakes(storage, ['a'])
  await vi.advanceTimersByTimeAsync(UNDO_MS - 1)
  expect(calls.removeDiscardedRecordings).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(calls.removeDiscardedRecordings).toHaveBeenCalledWith(['a'])
  expect(texts()).toEqual([])
  expect([...discarded.value]).toEqual(['a'])
})

it('one toast stands for everything discarded while it shows, a take that was recording included', async () => {
  const keep = vi.fn(async () => undefined)
  await discardTakes(storage, ['a'])
  discardHeld(storage, keep)
  await vi.advanceTimersByTimeAsync(UNDO_MS)
  await discardTakes(storage, ['b', 'c'])
  expect(texts()).toEqual(['4 recordings discarded'])
  await undo()
  expect(calls.restoreRecordings).toHaveBeenCalledWith(['a', 'b', 'c'])
  expect(keep).toHaveBeenCalledOnce()
  expect(texts()).toEqual(['4 recordings restored'])
})

it('drops a take discarded while recording when Undo is gone, and says when Undo could not save it', async () => {
  const dropped = vi.fn(async () => undefined)
  discardHeld(storage, dropped)
  await vi.advanceTimersByTimeAsync(UNDO_MS)
  expect(dropped).not.toHaveBeenCalled()
  expect(calls.removeDiscardedRecordings).not.toHaveBeenCalled()

  discardHeld(storage, () => Promise.reject(new Error('full')))
  await undo()
  expect(texts()).toEqual(['Recording could not be saved. Open Recordings to download it or retry.'])
})

it('discards nothing when that cannot be written, and offers Undo again when Undo fails', async () => {
  calls.discardRecordings.mockRejectedValueOnce(new Error('closed'))
  await expect(discardTakes(storage, ['a'])).rejects.toThrow()
  expect([...discarded.value]).toEqual([])
  expect(texts()).toEqual([])

  await discardTakes(storage, ['a'])
  calls.restoreRecordings.mockRejectedValueOnce(new Error('closed'))
  await undo()
  expect(texts()).toEqual(['Could not undo. Try again.', 'Recording discarded'])
  await undo()
  expect([...discarded.value]).toEqual([])
})
