import type { RefObject } from 'preact'
import { useLayoutEffect, useState } from 'preact/hooks'

/**
 * Tracks an element's content width in CSS pixels. Falls back to `fallback` until a real
 * measurement exists (first render, tests, or environments without layout).
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const measure = () => setWidth(Math.round(element.clientWidth))
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width > 0 ? width : fallback
}
