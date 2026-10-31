/**
 * Pure placement for small anchored popovers (the tempo popover): keep the panel fully on screen.
 * Horizontally it is centered on the anchor, then shifted to stay `margin` px inside the viewport.
 * Vertically it opens on the preferred side, flips when that side is too short and the other
 * side is taller, and otherwise caps its height to the space available (the panel scrolls).
 */

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type PopoverSide = 'down' | 'up'

export interface PopoverPlacementInput {
  /** The anchor (the control the popover belongs to), in viewport coordinates. */
  readonly anchor: Rect
  /** Natural size of the popover panel. */
  readonly size: { readonly width: number; readonly height: number }
  readonly viewport: { readonly width: number; readonly height: number }
  readonly preferred: PopoverSide
  /** Distance kept from the viewport edges. */
  readonly margin?: number
  /** Distance between the anchor and the panel. */
  readonly gap?: number
}

export interface PopoverPlacement {
  readonly side: PopoverSide
  /** Left edge relative to the anchor's left edge. */
  readonly left: number
  /** Height cap, or null when the natural height fits. */
  readonly maxHeight: number | null
}

export const POPOVER_MARGIN = 12
export const POPOVER_GAP = 8

export function placePopover({
  anchor,
  size,
  viewport,
  preferred,
  margin = POPOVER_MARGIN,
  gap = POPOVER_GAP,
}: PopoverPlacementInput): PopoverPlacement {
  const centered = anchor.left + anchor.width / 2 - size.width / 2
  const maxLeft = viewport.width - margin - size.width
  // A panel wider than the viewport keeps its left edge on screen.
  const viewportLeft = Math.max(margin, Math.min(centered, maxLeft))

  const below = viewport.height - (anchor.top + anchor.height) - gap - margin
  const above = anchor.top - gap - margin
  const space = (side: PopoverSide) => (side === 'down' ? below : above)
  const other: PopoverSide = preferred === 'down' ? 'up' : 'down'
  const side = size.height <= space(preferred) || space(preferred) >= space(other) ? preferred : other
  const available = Math.max(0, Math.floor(space(side)))

  return {
    side,
    left: viewportLeft - anchor.left,
    maxHeight: size.height <= available ? null : available,
  }
}
