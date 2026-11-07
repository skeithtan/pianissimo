/**
 * Keeps an anchored popover fully inside the viewport (`placePopover`): measures the anchor and
 * the panel's natural size before paint, on open and on resize / orientation change. Shared by
 * the tempo popover and the Practice footer menu (DECISIONS U76).
 */
import { useLayoutEffect, useState } from 'preact/hooks'
import { placePopover, type PopoverPlacement, type PopoverSide } from './popoverPlacement'

export function usePopoverPlacement(
  mounted: boolean,
  preferred: PopoverSide,
  anchor: { current: HTMLElement | null },
  panel: { current: HTMLElement | null },
): PopoverPlacement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  useLayoutEffect(() => {
    if (!mounted) {
      setPlacement(null)
      return
    }
    const measure = () => {
      const root = anchor.current
      const el = panel.current
      if (!root || !el) return
      const doc = document.documentElement
      const next = placePopover({
        anchor: root.getBoundingClientRect(),
        size: { width: el.offsetWidth, height: el.scrollHeight },
        viewport: { width: doc.clientWidth || window.innerWidth, height: window.innerHeight },
        preferred,
      })
      setPlacement((prev) =>
        prev && prev.side === next.side && Math.abs(prev.left - next.left) < 0.5 && prev.maxHeight === next.maxHeight
          ? prev
          : next,
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [mounted, preferred, anchor, panel])
  return placement
}
