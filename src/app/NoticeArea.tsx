import { msg } from '../i18n/messages'
/**
 * Global toast area fed by `pushNotice`. Toasts slide in and fade out before they are removed;
 * errors are announced assertively and stay until dismissed. While a sheet is open its topmost one
 * draws them, so that they are seen and can be pressed (`ui/sheetOverlay`).
 */
import { useEffect } from 'preact/hooks'
import { useFadeList } from '../ui/fade'
import { Icon, type IconName } from '../ui/icons'
import { fadeDuration } from '../ui/motion'
import { sheetOverlay, topSheet } from '../ui/sheetOverlay'
import { dismissNotice, notices, type NoticeKind } from './state'
import styles from './NoticeArea.module.css'

const ICON: Readonly<Record<NoticeKind, IconName>> = {
  info: 'sound',
  success: 'check',
  warning: 'alert',
  error: 'alert',
}

const FADE_MS = 250

export function NoticeArea() {
  useEffect(() => {
    sheetOverlay.value = Toasts
    return () => {
      sheetOverlay.value = null
    }
  }, [])
  return topSheet.value ? null : <Toasts />
}

function Toasts() {
  const entries = useFadeList(notices.value, FADE_MS)
  const duration = fadeDuration(FADE_MS)
  return (
    <div class={styles.area} aria-live="polite" data-testid="notice-area">
      {entries.map(({ item, leaving }) => (
        <div
          key={item.id}
          class={styles.toast}
          data-kind={item.kind}
          role={item.kind === 'error' ? 'alert' : 'status'}
          style={{ opacity: leaving ? 0 : 1, transition: `opacity ${duration}ms var(--ease-standard)` }}
        >
          <Icon name={item.icon ?? ICON[item.kind]} size={20} />
          <span class={styles.text}>{msg(item.text)}</span>
          {item.action ? (
            <button type="button" class={styles.action} disabled={leaving} onClick={item.action.run}>
              {item.action.label}
            </button>
          ) : null}
          <button
            type="button"
            class={styles.dismiss}
            aria-label={msg('Dismiss')}
            onClick={() => dismissNotice(item.id)}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      ))}
    </div>
  )
}
