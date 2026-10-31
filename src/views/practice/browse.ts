/**
 * The bar being browsed (DECISIONS U6: the loop steppers act on "the bar under the cursor line in
 * the view, including while browsing"). While the learner drags or wheels the strip away from
 * the cursor, this is the bar at the cursor's resting place in the viewport (`CURSOR_ANCHOR`
 * from the left, the strip's default); otherwise null and callers use the cursor's own bar.
 *
 * The strip reports only the start and end of browsing, so the bar is re-read at most once per
 * frame after the gestures that move the view (pointer moves, wheel, key presses) bubble up to
 * `target`. Nothing here runs on MIDI input.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { FrameApi } from '../../app/session'

/** Where the strip rests its cursor (StripOptions.cursorAnchor default). */
export const CURSOR_ANCHOR = 1 / 3

/** What the hook needs from the strip. */
export interface BrowsableStrip {
  isBrowsing(): boolean
  occAt(clientX: number): number
}

const MOVES = ['pointermove', 'pointerup', 'wheel', 'keyup'] as const

export interface BrowsedBar {
  /** The browsed bar, or null when the view follows the cursor. */
  readonly occ: number | null
  /** Pass to `StripOptions.onBrowse`. */
  readonly onBrowse: (browsing: boolean) => void
}

export function useBrowsedBar(
  target: { current: HTMLElement | null },
  strip: { current: BrowsableStrip | null },
  lastOcc: number,
  frames: FrameApi,
): BrowsedBar {
  const [occ, setOcc] = useState<number | null>(null)
  const pending = useRef<unknown>(null)

  const measure = () => {
    pending.current = null
    const s = strip.current
    const el = target.current
    if (!s || !el || !s.isBrowsing()) {
      setOcc(null)
      return
    }
    const rect = el.getBoundingClientRect()
    const at = s.occAt(rect.left + rect.width * CURSOR_ANCHOR)
    setOcc(at < 0 ? null : Math.min(Math.max(0, at), lastOcc))
  }
  const schedule = () => {
    if (pending.current === null) pending.current = frames.request(measure)
  }
  const latest = useRef({ schedule, measure })
  latest.current = { schedule, measure }

  useEffect(() => {
    const el = target.current
    if (!el) return
    const onMove = () => {
      if (strip.current?.isBrowsing()) latest.current.schedule()
    }
    for (const type of MOVES) el.addEventListener(type, onMove, { passive: true })
    return () => {
      for (const type of MOVES) el.removeEventListener(type, onMove)
      if (pending.current !== null) frames.cancel(pending.current)
      pending.current = null
    }
  }, [target, strip, frames])

  return {
    occ,
    onBrowse: (browsing) => {
      if (browsing) latest.current.schedule()
      else {
        if (pending.current !== null) frames.cancel(pending.current)
        pending.current = null
        setOcc(null)
      }
    },
  }
}
