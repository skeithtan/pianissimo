/**
 * Status over the preserved score: a piano disconnect, sound loading,
 * interruptions, Ready/waiting, and the compact result after each attempt (spec "Repeating
 * passages": "After each attempt, show a compact result while preserving the score"). Rendered
 * into the stage's top overlay column, under the Repeat panel; never recedes (U13).
 *
 * One disconnect notice at a time: while the piano input is gone, its banner shows and nothing
 * else about the disconnect does (no sound-status line for the lost output, no "Piano
 * disconnected" toast: `MidiService` skips it while Practice is on screen, U71); once the piano
 * is back every disconnect message goes away, including the attempt's "disconnected"
 * interruption (the footer's main button offers Resume / Start, user 2026-11-02). There is no
 * end-of-piece banner: the footer's main button offers Start.
 */
import { useRef } from 'preact/hooks'
import type { AttemptSummary, SessionUi } from '../../app/session'
import { Button } from '../../ui/controls'
import { useFadePresence, type FadePhase } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { formatSpeedPercent } from '../../ui/speed'
import { assistanceText, firstPassText, timeLine, timingText, wrongText } from './format'
import styles from './practice.module.css'

/** The result card fades and rises in, fades and sinks out (CSS `.result[data-phase]` mirrors it). */
export const RESULT_FADE_MS = 220

export interface BannersProps {
  readonly ui: SessionUi
  readonly onRestart: () => void
  readonly onResume: () => void
  readonly onResults: (attemptId: string) => void
  readonly onDismissResult: () => void
  readonly onConnection: () => void
}

export function Banners(p: BannersProps) {
  const { ui } = p
  // Play-through grades nothing and is never interrupted like an attempt (DECISIONS P12).
  const playing = ui.activity === 'playing'
  const r = playing ? null : ui.lastResult
  // While it fades out, the card keeps showing the last result it had.
  const last = useRef<AttemptSummary | null>(r)
  if (r) last.current = r
  const presence = useFadePresence(!!r, RESULT_FADE_MS)
  const shown = r ?? last.current
  const interruption = !playing && ui.interruption && ui.interruption.reason !== 'disconnect' ? ui.interruption : null
  return (
    <>
      {ui.inputDisconnected ? (
        <div class={`${styles.banner} ${styles.bannerWarn}`} role="alert" data-testid="input-disconnected">
          <Icon name="plug" size={20} />
          <span>Piano disconnected. Reconnect it to continue.</span>
          <Button onClick={p.onConnection}>Connection</Button>
        </div>
      ) : null}
      {ui.soundStatus && !ui.inputDisconnected ? (
        <div class={styles.banner} role="status">
          <Icon name="sound" size={20} />
          <span>{ui.soundStatus}</span>
        </div>
      ) : null}
      {interruption ? (
        <div class={`${styles.banner} ${styles.bannerWarn}`} role="status" data-testid="interruption">
          <Icon name="alert" size={20} />
          <span>{interruption.text}</span>
          {interruption.canResume ? (
            <>
              <Button variant="primary" onClick={p.onResume}>
                Resume from here
              </Button>
              <Button onClick={p.onRestart}>Restart</Button>
            </>
          ) : (
            <Button variant="primary" icon="restart" onClick={p.onRestart}>
              Restart passage
            </Button>
          )}
        </div>
      ) : null}
      {ui.waiting ? (
        <div class={styles.banner} role="status">
          <span>{ui.waiting}</span>
        </div>
      ) : null}
      {/* Keep time counts in instead (`CountIn` over the stage): its clock never waits for a note. */}
      {ui.phase === 'ready' && ui.activity === 'scored' && !r && !ui.rhythm ? (
        <div class={`${styles.banner} ${styles.bannerReady}`} role="status" data-testid="ready">
          <Icon name="target" size={20} />
          <span>Ready. The clock starts with your first note.</span>
        </div>
      ) : null}
      {presence.mounted && shown ? (
        <ResultCard
          r={shown}
          phase={presence.phase}
          corrections={ui.corrections}
          multiplier={ui.multiplier}
          showAgain={!ui.repeat || shown.targetReached}
          onResults={p.onResults}
          onRestart={p.onRestart}
          onDismiss={p.onDismissResult}
        />
      ) : null}
    </>
  )
}

