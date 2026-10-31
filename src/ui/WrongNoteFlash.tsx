/**
 * Wrong-note feedback (spec "Mistake feedback and hints"): a red damage vignette that animates in
 * fast and decays in about 300 ms. The notation stays still and readable; repeated errors
 * extend the feedback instead of strobing it.
 */
import type { ReadonlySignal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { FlashDriver } from './flashDriver'
import type { FlashHitOptions } from './flashEnvelope'
import styles from './WrongNoteFlash.module.css'

export interface WrongNoteFlashHandle {
  /**
   * Start or extend the flash. `now` and `untilMs` are `performance.now()` milliseconds.
   * `{ soft: true }` (a too-early press) is gentler: at most `SOFT_FLASH_PEAK` (0.35) of the full
   * flash, a shorter decay, and never above a full flash already showing.
   */
  hit(now?: number, untilMs?: number, options?: FlashHitOptions): void
  /** Remove the flash at once (seek, restart, correct completion). */
  clear(): void
}

const valueOf = (v: number | ReadonlySignal<number>): number => (typeof v === 'number' ? v : v.value)

/**
 * Full-viewport, pointer-events-none overlay. Drive it with the `trigger` counter (increase it on
 * every wrong attack; a signal updates only this component) or imperatively through `onReady`.
 * `until` is the engine's `wrongFeedbackUntil` in `performance.now()` ms.
 */
export function WrongNoteFlash({
  trigger,
  until,
  onReady,
}: {
  trigger?: number | ReadonlySignal<number>
  until?: number | ReadonlySignal<number>
  onReady?: (handle: WrongNoteFlashHandle) => void
}) {
  const overlay = useRef<HTMLDivElement>(null)
  const driver = useRef<FlashDriver | null>(null)
  const count = trigger === undefined ? 0 : valueOf(trigger)
  const deadline = until === undefined ? undefined : valueOf(until)
  const seen = useRef(count)

  useLayoutEffect(() => {
    const element = overlay.current
    if (!element) return
    const created = new FlashDriver({ overlay: element })
    driver.current = created
    onReady?.({ hit: (now, untilMs, options) => created.hit(now, untilMs, options), clear: () => created.clear() })
    return () => {
      created.dispose()
      driver.current = null
    }
    // The driver lives as long as the overlay; `onReady` is intentionally not a dependency.
  }, [])

  useEffect(() => {
    if (count > seen.current) driver.current?.hit(undefined, deadline)
    seen.current = count
  }, [count, deadline])

  return <div ref={overlay} class={styles.flash} aria-hidden="true" data-testid="wrong-note-flash" />
}
