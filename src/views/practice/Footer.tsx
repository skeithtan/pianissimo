/**
 * The practice footer (DECISIONS U4, U9, U12, U17, U76): the always-visible Speed control on the
 * start side; the hand toggles around the large Start / Pause / Listen button in the middle; the
 * Menu button on the end side (an anchored popover holding Note names, Play through (P12),
 * Keep time (P13) and Show keys). Large touch targets within thumb reach of a piano bench. In portrait focus mode the tools slide down
 * and their narrow-screen row collapses (the menu closes as they go). Landscape tools stay in
 * place and dim. The hand/play row stays available (U60).
 */
import type { PracticeSession, SessionUi } from '../../app/session'
import { pushNotice } from '../../app/state'
import type { PersistentLabelMode } from '../../core/model/settings'
import { rat, type Rational } from '../../core/music/rational'
import { HandToggles } from '../../ui/HandToggles'
import { TempoControl } from '../../ui/TempoControl'
import { FooterMenu } from './FooterMenu'
import type { RecedeZone } from './recede'
import styles from './practice.module.css'

/** The hand toggles without a connected piano (U27): the tooltip, and the toast a tap shows. */
export const HANDS_UNAVAILABLE = 'Piano not connected'
export const HANDS_UNAVAILABLE_NOTICE =
  'Piano not connected. Connect a piano to play a hand yourself. Until then Pianissimo plays the piece for you.'

const QUARTER = rat(1, 4)

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
              <FooterMenu
                ui={ui}
                session={session}
                receded={receded}
                labels={labels}
                onLabels={onLabels}
                hasTempo={tempo !== null}
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
