/**
 * Is this a phone-size screen (DECISIONS U74)? Narrow in portrait, or short in landscape: an
 * iPhone either way up, never a tablet. Size decides, not the user agent, so a small desktop
 * window gets the same compact layout. Updates on rotation and resize. `usePhoneLandscape` is
 * the short-in-landscape half alone (U80): the layout with the least height to give.
 */
import { useEffect, useState } from 'preact/hooks'

export const PHONE_LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 520px)'
export const PHONE_QUERY = `(max-width: 520px), ${PHONE_LANDSCAPE_QUERY}`

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : false))
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined
    const mq = matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [query])
  return matches
}

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY)
}

/** A phone on its side: landscape and at most 520 px tall. */
export function usePhoneLandscape(): boolean {
  return useMediaQuery(PHONE_LANDSCAPE_QUERY)
}
