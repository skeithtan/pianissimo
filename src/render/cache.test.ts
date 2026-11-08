import { describe, expect, it } from 'vitest'
import {
  MemoryLayoutCache,
  isPreparedLayout,
  layoutKey,
  storeLayoutCache,
  tieredLayoutCache,
  type LayoutStore,
} from './cache'
import { PREPARED_LAYOUT_FORMAT, type PreparedLayout } from './types'

function layout(
  key: string,
  svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g class="vf-measure"><path d="M0 0L1 1"></path></g></svg>',
  bytes = 0,
): PreparedLayout {
  return {
    format: PREPARED_LAYOUT_FORMAT,
    key,
    scoreVersionId: 'v1',
    renderer: { name: 'osmd', version: 'x' },
    params: {
      labelChars: 3,
      labelFontPx: 12,
      labelW: 25,
      labelH: 14,
      segmentWidth: 1600,
      spacing: { voiceSpacingMultiplier: 1.4, voiceSpacingAddend: 3 },
      iterations: 1,
    },
    width: 10,
    top: 0,
    height: 10,
    staves: [],
    occurrences: [],
    notes: [],
    labels: [],
    ottavas: [],
    contexts: [
      {
        id: 0,
        width: 10,
        staves: [{ staff: 0, glyph: { svg: '<g transform="translate(1 2)"><path d="M0 0"></path></g>', width: 10 } }],
      },
    ],
    contextChanges: [],
    segments: [
      { index: 0, occStart: 0, occEnd: 0, x0: 0, x1: 10, svg: svg + 'x'.repeat(bytes), labelStart: 0, labelEnd: 0 },
    ],
    report: {
      modelNotes: 0,
      graphicalNotes: 0,
      mapped: 0,
      unmappedNotes: [],
      unmappedGraphics: [],
      relaxedMatches: 0,
      sharedHeads: 0,
      ottavasMapped: 0,
      ottavasUnmapped: [],
    },
    stats: {
      loadMs: 0,
      engraveMs: 0,
      extractMs: 0,
      labelMs: 0,
      partitionMs: 0,
      totalMs: 0,
      svgNodes: 0,
      segmentBytes: 0,
      labelFailuresPerIteration: [],
      placements: { right: 0, stagger: 0, left: 0, stack: 0, callout: 0 },
    },
  }
}

describe('layoutKey', () => {
  it('changes with every geometry parameter but not with zoom', () => {
    const base = {
      scoreVersionId: 's',
      renderer: { name: 'osmd', version: '1' },
      labelChars: 3,
      labelFontPx: 12,
      segmentWidth: 1600,
    }
    const k = layoutKey(base)
    expect(layoutKey({ ...base, labelChars: 5 })).not.toBe(k)
    expect(layoutKey({ ...base, labelFontPx: 14 })).not.toBe(k)
    expect(layoutKey({ ...base, renderer: { name: 'osmd', version: '2' } })).not.toBe(k)
    expect(layoutKey({ ...base, scoreVersionId: 't' })).not.toBe(k)
    expect(layoutKey(base)).toBe(k)
  })

  it('keys a page layout by its requested width and, when set, its canvas cap (R17)', () => {
    const page = {
      scoreVersionId: 's',
      renderer: { name: 'osmd', version: '1' },
      labelChars: 3,
      labelFontPx: 12,
      segmentWidth: 1600,
      mode: 'page' as const,
      pageWidth: 360,
    }
    const k = layoutKey(page)
    expect(k).toContain('page360')
    expect(layoutKey({ ...page, pageWidth: 368 })).not.toBe(k)
    expect(layoutKey({ ...page, pageMaxWidth: 360 })).not.toBe(k)
    expect(layoutKey({ ...page, pageMaxWidth: 360 })).toContain('max360')
    expect(layoutKey({ ...page, mode: 'strip' as const })).not.toContain('page')
  })
})

describe('MemoryLayoutCache', () => {
  it('evicts least recently used layouts beyond its byte bound', async () => {
    const cache = new MemoryLayoutCache(2500)
    await cache.put(layout('a', undefined, 1000))
    await cache.put(layout('b', undefined, 1000))
    await cache.get('a')
    await cache.put(layout('c', undefined, 1000))
    expect(await cache.get('b')).toBeUndefined()
    expect(await cache.get('a')).toBeDefined()
    expect(await cache.get('c')).toBeDefined()
    expect(cache.bytes).toBeLessThanOrEqual(2500 + 2000)
  })
})

describe('tieredLayoutCache', () => {
  it('answers from memory first, copies stored hits into memory, writes to both', async () => {
    const fast = new MemoryLayoutCache()
    const reads: string[] = []
    const slowData = new Map([['s', layout('s')]])
    const slow = {
      get: async (key: string) => (reads.push(key), slowData.get(key)),
      put: async (l: PreparedLayout) => void slowData.set(l.key, l),
    }
    const cache = tieredLayoutCache(fast, slow)
    expect(await cache.get('s')).toBe(slowData.get('s'))
    expect(await cache.get('s')).toBe(slowData.get('s'))
    expect(reads).toEqual(['s'])
    const m = layout('m')
    await cache.put(m)
    expect(await fast.get('m')).toBe(m)
    expect(slowData.get('m')).toBe(m)
    expect(await cache.get('none')).toBeUndefined()
  })
})

describe('storeLayoutCache', () => {
  function store(value: unknown): LayoutStore & { puts: unknown[] } {
    const puts: unknown[] = []
    return { puts, getLayout: async () => value, putLayout: async (...args) => void puts.push(args) }
  }

  it('reads back valid layouts and writes with size and score version', async () => {
    const l = layout('k')
    const s = store(l)
    const cache = storeLayoutCache(s)
    expect(await cache.get('k')).toBe(l)
    await cache.put(l)
    expect((s.puts[0] as unknown[]).slice(0, 2)).toEqual(['k', 'v1'])
  })

  it('treats other keys, formats and tampered markup as a miss', async () => {
    expect(await storeLayoutCache(store(layout('other'))).get('k')).toBeUndefined()
    expect(await storeLayoutCache(store({ ...layout('k'), format: 99 })).get('k')).toBeUndefined()
    const evil = layout(
      'k',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="x" onerror="alert(1)"></image></svg>',
    )
    expect(isPreparedLayout(evil)).toBe(false)
    expect(isPreparedLayout(layout('k', '<svg><path d="M0 0" onclick="x()"></path></svg>'))).toBe(false)
    expect(isPreparedLayout(layout('k', '<svg><script>alert(1)</script></svg>'))).toBe(false)
    expect(isPreparedLayout(layout('k'))).toBe(true)
  })
})
