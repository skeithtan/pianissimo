/**
 * A button that opens the system file picker. It is a `<label>` around a visually hidden file
 * input, so the picker opens from the user's own tap (works inside modal sheets and on iPad,
 * where programmatic clicks on detached inputs are unreliable).
 */
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import { Icon, type IconName } from '../../ui/icons'
import controls from '../../ui/controls.module.css'
import styles from './library.module.css'

/** Extensions and types offered by the picker (content is sniffed anyway, spec "Supported file formats"). */
export const SCORE_ACCEPT =
  '.musicxml,.mxl,.xml,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml,application/xml,text/xml'
export const BACKUP_ACCEPT = '.zip,application/zip'

export function FileButton({
  children,
  icon,
  variant = 'secondary',
  accept,
  disabled,
  onFile,
  label,
}: {
  children: ComponentChildren
  icon?: IconName
  variant?: 'primary' | 'secondary' | 'ghost'
  /** Omit to accept any file (see `LibraryDeps.isAppleMobile`). */
  accept?: string | undefined
  disabled?: boolean
  onFile: (file: File) => void
  /** Accessible name when the visible text is not enough. */
  label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <label
      class={[controls.button, controls[variant], styles.fileButton].join(' ')}
      aria-disabled={disabled ? 'true' : undefined}
    >
      <input
        ref={input}
        type="file"
        class={styles.fileInput}
        accept={accept}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const el = e.currentTarget as HTMLInputElement
          const file = el.files?.[0]
          // Reset so picking the same file again still fires a change.
          el.value = ''
          if (file) onFile(file)
        }}
      />
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </label>
  )
}
