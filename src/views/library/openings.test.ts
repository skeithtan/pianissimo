// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PieceRecord } from '../../core/storage/records'
import { LibraryOpenings, TILES } from './openings'

const piece = (id: string, createdAt = 0): PieceRecord => ({ id, scoreVersionId: `v-${id}`, createdAt }) as PieceRecord
const note = (n: number, midi: number, hand: 'L' | 'R') => ({
  onset: { n, d: 4 },
  soundingDuration: { n: 1, d: 4 },
  midi,
  hand,
  tieContinuation: false,
  cue: false,
})
const model = {
  occurrences: [{ start: { n: 0, d: 1 }, duration: { n: 1, d: 1 } }],
  notes: [note(0, 60, 'R'), note(1, 48, 'L')],
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

describe('library openings (U157)', () => {
  it('reads each missing opening once and keeps it for the next visit', async () => {
    const getPackage = vi.fn(async () => ({ model }))
    const deps = { getStorage: async () => ({ getPackage }) } as never
    const done = new LibraryOpenings(deps).fill([piece('a'), piece('b')])
    await vi.runAllTimersAsync()
    await done
    expect(getPackage).toHaveBeenCalledTimes(2)
    const next = new LibraryOpenings(deps)
    expect(next.all.value.get('v-a')).toEqual({ bars: [192], notes: [0, 48, 60, 0, 48, 48, 48, 1] })
    await next.fill([piece('a'), piece('b')])
    expect(getPackage).toHaveBeenCalledTimes(2)
  })

  it('stops with the view, and ignores a damaged cache', async () => {
    localStorage.setItem('pianissimo.openings', '{"v":1,"openings":{"v-a":{"bars":["x"],"notes":[1]}}}')
    const getPackage = vi.fn(async () => ({ model }))
    const openings = new LibraryOpenings({ getStorage: async () => ({ getPackage }) } as never)
    expect(openings.all.value.size).toBe(0)
    const done = openings.fill([piece('a')])
    openings.stop()
    await vi.runAllTimersAsync()
    await done
    expect(getPackage).not.toHaveBeenCalled()
  })

  it('gives the grounds in turn and lets each piece keep its own, whatever the list order later', async () => {
    const deps = { getStorage: async () => ({ getPackage: async () => undefined }) } as never
    const pieces = [piece('a'), piece('b'), piece('c')]
    const first = new LibraryOpenings(deps)
    expect([...first.tilesOf(pieces).values()]).toEqual(TILES.slice(0, 3))
    void first.fill(pieces)
    const next = new LibraryOpenings(deps)
    expect(next.tilesOf([piece('new'), ...[...pieces].reverse()])).toEqual(
      new Map([
        ['new', TILES[3]],
        ['c', TILES[2]],
        ['b', TILES[1]],
        ['a', TILES[0]],
      ]),
    )
  })
})
