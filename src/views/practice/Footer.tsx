import { msg } from '../../i18n/messages'
/**
 * The practice footer (DECISIONS U4, U12, U17, U76, U141): the always-visible Speed control on the
 * start side; the hand toggles around the large Start / Pause / Play button in the middle, with the
 * reason it is unavailable under them; the Menu button on the end side (an anchored popover with the
 * mode's rows). Large touch targets within thumb reach of a piano bench. One row on every tablet,
 * upright or on its side (U88): while playing, the tools dim in place (the menu closes), except in
 * Listen. Only a window too narrow for one row (640 px or less) wraps the tools into their own row,
 * which collapses in portrait focus mode (U60). The hand/play row stays available.
 */
import type { ComponentChildren } from 'preact'
import { isPractice, type PracticeSession, type SessionUi } from '../../app/session'
import { pushNotice } from '../../app/state'
import type { PersistentLabelMode } from '../../core/model/settings'
import { rat, type Rational } from '../../core/music/rational'
import { HandToggles, type HandTogglesProps } from '../../ui/HandToggles'
import { TempoControl } from '../../ui/TempoControl'
import { FooterMenu, type FooterMenuProps, type MetronomeRow } from './FooterMenu'
import type { RecedeZone } from './recede'
import styles from './practice.module.css'

/** The hand toggles' selection and words: the hands the learner plays or, in Listen, hears. */
export function handToggles(
  ui: SessionUi,
  session: PracticeSession,
): Pick<HandTogglesProps, 'hands' | 'onHandsChange' | 'onOnlyHand' | 'onText' | 'offText'> {
  const silent = ui.mode === 'listen' || (ui.mode === 'follow' && ui.follow === 'mic')
  return {
    hands: ui.hands,
    onHandsChange: (hands) => session.setSelection({ hands }),
    onOnlyHand: () => pushNotice({ kind: 'info', text: msg('At least one hand stays on.') }),
    onText: ui.mode === 'listen' ? msg('you hear it') : msg('you play it'),
    offText: silent ? msg('silent') : msg('the piano plays it'),
  }
}

/** Does only a piano (there is none) keep the main button from starting the mode? */
function needsPiano(ui: SessionUi): boolean {
  return !ui.pianoConnected && (isPractice(ui.mode) || (ui.mode === 'follow' && !ui.micSupported))
}

/**
 * Why the main button is unavailable, with Connect piano beside it when a piano is what is missing:
 * under the footer's cluster, or on a phone in a pill over the bottom of the score, so the layout
 * never shifts.
 */
export function StartReason({
  ui,
  phone,
  onConnect,
}: {
  readonly ui: SessionUi
  readonly phone: boolean
  readonly onConnect: () => void
}) {
  if (ui.playing || !ui.startReason) return null
  return (
    <div class={phone ? styles.stageNote : styles.startReason} role="note">
      <span>{ui.startReason}</span>
      {needsPiano(ui) ? (
        <button type="button" class={styles.connectPiano} onClick={onConnect}>
          {msg('Connect piano')}
        </button>
      ) : null}
    </div>
  )
}

const QUARTER = rat(1, 4)

export interface FooterProps {
  readonly onProgress?: (() => void) | undefined
  readonly onRecord?: (() => void) | undefined
  readonly recordingOpen?: boolean | undefined
  readonly recordDisabled?: boolean | undefined
  readonly ui: SessionUi
  readonly session: PracticeSession
  readonly zone: RecedeZone
  readonly receded?: boolean
  readonly onPlayPause: () => void
  readonly playLabel: string
  readonly playDisabled: boolean
  /** Why the main button is unavailable (`StartReason`), under the cluster. */
  readonly startReason: ComponentChildren
  /** Source tempo at the passage start; null when the score has none. */
  readonly tempo: { readonly beatBpm: number; readonly beatUnit: Rational } | null
  readonly labels: PersistentLabelMode
  readonly onLabels: (mode: PersistentLabelMode) => void
  readonly onNoteRules: () => void
  readonly onRequestTempo: () => void
  readonly scorePlayback: FooterMenuProps['scorePlayback']
  /** The menu's Metronome row (U87) and its handler. */
  readonly metronome: MetronomeRow
  readonly onMetronome: (on: boolean) => void
}

export function Footer({
  onProgress,
  onRecord,
  recordingOpen,
  recordDisabled,
  ui,
  session,
  zone,
  receded = false,
  onPlayPause,
  playLabel,
  playDisabled,
  startReason,
  tempo,
  labels,
  onLabels,
  onNoteRules,
  onRequestTempo,
  scorePlayback,
  metronome,
  onMetronome,
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
                filled
              />
            </div>
            <div class={`${styles.footerSide} ${styles.footerEnd}`}>
              <FooterMenu
                onProgress={onProgress}
                onRecord={onRecord}
                recordingOpen={recordingOpen}
                recordDisabled={recordDisabled}
                ui={ui}
                session={session}
                receded={receded}
                labels={labels}
                onLabels={onLabels}
                onNoteRules={onNoteRules}
                hasTempo={tempo !== null}
                scorePlayback={scorePlayback}
                metronome={metronome}
                onMetronome={onMetronome}
              />
            </div>
          </div>
        </div>
      </div>
      <div class={styles.footerCenter}>
        <HandToggles
          {...handToggles(ui, session)}
          playing={ui.playing}
          onPlayPause={onPlayPause}
          playLabel={playLabel}
          playDisabled={playDisabled}
          handClass={styles.recedes}
        />
        {startReason}
      </div>
    </footer>
  )
}
