import { msg, percentage } from '../../i18n/messages'
/**
 * The Practice footer menu (DECISIONS U76, U141): one Menu button at the footer's end edge (U88),
 * across from the always-visible Speed control, that opens an anchored popover (never a modal sheet)
 * holding the mode's rows. The popover opens upward, stays on screen (`placePopover`) and fades. It
 * closes on Escape, a press outside it, the Menu button again, when playback starts and when the
 * chrome recedes; in Listen, whose chrome never recedes, it stays open while the piece plays. Focus
 * moves into the panel on open and back to the button on close.
 *
 * `PracticeMenuItems` are the rows, in the popover and in a phone's menu sheet: Note names; Playback
 * (Keep time); Metronome; Show keys; Progress; Record performance.
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { PracticeSession, SessionUi } from '../../app/session'
import type { PersistentLabelMode } from '../../core/model/settings'
import { Button, Segmented, Slider, Toggle } from '../../ui/controls'
import { useFadePresence } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { usePopoverPlacement } from '../../ui/usePopoverPlacement'
import menuStyles from './FooterMenu.module.css'
import styles from './practice.module.css'

/** The Note names choices. */
const LABEL_OPTIONS = [
  { value: 'off', label: 'Off', title: 'No note names on the score' },
  { value: 'conditional', label: 'Conditional', title: 'Name notes outside your chosen range' },
  { value: 'all', label: 'All', title: 'Name every note' },
] as const

/** The Metronome row's state, computed once by the screen (DECISIONS U87, P20). */
export interface MetronomeRow {
  readonly on: boolean
  readonly disabled: boolean
  /** Shown under the label (the microphone is following), else absent. */
  readonly note?: string
}

export interface FooterMenuProps {
  readonly onProgress?: (() => void) | undefined
  readonly onRecord?: (() => void) | undefined
  /** The recorder has the learner's attention: the menu closes. */
  readonly recordingOpen?: boolean | undefined
  /** A take is opening, recording or saving. */
  readonly recordDisabled?: boolean | undefined
  readonly ui: SessionUi
  readonly session: PracticeSession
  readonly receded: boolean
  readonly labels: PersistentLabelMode
  readonly onLabels: (mode: PersistentLabelMode) => void
  /** Opens the Note names rules, offered in Conditional. */
  readonly onNoteRules: () => void
  /** The score (or the piece) has a numerical tempo: Playback needs one. */
  readonly hasTempo: boolean
  readonly scorePlayback: {
    readonly on: boolean
    readonly volume: number
    readonly onToggle: (on: boolean) => void
    readonly onVolume: (volume: number) => void
  }
  readonly metronome: MetronomeRow
  /** Turns the click on or off for the current mode (the screen primes audio, then edits the settings). */
  readonly onMetronome: (on: boolean) => void
}

/**
 * Marks the controls on the way to a label switch (the Menu buttons, the Note names row): input on
 * them does not cancel the run prepared ahead, so the switch can adopt it (`PracticeScreen`).
 */
export const KEEPS_AHEAD = 'data-keeps-ahead'

function MenuReveal({ open, children }: { readonly open: boolean; readonly children: ComponentChildren }) {
  return (
    <div class={menuStyles.revealSlot} data-open={open} inert={!open} aria-hidden={open ? undefined : true}>
      <div class={menuStyles.revealClip}>{children}</div>
    </div>
  )
}

/**
 * The footer popover and phone sheet share these rows and supply their own classes. The phone
 * sheet hides Show keys in landscape, where there is no keyboard guide (U80).
 */
