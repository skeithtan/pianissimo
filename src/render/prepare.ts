/**
 * Cache-aware preparation (spec: "Cache completed score packages and reusable geometry so
 * reopening a piece avoids repeated parsing and engraving").
 */
import { layoutKey, type LayoutCache } from './cache'
import { LABEL_FONT_PX } from './labels/metrics'
import { pageWidthOf } from './osmd/page'
import { DEFAULT_SEGMENT_WIDTH } from './partition'
import type { PreparedLayout, PrepareOptions, RenderInput, RendererAdapter } from './types'

/** Returns the cached layout for these parameters, or prepares and stores a new one. */
export async function prepareLayout(
  adapter: RendererAdapter,
  cache: LayoutCache | null,
  input: RenderInput,
  options: PrepareOptions,
): Promise<{ layout: PreparedLayout; cached: boolean }> {
  const key = layoutKey({
    scoreVersionId: input.scoreVersionId,
    renderer: { name: adapter.name, version: adapter.version },
    labelChars: options.labels.maxChars,
    labelFontPx: options.labels.fontPx ?? LABEL_FONT_PX,
    segmentWidth: options.segmentWidth ?? DEFAULT_SEGMENT_WIDTH,
    ...(options.mode === 'page' ? { mode: 'page' as const, pageWidth: pageWidthOf(options) } : {}),
  })
  const hit = cache ? await cache.get(key).catch(() => undefined) : undefined
  if (hit) {
    options.onProgress?.('done', 1)
    return { layout: hit, cached: true }
  }
  const layout = await adapter.prepare(input, options)
  await cache?.put(layout).catch(() => undefined)
  return { layout, cached: false }
}
