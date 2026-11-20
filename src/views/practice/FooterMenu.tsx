/**
 * The Practice footer menu (DECISIONS U76): one Menu button at the footer's end edge (U88), across
 * from the always-visible Speed control, that opens an anchored popover (never a modal sheet) holding Note
 * names, Keep time (rhythm mode, P13), Metronome (U87, P20) and Show keys. While Keep time is on the Menu button carries a small
 * metronome badge, so the mode shows with the menu closed. The popover opens upward, stays on screen (`placePopover`)
 * and fades. It
 * closes on Escape, a press outside it, the Menu button again, when playback starts and when the
 * chrome recedes. Focus moves into the panel on open and back to the button on close.
 *
 * `FooterMenuPopover` is that button and popover with any rows: Practice's `FooterMenu` fills it
 * with `PracticeMenuItems`, Study's footer (DECISIONS U90) with Note names, Metronome and Show keys.
 * Study's never closes on its own when playback starts (its chrome never recedes, U72).
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { PracticeSession, SessionUi } from '../../app/session'
import type { PersistentLabelMode } from '../../core/model/settings'
import { Segmented, Toggle } from '../../ui/controls'
import { useFadePresence } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { usePopoverPlacement } from '../../ui/usePopoverPlacement'
import menuStyles from './FooterMenu.module.css'
import styles from './practice.module.css'

/** The Note names choices (Practice and Study menus). */
export const LABEL_OPTIONS = [
  { value: 'off', label: 'Off', title: 'No persistent note names' },
  { value: 'conditional', label: 'Conditional', title: 'Name notes outside your chosen range' },
  { value: 'all', label: 'All', title: 'Name every note' },
] as const

const KEEP_TIME_DESCRIPTION = 'After a count-in, the score keeps moving at the set tempo, even if you miss notes.'

/** The Metronome row's state, computed once by the screen (DECISIONS U87, P20). */
export interface MetronomeRow {
  readonly on: boolean
  readonly disabled: boolean
  /** Shown under the label (the microphone is following), else absent. */
  readonly note?: string
}

export interface FooterMenuProps {
  readonly ui: SessionUi
  readonly session: PracticeSession
  readonly receded: boolean
  readonly labels: PersistentLabelMode
  readonly onLabels: (mode: PersistentLabelMode) => void
  /** The score (or the piece) has a numerical tempo: Keep time needs one. */
  readonly hasTempo: boolean
  readonly metronome: MetronomeRow
  /** Turns the click on or off for the current mode (the screen primes audio, then edits the settings). */
  readonly onMetronome: (on: boolean) => void
}

/**
 * Marks the controls on the way to a label switch (the Menu buttons, the Note names row): input on
 * them does not cancel the run prepared ahead, so the switch can adopt it (`PracticeScreen`).
 */
export const KEEPS_AHEAD = 'data-keeps-ahead'

/**
 * The menu's rows: Note names, Keep time, Metronome and (unless `showKeys` is false: a phone
 * on its side has no keyboard guide, U80) Show keys. The footer popover and the phone's menu
 * sheet (`PracticeScreen`, U80) share them; the classes come from the host.
 */
export function PracticeMenuItems({
  ui,
  session,
  labels,
  onLabels,
  hasTempo,
  metronome,
  onMetronome,
  showKeys = true,
  rowClass,
  labelClass,
  toggleClass,
}: Pick<FooterMenuProps, 'ui' | 'session' | 'labels' | 'onLabels' | 'hasTempo' | 'metronome' | 'onMetronome'> & {
  readonly showKeys?: boolean
  readonly rowClass: string | undefined
  readonly labelClass: string | undefined
  readonly toggleClass: string | undefined
}) {
  const toggleRow = [rowClass, toggleClass].filter(Boolean).join(' ')
  return (
    <>
      <div class={rowClass} data-keeps-ahead>
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
        label="Keep time"
        checked={ui.rhythm}
        disabled={!ui.handsAvailable || ui.hands === 'none' || !hasTempo || !ui.pianoConnected}
        description={ui.pianoConnected ? KEEP_TIME_DESCRIPTION : `${KEEP_TIME_DESCRIPTION} Needs a connected piano.`}
        onChange={(on) => session.setRhythmMode(on)}
      />
      <Toggle
        class={toggleRow}
        label="Metronome"
        checked={metronome.on}
        disabled={metronome.disabled}
        {...(metronome.note ? { description: metronome.note } : {})}
        onChange={onMetronome}
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

export interface FooterMenuPopoverProps {
  /** The popover's accessible name ("Practice menu", "Study menu"). */
  readonly label: string
  /** Forces the menu shut (and keeps it so) while true: Practice playing or receded. */
  readonly closed?: boolean
  /** Shown on the Menu button's corner (Practice: the Keep time metronome). */
  readonly badge?: ComponentChildren
  /** The rows (built with `footerMenuClasses`). */
  readonly children: ComponentChildren
}

/** The popover's row classes, for the hosts' rows (`row`, `label`, `toggle`). */
export const footerMenuClasses = { row: menuStyles.row, label: menuStyles.label, toggle: menuStyles.toggle } as const

/** The footer's Menu button and its anchored popover (U76), whatever rows it holds. */
export function FooterMenuPopover({ label, closed = false, badge, children }: FooterMenuPopoverProps) {
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
    if (closed) setOpen(false)
  }, [closed])

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
        data-keeps-ahead
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="menu" size={24} />
        {badge}
      </button>
      {popover.mounted ? (
        <div
          ref={panel}
          class={`${menuStyles.popover} ${side === 'up' ? menuStyles.up : ''}`}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          data-side={side}
          style={{
            ...popover.style,
            ...(fit ? { left: `${fit.left}px` } : {}),
            ...(fit?.maxHeight != null ? { maxHeight: `${fit.maxHeight}px`, overflowY: 'auto' } : {}),
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function FooterMenu({
  ui,
  session,
  receded,
  labels,
  onLabels,
  hasTempo,
  metronome,
  onMetronome,
}: FooterMenuProps) {
  return (
    <FooterMenuPopover
      label="Practice menu"
      closed={ui.playing || receded}
      badge={
        ui.rhythm ? (
          <span class={menuStyles.badge} data-testid="keep-time-badge" aria-hidden="true">
            <Icon name="metronome" size={14} />
          </span>
        ) : null
      }
    >
      <PracticeMenuItems
        ui={ui}
        session={session}
        labels={labels}
        onLabels={onLabels}
        hasTempo={hasTempo}
        metronome={metronome}
        onMetronome={onMetronome}
        rowClass={menuStyles.row}
        labelClass={menuStyles.label}
        toggleClass={menuStyles.toggle}
      />
    </FooterMenuPopover>
  )
}
