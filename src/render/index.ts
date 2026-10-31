/**
 * Public API of the notation renderer (WP6). OSMD itself is only reached through a dynamic import
 * inside `OsmdRenderer.prepare`, so importing this module does not fetch the notation engine; the
 * practice view should still import it lazily to keep the strip code off the library path.
 */
export { OsmdRenderer, RENDERER_NAME, RENDERER_VERSION, DEFAULT_SPACING, labelMetrics } from './osmd/adapter'
export { StripView } from './strip/StripView'
export type { CorrectionMark, LoopRange, LoopSelectMode, StripOptions, StripStats } from './strip/StripView'
export { PageView, PAGE_PAD_TOP } from './page/PageView'
export type { PageOptions, PageStats } from './page/PageView'
export { PAGE_GUTTER, PageGeometry, pageWidthFor } from './page/geometry'
export { MemoryLayoutCache, layoutKey, storeLayoutCache, isPreparedLayout, approxLayoutBytes } from './cache'
export type { LayoutCache, LayoutKeyParts, LayoutStore } from './cache'
export { prepareLayout } from './prepare'
export { canvasMeasurer, estimateMeasurer } from './labels/metrics'
export type { TextMeasurer } from './labels/metrics'
export { positionToX, occAtX, occAtPosition } from './strip/scroll'
export type * from './types'
