import type { LayoutCacheLimits, LayoutMeta } from './records'
import { DEFAULT_LAYOUT_LIMITS } from './records'
import type { Db } from './schema'
import { runTx } from './tx'

export interface LayoutCacheStats {
  readonly entries: number
  readonly bytes: number
}

/**
 * Bounded cache for the renderer's serialized prepared layouts (spec "Execution and rendering
 * architecture": cache completed score packages and reusable geometry so reopening a piece
 * avoids repeated engraving). Derived data: never exported, and every failure degrades to a
 * miss so the cache can never break practice.
 *
 * Eviction is least-recently-used by total `approxBytes` and by entry count. A `get` refreshes
 * only the small meta record, never rewriting the payload.
 */
export class LayoutCache {
  readonly #db: Db
  readonly #limits: LayoutCacheLimits
  readonly #now: () => number

  constructor(db: Db, limits: Partial<LayoutCacheLimits> = {}, now: () => number = Date.now) {
    this.#db = db
    this.#limits = { ...DEFAULT_LAYOUT_LIMITS, ...limits }
    this.#now = now
  }

  /** The stored value, or undefined on a miss (including any storage error). */
  async get(key: string): Promise<unknown | undefined> {
    try {
      const tx = this.#db.transaction(['layoutCache', 'layoutMeta'], 'readwrite')
      return await runTx(tx, async () => {
        const [payload, meta] = await Promise.all([
          tx.objectStore('layoutCache').get(key),
          tx.objectStore('layoutMeta').get(key),
        ])
        if (payload && meta) {
          await tx.objectStore('layoutMeta').put({ ...meta, lastUsedAt: this.#now() })
          return payload.value
        }
        if (payload || meta) {
          // Half an entry (interrupted write): drop it so it cannot be counted or served.
          await Promise.all([tx.objectStore('layoutCache').delete(key), tx.objectStore('layoutMeta').delete(key)])
        }
        return undefined
      })
    } catch {
      return undefined
    }
  }

  /**
   * Store a layout for a score version, then evict least-recently-used entries until the
   * limits hold again. Returns false (and stores nothing) when the value alone exceeds the
   * byte limit, cannot be structured-cloned, or storage refuses it.
   */
  async put(key: string, scoreVersionId: string, value: unknown, approxBytes: number): Promise<boolean> {
    const bytes = Math.max(1, Math.ceil(Number.isFinite(approxBytes) ? approxBytes : 0))
    if (bytes > this.#limits.maxBytes) return false
    const now = this.#now()
    const meta: LayoutMeta = { key, scoreVersionId, approxBytes: bytes, createdAt: now, lastUsedAt: now }
    try {
      const tx = this.#db.transaction(['layoutCache', 'layoutMeta'], 'readwrite')
      await runTx(tx, async () => {
        await tx.objectStore('layoutCache').put({ key, value })
        await tx.objectStore('layoutMeta').put(meta)
        const all = await tx.objectStore('layoutMeta').getAll()
        for (const victim of this.#victims(all, key)) {
          await Promise.all([tx.objectStore('layoutCache').delete(victim), tx.objectStore('layoutMeta').delete(victim)])
        }
      })
      return true
    } catch {
      return false
    }
  }

  /** Least-recently-used keys to drop so that the limits hold, never the entry just written. */
  #victims(all: readonly LayoutMeta[], keep: string): string[] {
    let bytes = 0
    for (const m of all) bytes += m.approxBytes
    let count = all.length
    const oldestFirst = all
      .filter((m) => m.key !== keep)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt || a.key.localeCompare(b.key))
    const victims: string[] = []
    for (const m of oldestFirst) {
      if (bytes <= this.#limits.maxBytes && count <= this.#limits.maxEntries) break
      victims.push(m.key)
      bytes -= m.approxBytes
      count -= 1
    }
    return victims
  }

  /** Drop the layouts of one score version, or everything. */
  async clear(scoreVersionId?: string): Promise<void> {
    const tx = this.#db.transaction(['layoutCache', 'layoutMeta'], 'readwrite')
    await runTx(tx, async () => {
      if (scoreVersionId === undefined) {
        await Promise.all([tx.objectStore('layoutCache').clear(), tx.objectStore('layoutMeta').clear()])
        return
      }
      const keys = await tx.objectStore('layoutMeta').index('scoreVersionId').getAllKeys(scoreVersionId)
      await Promise.all(
        keys.flatMap((k) => [tx.objectStore('layoutCache').delete(k), tx.objectStore('layoutMeta').delete(k)]),
      )
    })
  }

  async stats(): Promise<LayoutCacheStats> {
    const all = await this.#db.getAll('layoutMeta')
    return { entries: all.length, bytes: all.reduce((sum, m) => sum + m.approxBytes, 0) }
  }
}
