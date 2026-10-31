import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { LayoutCache } from './layoutCache'
import { openPianissimoDb } from './schema'
import type { Db } from './schema'
import { freshName } from './testkit'

const dbs: Db[] = []
async function cache(limits: ConstructorParameters<typeof LayoutCache>[1] = {}) {
  const db = await openPianissimoDb(freshName())
  dbs.push(db)
  let clock = 1_000
  const tick = (): number => (clock += 10)
  return { db, layouts: new LayoutCache(db, limits, tick) }
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

describe('layout cache', () => {
  it('stores and returns serialized layouts, and misses cleanly', async () => {
    const { layouts } = await cache()
    expect(await layouts.get('a')).toBeUndefined()
    const value = { measures: [{ x: 1, y: 2 }], label: 'segment', nested: { list: [1, 2, 3] } }
    expect(await layouts.put('a', 'v1', value, 100)).toBe(true)
    expect(await layouts.get('a')).toEqual(value)
    expect(await layouts.stats()).toEqual({ entries: 1, bytes: 100 })
  })

  it('replaces a key and re-counts its size', async () => {
    const { layouts } = await cache()
    await layouts.put('a', 'v1', 'one', 100)
    await layouts.put('a', 'v1', 'two', 40)
    expect(await layouts.get('a')).toBe('two')
    expect(await layouts.stats()).toEqual({ entries: 1, bytes: 40 })
  })

  it('evicts the least recently used entries when the byte limit is exceeded', async () => {
    const { layouts } = await cache({ maxBytes: 300 })
    await layouts.put('a', 'v1', 'A', 100)
    await layouts.put('b', 'v1', 'B', 100)
    await layouts.put('c', 'v1', 'C', 100)
    expect((await layouts.stats()).bytes).toBe(300)
    await layouts.put('d', 'v1', 'D', 150)
    // a and b were the oldest; both go to make room for 150 bytes.
    expect(await layouts.get('a')).toBeUndefined()
    expect(await layouts.get('b')).toBeUndefined()
    expect(await layouts.get('c')).toBe('C')
    expect(await layouts.get('d')).toBe('D')
    expect((await layouts.stats()).bytes).toBeLessThanOrEqual(300)
  })

  it('a read refreshes recency', async () => {
    const { layouts } = await cache({ maxBytes: 300 })
    await layouts.put('a', 'v1', 'A', 100)
    await layouts.put('b', 'v1', 'B', 100)
    await layouts.put('c', 'v1', 'C', 100)
    expect(await layouts.get('a')).toBe('A')
    await layouts.put('d', 'v1', 'D', 100)
    expect(await layouts.get('b')).toBeUndefined()
    expect(await layouts.get('a')).toBe('A')
    expect(await layouts.get('c')).toBe('C')
  })

  it('evicts by entry count too', async () => {
    const { layouts } = await cache({ maxEntries: 3 })
    for (const key of ['a', 'b', 'c', 'd', 'e']) await layouts.put(key, 'v1', key, 1)
    expect(await layouts.stats()).toEqual({ entries: 3, bytes: 3 })
    expect(await layouts.get('a')).toBeUndefined()
    expect(await layouts.get('b')).toBeUndefined()
    expect(await layouts.get('e')).toBe('e')
  })

  it('never evicts the entry just written', async () => {
    const { layouts } = await cache({ maxBytes: 100 })
    await layouts.put('a', 'v1', 'A', 60)
    await layouts.put('b', 'v1', 'B', 100)
    expect(await layouts.get('b')).toBe('B')
    expect(await layouts.get('a')).toBeUndefined()
  })

  it('refuses a value larger than the whole cache', async () => {
    const { layouts } = await cache({ maxBytes: 100 })
    await layouts.put('a', 'v1', 'A', 50)
    expect(await layouts.put('huge', 'v1', 'H', 101)).toBe(false)
    expect(await layouts.get('huge')).toBeUndefined()
    expect(await layouts.get('a')).toBe('A')
  })

  it('defaults to 50 MB', async () => {
    const { layouts } = await cache()
    expect(await layouts.put('big', 'v1', 'x', 50 * 1024 * 1024)).toBe(true)
    expect(await layouts.put('bigger', 'v1', 'x', 50 * 1024 * 1024 + 1)).toBe(false)
  })

  it('degrades to a miss when the value cannot be stored', async () => {
    const { layouts } = await cache()
    await layouts.put('a', 'v1', 'A', 10)
    expect(await layouts.put('fn', 'v1', { run: () => 1 }, 10)).toBe(false)
    expect(await layouts.get('fn')).toBeUndefined()
    expect(await layouts.get('a')).toBe('A')
    expect((await layouts.stats()).entries).toBe(1)
  })

  it('treats non-finite sizes as the minimum size', async () => {
    const { layouts } = await cache()
    expect(await layouts.put('a', 'v1', 'A', Number.NaN)).toBe(true)
    expect((await layouts.stats()).bytes).toBe(1)
  })

  it('clears one score version or everything', async () => {
    const { layouts } = await cache()
    await layouts.put('a', 'v1', 'A', 10)
    await layouts.put('b', 'v2', 'B', 10)
    await layouts.put('c', 'v2', 'C', 10)
    await layouts.clear('v2')
    expect(await layouts.get('a')).toBe('A')
    expect(await layouts.get('b')).toBeUndefined()
    expect(await layouts.get('c')).toBeUndefined()
    await layouts.clear()
    expect(await layouts.stats()).toEqual({ entries: 0, bytes: 0 })
  })

  it('drops half-written entries instead of serving or counting them', async () => {
    const { db, layouts } = await cache()
    await db.put('layoutCache', { key: 'orphan', value: 'payload without meta' })
    expect(await layouts.get('orphan')).toBeUndefined()
    expect(await db.get('layoutCache', 'orphan')).toBeUndefined()
    await db.put('layoutMeta', { key: 'ghost', scoreVersionId: 'v1', approxBytes: 5, createdAt: 1, lastUsedAt: 1 })
    expect(await layouts.get('ghost')).toBeUndefined()
    expect(await db.get('layoutMeta', 'ghost')).toBeUndefined()
  })

  it('never throws when the database is gone', async () => {
    const { db, layouts } = await cache()
    db.close()
    expect(await layouts.get('a')).toBeUndefined()
    expect(await layouts.put('a', 'v1', 'A', 1)).toBe(false)
  })
})
