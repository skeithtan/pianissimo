/**
 * The practice footer (DECISIONS U4, U9, U12, U17, U76): the always-visible Speed control on the
 * start side; the hand toggles around the large Start / Pause / Listen button in the middle; the
 * Menu button on the end side (an anchored popover holding Note names, Keep time (P13), Metronome (U87) and Show keys). Large touch targets within thumb reach of a
 * piano bench. One row on every tablet, upright or on its side (U88): while playing, the tools dim
 * in place (the menu closes). Only a window too narrow for one row (640 px or less) wraps the
 * tools into their own row, which collapses in portrait focus mode (U60). The hand/play row stays
 * available.
 *
 * `FooterBar` is the footer's shell on its own (the one-row grid, the narrow-window wrap, the
 * surface): Practice's `Footer` fills it, and so does Study's (DECISIONS U90), so the two screens
 * share one footer layout rather than two copies of it.
 */
import type { ComponentChildren } from 'preact'
import type { PracticeSession, SessionUi } from '../../app/session'
import { pushNotice } from '../../app/state'
import type { PersistentLabelMode } from '../../core/model/settings'
import { rat, type Rational } from '../../core/music/rational'
import { HandToggles } from '../../ui/HandToggles'
import { TempoControl } from '../../ui/TempoControl'
import { FooterMenu, type MetronomeRow } from './FooterMenu'
import type { RecedeZone } from './recede'
import styles from './practice.module.css'

/**
 * The hand toggles without a connected piano: the tooltip and the toast a tap shows.
 */
export const HANDS_UNAVAILABLE = 'Piano not connected'
export const HANDS_UNAVAILABLE_NOTICE =
  'Connect a piano to practice a hand. Open Sheet music to follow your playing with a microphone.'

const QUARTER = rat(1, 4)

export interface FooterBarProps {
  /** The start edge (Speed). */
  readonly start: ComponentChildren
  /** The end edge (the Menu button). */
  readonly end: ComponentChildren
  /** The centered cluster around the main button, with its notes under it. */
  readonly center: ComponentChildren
  /** Practice's receding zone attributes (U13); Study never recedes and passes none. */
  readonly zone?: RecedeZone | undefined
  /** The side tools are receded: they take no input. */
  readonly receded?: boolean
}

/** The footer's layout: start and end tools around a centered cluster, one row on any tablet. */
export function FooterBar({ start, end, center, zone, receded = false }: FooterBarProps) {
  return (
    <footer class={styles.footer} {...zone}>
      <div class={styles.footerToolsSlot} data-testid="footer-tools-slot" inert={receded}>
        <div class={styles.footerToolsClip}>
          <div class={styles.footerTools}>
            <div class={styles.footerSide}>{start}</div>
            <div class={`${styles.footerSide} ${styles.footerEnd}`}>{end}</div>
          </div>
        </div>
      </div>
      <div class={styles.footerCenter}>{center}</div>
    </footer>
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
  /** The menu's Metronome row (U87) and its handler. */
  readonly metronome: MetronomeRow
  readonly onMetronome: (on: boolean) => void
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
  metronome,
  onMetronome,
}: FooterProps) {
  return (
    <FooterBar
      zone={zone}
      receded={receded}
      start={
        <TempoControl
          multiplier={ui.multiplier}
          sourceBeatBpm={tempo?.beatBpm ?? 0}
          beatUnit={tempo?.beatUnit ?? QUARTER}
          onChange={(multiplier) => session.setSelection({ multiplier })}
          noTempo={tempo === null}
          onRequestTempo={onRequestTempo}
          placement="up"
        />
      }
      end={
        <FooterMenu
          ui={ui}
          session={session}
          receded={receded}
          labels={labels}
          onLabels={onLabels}
          hasTempo={tempo !== null}
          metronome={metronome}
          onMetronome={onMetronome}
        />
      }
      center={
        <>
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
        </>
      }
    />
  )
}
