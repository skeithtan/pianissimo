/**
 * The practice footer (DECISIONS U4, U9, U12, U17): Speed on the start side, the hand
 * toggles around the large Start / Pause / Listen button in the middle, the Labels control,
 * Play through (DECISIONS P12) and Show keys on the end side. Large touch targets, icon + text, within thumb reach of
 * a piano bench. In portrait focus mode the tools slide down and their narrow-screen row
 * collapses. Landscape tools stay in place and dim. The hand/play row stays available (U60).
 */
import type { PracticeSession, SessionUi } from '../../app/session'
import { pushNotice } from '../../app/state'
import type { PersistentLabelMode } from '../../core/model/settings'
import { rat, type Rational } from '../../core/music/rational'
import { Segmented } from '../../ui/controls'
import { HandToggles } from '../../ui/HandToggles'
import { Icon, type IconName } from '../../ui/icons'
import { TempoControl } from '../../ui/TempoControl'
import type { RecedeZone } from './recede'
import styles from './practice.module.css'

const LABEL_OPTIONS = [
  { value: 'off', label: 'Off', title: 'No persistent note names' },
  { value: 'conditional', label: 'Conditional', title: 'Name notes outside your chosen range' },
  { value: 'all', label: 'All', title: 'Name every note' },
] as const

const QUARTER = rat(1, 4)

/** The hand toggles without a connected piano (U27): the tooltip, and the toast a tap shows. */
export const HANDS_UNAVAILABLE = 'Piano not connected'
export const HANDS_UNAVAILABLE_NOTICE =
  'Piano not connected. Connect a piano to play a hand yourself. Until then Pianissimo plays the piece for you.'

/** Icon-only footer tool (U18): the name is the accessible label and the tooltip. */
function Tool({
  icon,
  label,
  pressed,
  disabled,
  onClick,
}: {
  icon: IconName
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class={styles.tool}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={24} />
    </button>
  )
}

export interface FooterProps {
  readonly ui: SessionUi
  readonly session: PracticeSession
  readonly zone: RecedeZone
  readonly receded?: boolean
  readonly playLabel: string
  /** Source tempo at the passage start; null when the score has none. */
  readonly tempo: { readonly beatBpm: number; readonly beatUnit: Rational } | null
  readonly labels: PersistentLabelMode
  readonly onLabels: (mode: PersistentLabelMode) => void
  readonly onRequestTempo: () => void
}

export function Footer({
  ui,
  session,
  zone,
  receded = false,
  playLabel,
  tempo,
  labels,
  onLabels,
  onRequestTempo,
}: FooterProps) {
  return (
    <footer class={styles.footer} {...zone}>
      <div class={styles.footerToolsSlot} data-testid="footer-tools-slot" inert={receded}>
        <div class={styles.footerToolsClip}>
          <div class={styles.footerTools}>
            <div class={styles.footerSide}>
              <TempoControl
                multiplier={ui.multiplier}
                sourceBeatBpm={tempo?.beatBpm ?? 0}
                beatUnit={tempo?.beatUnit ?? QUARTER}
                onChange={(multiplier) => session.setSelection({ multiplier })}
                noTempo={tempo === null}
                onRequestTempo={onRequestTempo}
                placement="up"
              />
            </div>
            <div class={`${styles.footerSide} ${styles.footerEnd}`}>
              <div class={styles.labels}>
                <Segmented<PersistentLabelMode>
                  label="Note names on the score"
                  value={labels}
                  options={LABEL_OPTIONS}
                  onChange={onLabels}
                  compact
                />
                <span class={styles.toolCaption} aria-hidden="true">
                  Note names
                </span>
              </div>
              <Tool
                icon="flow"
                label="Play through"
                pressed={ui.playThrough}
                disabled={!ui.handsAvailable || ui.hands === 'none'}
                onClick={() => session.setPlayThrough(!ui.playThrough)}
              />
              <Tool
                icon="keys"
                label={ui.keyboardVisible ? 'Hide keys' : 'Show keys'}
                pressed={ui.keyboardVisible}
                onClick={() => session.setKeyboardVisible(!ui.keyboardVisible)}
              />
            </div>
          </div>
        </div>
      </div>
      <div class={styles.footerCenter}>
        <HandToggles
          hands={ui.hands}
          onHandsChange={(hands) => session.setSelection({ hands })}
          handsUnavailable={ui.handsAvailable ? undefined : HANDS_UNAVAILABLE}
          onHandsUnavailable={() => pushNotice({ kind: 'info', text: HANDS_UNAVAILABLE_NOTICE })}
          playing={ui.playing}
          onPlayPause={() => session.togglePlay()}
          playLabel={playLabel}
          playDisabled={!ui.playing && !ui.startEnabled && ui.activity !== 'listening'}
          handClass={styles.recedes}
        />
        {!ui.playing && ui.startReason ? (
          <p class={styles.startReason} role="note">
            {ui.startReason}
          </p>
        ) : null}
      </div>
    </footer>
  )
}
