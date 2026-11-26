import { msg } from '../i18n/messages'
/**
 * Global toast area fed by `pushNotice`. Toasts slide in and fade out before they are removed;
 * errors are announced assertively and stay until dismissed. While a sheet is open its topmost one
 * draws them, so that they are seen and can be pressed (`ui/sheetOverlay`).
 */
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { useFadeList } from '../ui/fade'
import { Icon, type IconName } from '../ui/icons'
import { fadeDuration } from '../ui/motion'
import { sheetOverlay, topSheet } from '../ui/sheetOverlay'
import { dismissNotice, notices, type AppNotice, type NoticeKind } from './state'
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
  const brief = entries.filter((e) => e.item.brief)
  const rest = entries.filter((e) => !e.item.brief)
  const briefArea = useRef<HTMLDivElement>(null)
  // The brief capsule opens on the connection status it is about (the header's chip), covering it,
  // so it never hides the mode tabs. Where the header shows no chip (the upright phone's), it drops
  // in just under the header, centered, clear of the header's play controls.
  useLayoutEffect(() => {
    const area = briefArea.current
    if (!area || brief.length === 0) return
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.bottom > 0 ? r : null
    }
    const chip = [...document.querySelectorAll('[data-connection-chip]')].map(visible).find(Boolean)
    const header = chip ? null : [...document.querySelectorAll('[data-app-header]')].map(visible).find(Boolean)
    area.dataset['anchor'] = chip ? 'chip' : header ? 'header' : 'corner'
    area.style.top = chip ? `${chip.top + chip.height / 2}px` : header ? `${header.bottom + 8}px` : ''
    area.style.right = chip ? `${Math.max(8, innerWidth - chip.right - 6)}px` : ''
    area.style.setProperty('--anchor-w', chip ? `${chip.width + 12}px` : '0px')
  }, [brief.length])
  return (
    <>
      {/* The brief capsule (the piano connecting): a glance on the connection status, gone by itself. */}
      <div ref={briefArea} class={styles.briefArea} aria-live="polite" data-testid="notice-brief">
        {brief.map(({ item, leaving }) => (
          <div
            key={item.id}
            class={styles.brief}
            data-kind={item.kind}
            data-leaving={leaving || undefined}
            role="status"
          >
            <span class={styles.chip}>
              <Icon name={item.icon ?? ICON[item.kind]} size={18} />
            </span>
            <span class={styles.briefText}>
              <span class={styles.briefTitle}>{msg(item.text)}</span>
              {item.detail ? <span class={styles.briefDetail}>{item.detail}</span> : null}
            </span>
          </div>
        ))}
      </div>
      <div class={styles.area} aria-live="polite" data-testid="notice-area">
        {rest.map(({ item, leaving }) => (
          <Toast key={item.id} item={item} leaving={leaving} duration={duration} />
        ))}
      </div>
    </>
  )
}

/** How far a toast is swiped before it goes. */
const SWIPE_PX = 56

/**
 * A toast in the brief capsule's form, with no close button: it is swiped away sideways (or, with
 * the keyboard, dismissed with Escape or Delete once focused). Its action, if any, is a round icon
 * button at its end (Undo's arrow).
 */
function Toast({ item, leaving, duration }: { item: AppNotice; leaving: boolean; duration: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; dx: number } | null>(null)
  const place = (dx: number, settle: boolean) => {
    const el = ref.current
    if (!el) return
    el.style.transition = settle ? '' : 'none'
    el.style.translate = dx ? `${dx}px 0` : ''
    el.style.opacity = dx ? String(Math.max(0, 1 - Math.abs(dx) / (SWIPE_PX * 2.5))) : ''
  }
  const end = (e: PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (Math.abs(d.dx) >= SWIPE_PX) {
      place(Math.sign(d.dx) * 320, true)
      setTimeout(() => dismissNotice(item.id), 160)
    } else place(0, true)
  }
  return (
    <div
      ref={ref}
      class={styles.toast}
      data-kind={item.kind}
      data-leaving={leaving || undefined}
      role={item.kind === 'error' ? 'alert' : 'status'}
      tabIndex={0}
      aria-keyshortcuts="Escape"
      style={{ '--fade': `${duration}ms` }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') dismissNotice(item.id)
      }}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('button')) return
        drag.current = { id: e.pointerId, x: e.clientX, dx: 0 }
        ref.current?.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        d.dx = e.clientX - d.x
        place(d.dx, false)
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span class={styles.chip}>
        <Icon name={item.icon ?? ICON[item.kind]} size={18} />
      </span>
      <span class={styles.text}>{msg(item.text)}</span>
      {item.action ? (
        <button
          type="button"
          class={styles.action}
          data-icon={item.action.icon ? '' : undefined}
          aria-label={item.action.label}
          disabled={leaving}
          onClick={item.action.run}
        >
          {item.action.icon ? <Icon name={item.action.icon} size={20} /> : item.action.label}
        </button>
      ) : null}
    </div>
  )
}
