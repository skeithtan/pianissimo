/**
 * While practice or Listen plays, the chrome (header, overview, footer tools, Repeat panel)
 * recedes so the notes are the focus (DECISIONS U13). It returns at once when playing stops
 * (pause, interruption, end), and for a few seconds after a pointer moves over or touches it,
 * or while keyboard focus is inside it. The view fades it with CSS (`data-recede` on the screen;
 * motion tokens, so reduced motion shortens the fade); feedback over the score never recedes.
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

/** Focus reached by keyboard (a pressed button keeps focus too; that must not hold the chrome). */
function keyboardFocus(target: EventTarget | null): boolean {
  try {
    return target instanceof Element && target.matches(':focus-visible')
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

  return {
    receded,
    zone: {
      onPointerDown: reveal,
      onPointerMove: reveal,
      onFocusIn: (event) => {
        if (!keyboardFocus(event.target)) return
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
