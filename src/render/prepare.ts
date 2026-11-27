/**
 * Cache-aware preparation (spec: "Cache completed score packages and reusable geometry so
 * reopening a piece avoids repeated parsing and engraving").
 */
import { layoutKey, type LayoutCache } from './cache'
import { LABEL_FONT_PX } from './labels/metrics'
import { pageMaxWidthOf, pageWidthOf } from './osmd/page'
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
    labelRoom: options.labels.room ?? 'all',
    segmentWidth: options.segmentWidth ?? DEFAULT_SEGMENT_WIDTH,
    ...(options.mode === 'page'
      ? { mode: 'page' as const, pageWidth: pageWidthOf(options), ...pageMaxWidthOf(options) }
      : {}),
  })
  const hit = cache ? await cache.get(key).catch(() => undefined) : undefined
  if (hit) {
    if (hit.report.unmappedNotes.length > 0) {
      console.warn(`Score layout left ${hit.report.unmappedNotes.length} note(s) unmapped`, hit.report.unmappedNotes)
    }
    options.onProgress?.('done', 1)
    return { layout: hit, cached: true }
  }
  const layout = await adapter.prepare(input, options)
  if (layout.report.unmappedNotes.length > 0) {
    console.warn(
      `Score layout left ${layout.report.unmappedNotes.length} note(s) unmapped`,
      layout.report.unmappedNotes,
    )
  }
  await cache?.put(layout).catch(() => undefined)
  return { layout, cached: false }
}