export function PracticeMenuItems({
  onProgress,
  onRecord,
  recordDisabled,
  ui,
  session,
  labels,
  onLabels,
  onNoteRules,
  hasTempo,
  scorePlayback,
  metronome,
  onMetronome,
  showKeys = true,
  rowClass,
  labelClass,
  toggleClass,
}: Pick<
  FooterMenuProps,
  'ui' | 'session' | 'labels' | 'onLabels' | 'onNoteRules' | 'hasTempo' | 'scorePlayback' | 'metronome' | 'onMetronome'
> & {
  readonly onProgress?: (() => void) | undefined
  readonly onRecord?: (() => void) | undefined
  readonly recordDisabled?: boolean | undefined
  readonly showKeys?: boolean
  readonly rowClass: string | undefined
  readonly labelClass: string | undefined
  readonly toggleClass: string | undefined
}) {
  const toggleRow = [rowClass, toggleClass].filter(Boolean).join(' ')
  const showScorePlayback = ui.mode === 'time' && ui.pianoConnected && hasTempo
  return (
    <>
      <div class={menuStyles.group}>
        <div class={rowClass} data-keeps-ahead>
          <span class={labelClass} aria-hidden="true">
            {msg('Note names')}
          </span>
          <Segmented<PersistentLabelMode>
            label={msg('Note names on the score')}
            value={labels}
            options={LABEL_OPTIONS.map((o) => ({ ...o, label: msg(o.label), title: msg(o.title) }))}
            onChange={onLabels}
            compact
          />
        </div>
        <MenuReveal open={labels === 'conditional'}>
          <button type="button" class={menuStyles.link} onClick={onNoteRules}>
            {msg('Choose which notes')}
          </button>
        </MenuReveal>
      </div>
      {showScorePlayback ? (
        <div class={menuStyles.group}>
          <Toggle
            class={toggleRow}
            label={msg('Playback')}
            description={msg('Hear both hands while you play.')}
            checked={scorePlayback.on}
            onChange={scorePlayback.onToggle}
          />
          <MenuReveal open={scorePlayback.on}>
            <div class={menuStyles.scorePlaybackVolume}>
              <Slider
                label={msg('Playback volume')}
                value={Math.round(scorePlayback.volume * 100)}
                min={0}
                max={100}
                step={1}
                format={(value) => percentage(value / 100)}
                onChange={(value) => scorePlayback.onVolume(value / 100)}
              />
            </div>
          </MenuReveal>
        </div>
      ) : null}
      <Toggle
        class={toggleRow}
        label={msg('Metronome')}
        checked={metronome.on}
        disabled={metronome.disabled}
        {...(metronome.note ? { description: metronome.note } : {})}
        onChange={onMetronome}
      />
      {showKeys ? (
        <Toggle
          class={toggleRow}
          label={msg('Show keys')}
          checked={ui.keyboardVisible}
          onChange={(on) => session.setKeyboardVisible(on)}
        />
      ) : null}
      {onProgress && (
        <Button icon="chart" onClick={onProgress}>
          {msg('Progress')}
        </Button>
      )}
      {onRecord && (
        <Button icon="record" disabled={recordDisabled} onClick={onRecord}>
          {msg('Record performance')}
        </Button>
      )}
    </>
  )
}

export function FooterMenu({ ui, receded, recordingOpen, onNoteRules, onProgress, ...items }: FooterMenuProps) {
  // Closes when playback starts (Listen's does not recede and stays), the chrome recedes or the
  // recorder opens. It can be opened again while that lasts, as Playback changes live.
  const closed = (ui.playing && ui.mode !== 'listen') || receded || !!recordingOpen
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
        aria-label={msg('Menu')}
        title={msg('Menu')}
        data-keeps-ahead
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="menu" size={24} />
      </button>
      {popover.mounted ? (
        <div
          ref={panel}
          class={`${menuStyles.popover} ${side === 'up' ? menuStyles.up : ''}`}
          role="dialog"
          aria-label={msg('Practice menu')}
          tabIndex={-1}
          data-side={side}
          style={{
            ...popover.style,
            ...(fit ? { left: `${fit.left}px` } : {}),
            ...(fit?.maxHeight != null ? { maxHeight: `${fit.maxHeight}px`, overflowY: 'auto' } : {}),
          }}
        >
          <PracticeMenuItems
            {...items}
            onProgress={
              onProgress &&
              (() => {
                // Focus returns to this button when the sheet closes.
                setOpen(false)
                button.current?.focus()
                onProgress()
              })
            }
            ui={ui}
            onNoteRules={() => {
              // Settings returns the focus to what had it: the button, not a menu that is going.
              setOpen(false)
              button.current?.focus()
              onNoteRules()
            }}
            rowClass={menuStyles.row}
            labelClass={menuStyles.label}
            toggleClass={menuStyles.toggle}
          />
        </div>
      ) : null}
    </div>
  )
}
