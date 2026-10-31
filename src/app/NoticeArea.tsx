/**
 * Global toast area fed by `pushNotice`. Toasts slide in and fade out before they are removed;
 * errors are announced assertively and stay until dismissed.
 */
import { useFadeList } from '../ui/fade'
import { Icon, type IconName } from '../ui/icons'
import { fadeDuration } from '../ui/motion'
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
          <Icon name={ICON[item.kind]} size={20} />
          <span class={styles.text}>{item.text}</span>
          <button type="button" class={styles.dismiss} aria-label="Dismiss" onClick={() => dismissNotice(item.id)}>
            <Icon name="close" size={18} />
          </button>
        </div>
      ))}
    </div>
  )
}
