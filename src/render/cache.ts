/**
 * Prepared-layout caching (spec "Execution and rendering architecture": cache reusable geometry so
 * reopening a piece avoids repeated engraving). A `PreparedLayout` is plain JSON keyed by score
 * version + renderer version + every parameter that changes geometry (label sizing and room,
 * segment width; in page mode the mode and the page width). Zoom is not part of the key: it is a CSS
 * scale (R2); page mode turns a zoom into a page width, which is.
 */
import { isSafeSvgMarkup } from './sanitize'
import { PREPARED_LAYOUT_FORMAT, type LabelRoom, type LayoutMode, type PreparedLayout } from './types'

export interface LayoutCache {
  get(key: string): Promise<PreparedLayout | undefined>
  put(layout: PreparedLayout): Promise<void>
}

export interface LayoutKeyParts {
  readonly scoreVersionId: string
  readonly renderer: { readonly name: string; readonly version: string }
  readonly labelChars: number
  readonly labelFontPx: number
  /** Default 'all'. */
  readonly labelRoom?: LabelRoom
  readonly segmentWidth: number
  /** 'page' (portrait page mode) adds the page width to the key; the strip's key is unchanged. */
  readonly mode?: LayoutMode
  /** Page mode: requested wrapping width (layout px), before label-aware expansion. */
  readonly pageWidth?: number
}

export function layoutKey(p: LayoutKeyParts): string {
  const parts = [
    `f${PREPARED_LAYOUT_FORMAT}`,
    p.scoreVersionId,
    `${p.renderer.name}@${p.renderer.version}`,
    `l${p.labelChars}x${p.labelFontPx}`,
    `s${p.segmentWidth}`,
  ]
  if (p.labelRoom === 'hints') parts.push('hints')
  if (p.mode === 'page') parts.push(`page${p.pageWidth ?? 0}`)
  return parts.join('|')
}

/** Approximate in-memory size: serialized segment text dominates. */
export function approxLayoutBytes(layout: PreparedLayout): number {
  let bytes = 0
  for (const s of layout.segments) bytes += s.svg.length
  for (const c of layout.contexts) for (const st of c.staves) bytes += st.glyph.svg.length
  return bytes + 64 * (layout.notes.length + layout.labels.length + layout.occurrences.length * 8)
}

/**
 * Structural check for layouts read back from storage; rejects other formats, other keys and any
 * markup outside the sanitizer's allow-list (segments are mounted with innerHTML).
 */
export function isPreparedLayout(value: unknown, key?: string): value is PreparedLayout {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<PreparedLayout>
  return (
    v.format === PREPARED_LAYOUT_FORMAT &&
    typeof v.key === 'string' &&
    (key === undefined || v.key === key) &&
    Array.isArray(v.segments) &&
    v.segments.every((s) => typeof s?.svg === 'string' && isSafeSvgMarkup(s.svg)) &&
    Array.isArray(v.contexts) &&
    v.contexts.every((c) => Array.isArray(c?.staves) && c.staves.every(safeGlyph)) &&
    Array.isArray(v.notes) &&
    Array.isArray(v.labels) &&
    Array.isArray(v.occurrences) &&
    Array.isArray(v.staves) &&
    typeof v.width === 'number' &&
    (v.mode === undefined || v.mode === 'strip' || (v.mode === 'page' && Array.isArray(v.systems)))
  )
}

function safeGlyph(st: { glyph?: { svg?: unknown } } | undefined): boolean {
  return typeof st?.glyph?.svg === 'string' && isSafeSvgMarkup(st.glyph.svg)
}

/** Bounded in-memory LRU of prepared layouts (by approximate bytes). */
export class MemoryLayoutCache implements LayoutCache {
  private readonly entries = new Map<string, { layout: PreparedLayout; bytes: number }>()
  private total = 0

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  async get(key: string): Promise<PreparedLayout | undefined> {
    const e = this.entries.get(key)
    if (!e) return undefined
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.layout
  }

  async put(layout: PreparedLayout): Promise<void> {
    const bytes = approxLayoutBytes(layout)
    const old = this.entries.get(layout.key)
    if (old) {
      this.total -= old.bytes
      this.entries.delete(layout.key)
    }
    this.entries.set(layout.key, { layout, bytes })
    this.total += bytes
    for (const [k, e] of this.entries) {
      if (this.total <= this.maxBytes || this.entries.size <= 1) break
      this.entries.delete(k)
      this.total -= e.bytes
    }
  }

  get bytes(): number {
    return this.total
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * A fast cache in front of a slow one: hits in `slow` are copied into `fast`, puts go to both.
 * Practice keeps recent layouts in memory so switching Labels Off ↔ on (two engravings) skips the
 * IndexedDB read and validation of a layout that was just shown.
 */
export function tieredLayoutCache(fast: LayoutCache, slow: LayoutCache): LayoutCache {
  return {
    async get(key) {
      const hit = await fast.get(key)
      if (hit) return hit
      const stored = await slow.get(key)
      if (stored) await fast.put(stored)
      return stored
    },
    async put(layout) {
      await fast.put(layout)
      await slow.put(layout)
    },
  }
}

/** The generic store the storage module provides (IndexedDB `layoutCache`, bounded there). */
export interface LayoutStore {
  getLayout(key: string): Promise<unknown>
  putLayout(key: string, scoreVersionId: string, value: unknown, approxBytes: number): Promise<void>
}

/** Adapts a storage-backed store; values that fail validation read as a miss. */
export function storeLayoutCache(store: LayoutStore): LayoutCache {
  return {
    async get(key) {
      const v = await store.getLayout(key)
      return isPreparedLayout(v, key) ? v : undefined
    },
    put(layout) {
      return store.putLayout(layout.key, layout.scoreVersionId, layout, approxLayoutBytes(layout))
    },
  }
}
