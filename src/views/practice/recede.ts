/**
 * While practice or Listen plays, the header and footer tools collapse out of view, while
 * hand toggles and the Repeat panel recede (DECISIONS U13/U60). The overview and playback
 * button stay visible. Chrome returns when playing stops
 * (pause, interruption, end), and for a few seconds after a pointer moves over or touches it,
 * or while keyboard focus or an open tool dialog is inside it. CSS uses `data-recede` and
 * motion tokens, shortening transitions with reduced motion. Score feedback never recedes.
 *
 * Timers only: nothing here runs on MIDI input.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { TimerApi } from '../../core/playback'

/** Delay after playing starts, so the control just pressed does not vanish under the finger. */
export const RECEDE_DELAY_MS = 1200
/** How long chrome stays back after the last pointer activity on it. */
export const REVEAL_MS = 3000

/** Event handlers for a chrome region: pointer activity reveals it, keyboard focus inside keeps it. */
export interface RecedeZone {
  readonly onPointerDown: () => void
  readonly onPointerMove: () => void
  readonly onFocusIn: (event: FocusEvent) => void
  readonly onFocusOut: () => void
}

/** Keyboard focus or an open tool dialog keeps the controls available while they are in use. */
function holdsChromeFocus(target: EventTarget | null): boolean {
  try {
    return target instanceof Element && (target.matches(':focus-visible') || !!target.closest('[role="dialog"]'))
  } catch {
    return false
  }
}

export interface Recede {
  readonly receded: boolean
  readonly zone: RecedeZone
}

export function useRecede(active: boolean, timers: TimerApi): Recede {
  const [receded, setReceded] = useState(false)
  const timer = useRef<unknown>(null)
  const focused = useRef(false)
  const live = useRef(active)
  live.current = active

  const clear = () => {
    if (timer.current !== null) timers.clearTimeout(timer.current)
    timer.current = null
  }
  const later = (ms: number) => {
    clear()
    if (!live.current || focused.current) return
    timer.current = timers.setTimeout(() => {
      timer.current = null
      if (live.current && !focused.current) setReceded(true)
    }, ms)
  }

  useEffect(() => {
    if (active) later(RECEDE_DELAY_MS)
    else {
      clear()
      setReceded(false)
    }
    return clear
  }, [active])

  const reveal = () => {
    if (!live.current) return
    setReceded(false)
    later(REVEAL_MS)
  }

  useEffect(() => {
    if (!active) return
    // Safari does not focus a button on a pointer click, so Tab can arrive on the document
    // rather than inside the screen. Reveal before keyboard navigation reaches hidden rows.
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') reveal()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [active])

  return {
    receded,
    zone: {
      onPointerDown: reveal,
      onPointerMove: reveal,
      onFocusIn: (event) => {
        if (!holdsChromeFocus(event.target)) return
        focused.current = true
        clear()
        setReceded(false)
      },
      onFocusOut: () => {
        if (!focused.current) return
        focused.current = false
        later(REVEAL_MS)
      },
    },
  }
}
