/**
 * Small purpose-built controls (spec: no large component suite). Every control meets a 48 px
 * touch target so it is comfortable from a piano bench.
 */
import type { ButtonHTMLAttributes, ComponentChildren } from 'preact'
import { useEffect, useId, useRef } from 'preact/hooks'
import { useFadePresence } from './fade'
import { Icon, type IconName } from './icons'
import styles from './controls.module.css'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  children,
  icon,
  variant = 'secondary',
  pressed,
  class: className,
  ...rest
}: {
  children?: ComponentChildren
  icon?: IconName
  variant?: ButtonVariant
  pressed?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon'>) {
  return (
    <button
      type="button"
      class={[styles.button, styles[variant], className].filter(Boolean).join(' ')}
      aria-pressed={pressed === undefined ? undefined : pressed}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  )
}

export interface SegmentOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly title?: string
}

/**
 * Single-choice segmented control rendered as a radio group. Arrow keys move the choice and only
 * the selected segment is in the tab order (all of them when none is selected).
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  compact,
}: {
  label: string
  value: T | null
  options: readonly SegmentOption<T>[]
  onChange: (v: T) => void
  compact?: boolean
}) {
  const selected = options.findIndex((o) => o.value === value)
  const move = (event: KeyboardEvent, from: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const target = options[(from + step + options.length) % options.length]
    if (!target) return
    onChange(target.value)
    const buttons = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')
    buttons?.[options.indexOf(target)]?.focus()
  }
  return (
    <div class={[styles.segmented, compact ? styles.compact : ''].join(' ')} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === (selected < 0 ? 0 : selected) ? 0 : -1}
          title={o.title}
          class={styles.segment}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  description,
  disabled,
  class: className,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  description?: string
  disabled?: boolean
  class?: string
}) {
  return (
    <label
      class={[styles.toggleRow, className].filter(Boolean).join(' ')}
      data-disabled={disabled ? 'true' : undefined}
    >
      <span class={styles.toggleText}>
        <span>{label}</span>
        {description ? <small>{description}</small> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        class={styles.toggle}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
      />
    </label>
  )
}

export function Field({
  label,
  children,
  hint,
  error,
}: {
  label: string
  children: ComponentChildren
  hint?: string
  error?: string | null
}) {
  return (
    <label class={styles.field}>
      <span class={styles.fieldLabel}>{label}</span>
      {children}
      {error ? (
        <span class={styles.fieldError} role="alert">
          {error}
        </span>
      ) : hint ? (
        <small>{hint}</small>
      ) : null}
    </label>
  )
}

/** Range input with a visible label and live value, sized for a finger. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div class={styles.slider}>
      <div class={styles.sliderHead}>
        <label for={id}>{label}</label>
        <output for={id}>{format ? format(value) : String(value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onInput={(e) => onChange(Number((e.currentTarget as HTMLInputElement).value))}
      />
    </div>
  )
}

/**
 * Modal sheet over the current view; the view stays mounted underneath so nothing is lost.
 * Escape and the close button call `onClose`, which may fire twice (once for the user's action,
 * once for the dialog's own close event after it closes), so it must be idempotent. The sheet
 * fades in and out, and focus returns to whatever opened it.
 */
export function Sheet({
  title,
  open,
  onClose,
  children,
  wide,
  tall,
  flush,
}: {
  title: string
  open: boolean
  onClose: () => void
  children: ComponentChildren
  wide?: boolean
  /** Fill the viewport height (Settings), instead of sizing to content. */
  tall?: boolean
  /** No body padding or scrolling: the content lays itself out (tabs with a scrolling pane). */
  flush?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  const presence = useFadePresence(open, 200)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (presence.mounted && !d.open) {
      opener.current = document.activeElement
      d.showModal()
    }
    if (!presence.mounted && d.open) {
      d.close()
      const previous = opener.current
      opener.current = null
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [presence.mounted])
  return (
    <dialog
      ref={ref}
      class={[styles.sheet, wide ? styles.wide : '', tall ? styles.tall : ''].join(' ')}
      data-leaving={presence.phase === 'leaving' ? '' : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      aria-label={title}
    >
      <header class={styles.sheetHeader}>
        <h2>{title}</h2>
        <Button icon="close" variant="ghost" aria-label="Close" onClick={onClose} />
      </header>
      <div class={[styles.sheetBody, flush ? styles.flush : ''].join(' ')}>{presence.mounted ? children : null}</div>
    </dialog>
  )
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success'
  children: ComponentChildren
}) {
  return (
    <div class={[styles.notice, styles[`notice_${tone}`]].join(' ')} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}