/**
 * What the speed ladder did after an attempt, in one line ("Speed up: next at 65%", "Back to
 * 55%", "Goal reached: 100%"), or null. `multiplier` is the current speed (the goal when done).
 */
export function ladderResultText(r: AttemptSummary, multiplier: number): string | null {
  const l = r.ladder
  if (!l) return null
  if (l.climbedTo !== undefined) return `Speed up: next at ${formatSpeedPercent(l.climbedTo)}`
  if (l.droppedTo !== undefined) return `Back to ${formatSpeedPercent(l.droppedTo)}`
  if (l.done) return `Goal reached: ${formatSpeedPercent(multiplier)}`
  return null
}

/**
 * The compact attempt result: a card with a status rail (success for a clean pass), the outcome
 * as its title, the streak under it, the facts as a label / value grid, actions at the end.
 */
function ResultCard({
  r,
  phase,
  corrections,
  multiplier,
  showAgain,
  onResults,
  onRestart,
  onDismiss,
}: {
  r: AttemptSummary
  phase: FadePhase
  /** Teacher corrections drawn on the score (U39). */
  corrections: number
  multiplier: number
  showAgain: boolean
  onResults: (attemptId: string) => void
  onRestart: () => void
  onDismiss: () => void
}) {
  // A Keep time attempt shows how it kept time in place of its completion time.
  const timing = r.timing ? timingText(r.timing) : null
  const time = timing ? null : timeLine(r)
  const firstPass = firstPassText(r)
  const ladder = ladderResultText(r, multiplier)
  return (
    <div class={styles.result} role="status" data-testid="attempt-result" data-passed={r.passed} data-phase={phase}>
      <div class={styles.resultHead}>
        <span class={styles.resultIcon} aria-hidden="true">
          <Icon name={r.passed ? 'check' : 'restart'} size={20} />
        </span>
        <div class={styles.resultTitles}>
          <p class={styles.resultTitle}>{r.passed ? 'Clean pass' : 'Completed'}</p>
          {r.streak > 1 ? <p class={styles.resultSubtitle}>{r.streak} clean in a row</p> : null}
        </div>
      </div>
      <button type="button" class={styles.resultClose} aria-label="Hide result" onClick={onDismiss}>
        <Icon name="close" size={18} />
      </button>
      <dl class={styles.resultFacts}>
        <div>
          <dt>Mistakes</dt>
          <dd>{wrongText(r.wrongAttacks)}</dd>
        </div>
        {timing ? (
          <div>
            <dt>Timing</dt>
            <dd data-testid="timing-result">{timing}</dd>
          </div>
        ) : null}
        {time ? (
          <div>
            <dt>Time</dt>
            <dd>{time}</dd>
          </div>
        ) : null}
        {firstPass ? (
          <div>
            <dt>First try</dt>
            <dd>{firstPass}</dd>
          </div>
        ) : null}
        <div>
          <dt>Help</dt>
          <dd>{assistanceText(r)}</dd>
        </div>
        {corrections > 0 ? (
          <div>
            <dt>To improve</dt>
            <dd>{corrections === 1 ? '1 mark on the score' : `${corrections} marks on the score`}</dd>
          </div>
        ) : null}
      </dl>
      {ladder ? (
        <p class={styles.resultNote} data-testid="ladder-result">
          {ladder}
        </p>
      ) : null}
      {r.targetReached ? <p class={styles.resultNote}>Target reached. Repeat is off.</p> : null}
      <div class={styles.resultActions}>
        <Button icon="chart" onClick={() => onResults(r.id)}>
          Details
        </Button>
        {showAgain ? (
          <Button variant="primary" icon="restart" onClick={onRestart}>
            Again
          </Button>
        ) : null}
      </div>
    </div>
  )
}
