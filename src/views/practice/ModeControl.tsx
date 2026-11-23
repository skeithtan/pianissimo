import { msg } from '../../i18n/messages'
/**
 * The mode of the score screen (DECISIONS U141): Listen, Wait, Keep time or Follow. A tablet's or
 * desktop's header shows all four (`ModeChoice`). Where they do not fit (`useModeFit`) and on a
 * phone on its side one button names the mode (`ModeButton`), and an upright phone's title is that
 * button (`ModeTitle`). Both open `ModeSheet`, a floating, untitled sheet like the phone menus
 * (U81, U82), where each mode has its description. Choosing one closes it and starts nothing.
 */
import type { PracticeMode } from '../../core/model/practice'
import { Segmented, Sheet } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { MODES, modeDescription, modeLabel } from '../shared/modes'
import styles from './ModeControl.module.css'

interface ModeProps {
  readonly mode: PracticeMode
  readonly onMode: (mode: PracticeMode) => void
}

/** All four modes, each titled by its description. */
export function ModeChoice({ mode, onMode }: ModeProps) {
  return (
    <Segmented<PracticeMode>
      label={msg('Mode')}
      value={mode}
      options={MODES.map((value) => ({ value, label: modeLabel(value), title: modeDescription(value) }))}
      onChange={onMode}
      compact
    />
  )
}

interface ModeButtonProps {
  readonly mode: PracticeMode
  readonly open: boolean
  readonly onOpen: () => void
}

function openerProps({ mode, open, onOpen }: ModeButtonProps) {
  return {
    type: 'button' as const,
    'aria-label': msg('Mode: {0}. Change', modeLabel(mode)),
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': open,
    onClick: onOpen,
  }
}

/** The mode with a chevron, in the room of one button. */
export function ModeButton({ class: extra, ...p }: ModeButtonProps & { readonly class?: string | undefined }) {
  return (
    <button
      {...openerProps(p)}
      class={[styles.button, extra].filter(Boolean).join(' ')}
      title={modeDescription(p.mode)}
    >
      <span class={styles.name}>{modeLabel(p.mode)}</span>
      <Icon name="down" size={14} />
    </button>
  )
}

/** An upright phone's title block: the title, and the mode where the composer would be. */
export function ModeTitle({
  title,
  class: extra,
  ...p
}: ModeButtonProps & { readonly title: string; readonly class?: string | undefined }) {
  return (
    <button {...openerProps(p)} class={[styles.titleButton, extra].filter(Boolean).join(' ')}>
      <span class={styles.title}>{title}</span>
      <span class={styles.titleMode}>
        <span class={styles.name}>{modeLabel(p.mode)}</span>
        <Icon name="down" size={12} />
      </span>
    </button>
  )
}

/** The four modes as radio rows. Arrow keys move the focus, and a choice closes the sheet. */
export function ModeSheet({ mode, onMode, open, onClose }: ModeProps & { open: boolean; onClose: () => void }) {
  const move = (event: KeyboardEvent, from: number) => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const rows = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')
    rows?.[(from + step + MODES.length) % MODES.length]?.focus()
  }
  return (
    <Sheet title={msg('Mode')} untitled floating open={open} onClose={onClose}>
      <div class={styles.rows} role="radiogroup" aria-label={msg('Mode')}>
        {MODES.map((value, i) => (
          <button
            key={value}
            type="button"
            role="radio"
            class={styles.row}
            aria-checked={value === mode}
            aria-label={modeLabel(value)}
            aria-describedby={`mode-${value}`}
            tabIndex={value === mode ? 0 : -1}
            onClick={() => {
              onMode(value)
              onClose()
            }}
            onKeyDown={(event) => move(event, i)}
          >
            <span class={styles.rowText}>
              <span>{modeLabel(value)}</span>
              <small id={`mode-${value}`}>{modeDescription(value)}</small>
            </span>
            <span class={styles.mark} aria-hidden="true" />
          </button>
        ))}
      </div>
    </Sheet>
  )
}
