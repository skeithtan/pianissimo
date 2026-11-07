/**
 * Is this a phone-size screen (DECISIONS U74)? Narrow in portrait, or short in landscape: an
 * iPhone either way up, never a tablet. Size decides, not the user agent, so a small desktop
 * window gets the same compact layout. Updates on rotation and resize.
 */
import { useEffect, useState } from 'preact/hooks'

export const PHONE_QUERY = '(max-width: 520px), (orientation: landscape) and (max-height: 520px)'

const query = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null)

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const mq = query()
    if (!mq) return undefined
    const update = () => setPhone(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])
  return phone
}
