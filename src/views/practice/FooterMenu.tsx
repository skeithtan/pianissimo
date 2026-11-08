/**
 * The Practice footer menu (DECISIONS U76): one Menu button in the bottom-left corner, before the
 * always-visible Speed control, that opens an anchored popover (never a modal sheet) holding Note
 * names, Play through, Keep time (rhythm mode, P13; exclusive with Play through, the session
 * switches the other off) and Show keys. While Keep time is on the Menu button carries a small
 * metronome badge, so the mode shows with the menu closed. The popover opens upward, stays on screen (`placePopover`)
 * and fades. It
 * closes on Escape, a press outside it, the Menu button again, when playback starts and when the
 * chrome recedes. Focus moves into the panel on open and back to the button on close.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { PracticeSession, SessionUi } from '../../app/session'
import type { PersistentLabelMode } from '../../core/model/settings'
import { Segmented, Toggle } from '../../ui/controls'
import { useFadePresence } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { usePopoverPlacement } from '../../ui/usePopoverPlacement'
import menuStyles from './FooterMenu.module.css'
import styles from './practice.module.css'

const LABEL_OPTIONS = [
  { value: 'off', label: 'Off', title: 'No persistent note names' },
  { value: 'conditional', label: 'Conditional', title: 'Name notes outside your chosen range' },
  { value: 'all', label: 'All', title: 'Name every note' },
] as const

export interface FooterMenuProps {
  readonly ui: SessionUi
  readonly session: PracticeSession
  readonly receded: boolean
  readonly labels: PersistentLabelMode
  readonly onLabels: (mode: PersistentLabelMode) => void
  /** The score (or the piece) has a numerical tempo: Keep time needs one. */
  readonly hasTempo: boolean
}

/**
 * The menu's rows: Note names, Play through, Keep time and (unless `showKeys` is false: a phone
 * on its side has no keyboard guide, U80) Show keys. The footer popover and the phone's menu
 * sheet (`PracticeScreen`, U80) share them; the classes come from the host.
 */
export function PracticeMenuItems({
  ui,
  session,
  labels,
  onLabels,
  hasTempo,
  showKeys = true,
  rowClass,
  labelClass,
  toggleClass,
}: Pick<FooterMenuProps, 'ui' | 'session' | 'labels' | 'onLabels' | 'hasTempo'> & {
  readonly showKeys?: boolean
  readonly rowClass: string | undefined
  readonly labelClass: string | undefined
  readonly toggleClass: string | undefined
}) {
  const toggleRow = [rowClass, toggleClass].filter(Boolean).join(' ')
  return (
    <>
      <div class={rowClass}>
        <span class={labelClass} aria-hidden="true">
          Note names
        </span>
        <Segmented<PersistentLabelMode>
          label="Note names on the score"
          value={labels}
          options={LABEL_OPTIONS}
          onChange={onLabels}
          compact
        />
      </div>
      <Toggle
        class={toggleRow}
        label="Play through"
        checked={ui.playThrough}
        disabled={!ui.handsAvailable || ui.hands === 'none'}
        onChange={(on) => session.setPlayThrough(on)}
      />
      <Toggle
        class={toggleRow}
        label="Keep time"
        checked={ui.rhythm}
        disabled={!ui.handsAvailable || ui.hands === 'none' || !hasTempo}
        onChange={(on) => session.setRhythmMode(on)}
      />
      {showKeys ? (
        <Toggle
          class={toggleRow}
          label="Show keys"
          checked={ui.keyboardVisible}
          onChange={(on) => session.setKeyboardVisible(on)}
        />
      ) : null}
    </>
  )
}

export function FooterMenu({ ui, session, receded, labels, onLabels, hasTempo }: FooterMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const popover = useFadePresence(open, 160)
  const fit = usePopoverPlacement(popover.mounted, 'up', root, panel)
  const side = fit?.side ?? 'up'

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  useEffect(() => {
    if (ui.playing || receded) setOpen(false)
  }, [ui.playing, receded])

  // Focus into the panel on open; back to the button when it closes with focus inside.
  useEffect(() => {
    if (open) {
      if (popover.phase === 'entering') panel.current?.focus()
      return
    }
    if (panel.current?.contains(document.activeElement)) button.current?.focus()
  }, [open, popover.phase])

  return (
    <div
      class={menuStyles.root}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          button.current?.focus()
        }
      }}
    >
      <button
        ref={button}
        type="button"
        class={`${styles.tool} ${menuStyles.menuButton}`}
        aria-label="Menu"
        title="Menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="menu" size={24} />
        {ui.rhythm ? (
          <span class={menuStyles.badge} data-testid="keep-time-badge" aria-hidden="true">
            <Icon name="metronome" size={14} />
          </span>
        ) : null}
      </button>
      {popover.mounted ? (
        <div
          ref={panel}
          class={`${menuStyles.popover} ${side === 'up' ? menuStyles.up : ''}`}
          role="dialog"
          aria-label="Practice menu"
          tabIndex={-1}
          data-side={side}
          style={{
            ...popover.style,
            ...(fit ? { left: `${fit.left}px` } : {}),
            ...(fit?.maxHeight != null ? { maxHeight: `${fit.maxHeight}px`, overflowY: 'auto' } : {}),
          }}
        >
          <PracticeMenuItems
            ui={ui}
            session={session}
            labels={labels}
            onLabels={onLabels}
            hasTempo={hasTempo}
            rowClass={menuStyles.row}
            labelClass={menuStyles.label}
            toggleClass={menuStyles.toggle}
          />
        </div>
      ) : null}
    </div>
  )
}
