/**
 * The Practice footer menu (DECISIONS U76): one Menu button at the footer's end edge (U88), across
 * from the always-visible Speed control, that opens an anchored popover (never a modal sheet) holding Note
 * names, Play through, Keep time (rhythm mode, P13; exclusive with Play through, the session
 * switches the other off), Metronome (U87, P20) and Show keys. While Keep time is on the Menu button carries a small
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
import { updateSettings } from '../../app/state'
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

type Follow = SessionUi['follow']

/** The Follow choice (DECISIONS P22, U92): what a play-through follows. */
export function followOptions(ui: Pick<SessionUi, 'pianoConnected'>) {
  return [
    {
      value: 'piano',
      label: 'Piano',
      title: ui.pianoConnected ? 'Follow the keys of the connected piano' : 'Piano not connected',
      disabled: !ui.pianoConnected,
    },
    { value: 'mic', label: 'Microphone', title: 'Follow what this device’s microphone hears' },
  ] as const
}

/** No piano: play-through is on and locked (P22). */
export const NO_PIANO_NOTE = 'No piano connected: following the microphone.'
/** One hand through the microphone: the app plays nothing (P22). */
export const ONE_HAND_MIC_NOTE = 'The microphone follows your hand; the other hand stays silent.'

/** The line under Play through, or null (DECISIONS U92). */
export function playThroughNote(
  ui: Pick<SessionUi, 'playThrough' | 'playThroughLocked' | 'follow' | 'hands'>,
): string | null {
  if (!ui.playThrough || ui.follow !== 'mic') return null
  const oneHand = ui.hands === 'left' || ui.hands === 'right'
  if (ui.playThroughLocked) return oneHand ? `${NO_PIANO_NOTE} The other hand stays silent.` : NO_PIANO_NOTE
  return oneHand ? ONE_HAND_MIC_NOTE : null
}

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
 * The menu's rows: Note names, Play through, Follow (Piano / Microphone, DECISIONS U92: what a
 * play-through follows, `settings.mic.follow`; shown when this browser can use a microphone),
 * Keep time, Metronome and (unless `showKeys` is false: a phone
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
  const note = playThroughNote(ui)
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
        label="Play through"
        checked={ui.playThrough}
        // Without a piano a hand plays through the microphone: on, and it cannot go off (P22).
        disabled={!ui.handsAvailable || ui.hands === 'none' || ui.playThroughLocked}
        {...(note ? { description: note } : {})}
        onChange={(on) => session.setPlayThrough(on)}
      />
      {ui.micSupported ? (
        <div class={rowClass}>
          <span class={labelClass} aria-hidden="true">
            Follow
          </span>
          <Segmented<Follow>
            label="Play through follows"
            value={ui.follow}
            options={followOptions(ui)}
            onChange={(follow) => updateSettings({ mic: { follow: follow === 'mic' } })}
            compact
          />
        </div>
      ) : null}
      <Toggle
        class={toggleRow}
        label="Keep time"
        checked={ui.rhythm}
        disabled={!ui.handsAvailable || ui.hands === 'none' || !hasTempo || !ui.pianoConnected}
        {...(ui.pianoConnected ? {} : { description: 'Needs a connected piano.' })}
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
