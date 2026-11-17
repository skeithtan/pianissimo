/**
 * Status over the preserved score: a piano disconnect, sound loading, interruptions,
 * Ready/waiting (`Banners`, rendered into the stage's top overlay column, under the Repeat panel;
 * never recedes, U13), and the compact result after each attempt (`AttemptResult`, spec
 * "Repeating passages": "After each attempt, show a compact result while preserving the score"),
 * docked at the bottom of the stage, clear of the passage the strip reviews (U97).
 *
 * One disconnect notice at a time: while the piano input is gone, its banner shows and nothing
 * else about the disconnect does (no sound-status line for the lost output, no "Piano
 * disconnected" toast: `MidiService` skips it while Practice is on screen, U71); once the piano
 * is back every disconnect message goes away, including the attempt's "disconnected"
 * interruption (the footer's main button offers Resume / Start, user 2026-11-02). There is no
 * end-of-piece banner: the footer's main button offers Start.
 */
import type { ComponentChildren, RefObject } from 'preact'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { repeatedMistakeLine, type AttemptSummary, type SessionUi } from '../../app/session'
import type { ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import { Button } from '../../ui/controls'
import { useFadePresence, type FadePhase } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { formatSpeedPercent } from '../../ui/speed'
import { timingText, wrongText } from './format'
import styles from './practice.module.css'

/** The result card fades and rises in, fades and sinks out (CSS `.result[data-phase]` mirrors it). */
export const RESULT_FADE_MS = 220

export interface BannersProps {
  readonly ui: SessionUi
  readonly onRestart: () => void
  readonly onResume: () => void
  readonly onConnection: () => void
}

export function Banners(p: BannersProps) {
  const { ui } = p
  // Play-through grades nothing and is never interrupted like an attempt (DECISIONS P12).
  const playing = ui.activity === 'playing'
  const r = playing ? null : ui.lastResult
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
      {ui.micStatus ? (
        <div class={styles.banner} role="status" data-testid="mic-status">
          <Icon name="mic" size={20} />
          <span>{ui.micStatus}</span>
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
 * The result card's headline (U97): "Clean pass", else what kept the pass from being clean, the
 * first of: wrong notes ("2 wrong notes"), timing (Keep time), help; "Completed" otherwise.
 */
export function resultTitle(r: AttemptSummary): string {
  if (r.passed) return 'Clean pass'
  if (r.wrongAttacks > 0) return wrongText(r.wrongAttacks)
  if (r.timing && r.timing.onTime < r.timing.groups) return 'Timing slipped'
  if (r.assistance !== 'none') return 'Played with help'
  return 'Completed'
}

export interface AttemptResultProps {
  readonly ui: SessionUi
  /** The practiced score and the naming settings word a repeated mistake (P24) on the card. */
  readonly model: Pick<ScoreModel, 'notes'>
  readonly naming: NamingSettings
  /**
   * What the expanded card holds (U99), rendered only while it is expanded; absent: no Details
   * control. Nothing in it may leave Practice.
   */
  readonly details?: (r: AttemptSummary) => ComponentChildren
  readonly onRestart: () => void
  readonly onDismiss: () => void
  /**
   * The expanded result, held by the owner so a rotation that moves the dock (strip ↔ page)
   * keeps the card open; absent: the card holds it itself.
   */
  readonly expandedId?: string | null
  readonly onExpandedChange?: (id: string | null) => void
}

/** Space kept between the expanded card and the top of the area it may cover (px). */
const DETAILS_MARGIN = 8
/** Below this, the expanded card may also cover the screen's top bar (a phone on its side). */
const DETAILS_MIN_HEIGHT = 220
/** The expanded card's details are at most this tall (px); its own list scrolls beyond. */
export const DETAILS_MAX_HEIGHT = 560
/** The details fold away in this long (CSS `.resultDetails[data-phase=leaving]`). */
export const DETAILS_FOLD_MS = 200

/**
 * The result after a completed attempt (U97, revising U33), docked at the bottom of the stage: it
 * fades and rises in, keeps the last result while it fades out, and shows nothing while playing
 * through (P12). Details expands it in place into a larger card (U99): the details open above
 * the pill as an overlay (the dock keeps the pill's size, so the strip's review never re-fits),
 * Hide details, Escape or anything that ends the result folds it again; a new result starts
 * folded.
 */
export function AttemptResult(p: AttemptResultProps) {
  const { ui } = p
  const r = ui.activity === 'playing' ? null : ui.lastResult
  // While it fades out, the card keeps showing the last result it had.
  const last = useRef<AttemptSummary | null>(r)
  if (r) last.current = r
  const presence = useFadePresence(!!r, RESULT_FADE_MS)
  const shown = r ?? last.current
  // Worded here, on a render, never in the input path; it follows the naming settings live.
  const first = shown?.repeatedMistakes?.[0]
  const note = useMemo(() => (first ? repeatedMistakeLine(first, p.model, p.naming) : null), [first, p.model, p.naming])
  // Expanded for one result only: a new pass (or none) folds it.
  const [ownId, setOwnId] = useState<string | null>(null)
  const expandedId = p.onExpandedChange ? (p.expandedId ?? null) : ownId
  const setExpandedId = p.onExpandedChange ?? setOwnId
  const expanded = !!r && expandedId === r.id && !!p.details
  // The details unfold and fold like an accordion: they stay mounted while folding.
  const unfold = useFadePresence(expanded, DETAILS_FOLD_MS)
  const root = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState(DETAILS_MAX_HEIGHT)
  // Measured again when the card mounts expanded (a rotation moved the dock).
  useLayoutEffect(() => {
    if (expanded) setMaxHeight(availableHeight(root.current))
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setExpandedId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded])

  const toggle = () => {
    if (!r) return
    if (expanded) {
      setExpandedId(null)
      return
    }
    setMaxHeight(availableHeight(root.current))
    setExpandedId(r.id)
  }

  if (!presence.mounted || !shown) return null
  return (
    <ResultCard
      r={shown}
      note={note}
      phase={presence.phase}
      multiplier={ui.multiplier}
      goal={ui.repeat ? ui.repeatTarget : null}
      showAgain={!ui.repeat || shown.targetReached}
      expanded={expanded}
      maxHeight={maxHeight}
      rootRef={root}
      unfold={unfold.mounted ? unfold.phase : null}
      details={p.details && unfold.mounted ? p.details(shown) : null}
      hasDetails={!!p.details}
      onToggle={toggle}
      onRestart={p.onRestart}
      onDismiss={p.onDismiss}
    />
  )
}

/**
 * Height the expanded details may take above the pill: up to the top of the stage (the score
 * area), or, when that leaves too little (a phone on its side), up to the top of the screen.
 */
function availableHeight(card: HTMLElement | null): number {
  if (!card || typeof window === 'undefined') return DETAILS_MAX_HEIGHT
  const top = card.getBoundingClientRect().top
  const stage = card.closest('[data-activity]')?.querySelector('[data-repeat-bounds]')
  const stageTop = stage?.getBoundingClientRect().top ?? 0
  let room = top - stageTop - DETAILS_MARGIN
  if (room < DETAILS_MIN_HEIGHT) room = top - DETAILS_MARGIN
  return Math.max(120, Math.min(DETAILS_MAX_HEIGHT, Math.round(room)))
}

/**
 * One slim row: a badge (a check for a clean pass, else the number of wrong notes), the headline
 * with the Repeat goal as dots, one status line (Keep time's timing, the streak, what the speed
 * ladder did, the goal reached), an optional second line (`note`: the latest pass's most repeated
 * mistake, P24, "F instead of F♯ in bar 12, three passes running"), then Again, Details and Hide.
 * Details (a chevron, labeled where there is room) expands the card upward over the score: the
 * details sit above the row, which stays where it was, so the chevron never moves under the finger.
 */
function ResultCard({
  r,
  note,
  phase,
  multiplier,
  goal,
  showAgain,
  expanded,
  unfold,
  maxHeight,
  rootRef,
  details,
  hasDetails,
  onToggle,
  onRestart,
  onDismiss,
}: {
  r: AttemptSummary
  /** A repeated mistake, worded (P24), or null. */
  note: string | null
  phase: FadePhase
  multiplier: number
  /** The Repeat target ("until N clean") shown as dots, or null. */
  goal: number | null
  showAgain: boolean
  expanded: boolean
  /** The details while unfolded or folding (their fade phase), else null. */
  unfold: FadePhase | null
  maxHeight: number
  rootRef: RefObject<HTMLDivElement | null>
  details: ComponentChildren
  hasDetails: boolean
  onToggle: () => void
  onRestart: () => void
  onDismiss: () => void
}) {
  const detailsId = useId()
  const timing = r.timing ? timingText(r.timing) : null
  const ladder = ladderResultText(r, multiplier)
  const dots = goal !== null && goal > 1 ? goal : null
  const filled = dots === null ? 0 : r.targetReached ? dots : Math.min(r.streak, dots)
  const tone = r.passed ? 'clean' : r.wrongAttacks > 0 ? 'wrong' : 'plain'
  const status = [
    timing ? (
      <span key="timing" data-testid="timing-result">
        {timing}
      </span>
    ) : null,
    r.streak > 1 ? <span key="streak">{r.streak} clean in a row</span> : null,
    ladder ? (
      <span key="ladder" data-testid="ladder-result">
        {ladder}
      </span>
    ) : null,
    r.targetReached ? <span key="goal">Goal reached. Repeat is off.</span> : null,
  ].filter((part) => part !== null)
  return (
    <div
      ref={rootRef}
      class={styles.resultCard}
      data-testid="attempt-result"
      data-passed={r.passed}
      data-tone={tone}
      data-phase={phase}
      data-expanded={unfold !== null || undefined}
      style={{ '--result-details-max': `${maxHeight}px` }}
    >
      {unfold !== null ? (
        <section
          id={detailsId}
          class={styles.resultDetails}
          aria-label="Details of this pass"
          data-testid="result-details"
          data-phase={unfold}
        >
          {details}
        </section>
      ) : null}
      <div class={styles.result} role="status">
        <span class={styles.resultBadge} aria-hidden="true">
          {tone === 'clean' ? (
            <Icon name="check" size={22} />
          ) : tone === 'wrong' ? (
            <span class={styles.resultCount}>{r.wrongAttacks > 99 ? '99+' : r.wrongAttacks}</span>
          ) : (
            <Icon name="restart" size={20} />
          )}
        </span>
        <div class={styles.resultText}>
          <p class={styles.resultTitle}>
            <span>{resultTitle(r)}</span>
            {dots !== null ? (
              <span class={styles.resultGoal} role="img" aria-label={`${filled} of ${dots} clean toward the goal`}>
                {Array.from({ length: dots }, (_, i) => (
                  <span key={i} class={styles.resultDot} data-on={i < filled || undefined} />
                ))}
              </span>
            ) : null}
          </p>
          {status.length ? (
            <p class={styles.resultStatus}>{status.flatMap((part, i) => (i ? [' · ', part] : [part]))}</p>
          ) : null}
          {note ? (
            <p class={styles.resultNote} data-testid="result-note">
              {note}
            </p>
          ) : null}
        </div>
        <div class={styles.resultActions}>
          {showAgain ? (
            <Button variant="primary" icon="restart" class={styles.resultAgain} onClick={onRestart}>
              Again
            </Button>
          ) : null}
          {hasDetails ? (
            <button
              type="button"
              class={styles.resultDetailsButton}
              aria-expanded={expanded}
              aria-controls={expanded ? detailsId : undefined}
              aria-label={expanded ? 'Hide details' : 'Show details of this pass'}
              title={expanded ? 'Hide details' : 'Details of this pass'}
              data-testid="result-details-toggle"
              onClick={onToggle}
            >
              <Icon name={expanded ? 'down' : 'up'} size={20} />
              <span class={styles.resultDetailsLabel} aria-hidden="true">
                Details
              </span>
            </button>
          ) : null}
          <button
            type="button"
            class={styles.resultIconButton}
            aria-label="Hide result"
            title="Hide"
            onClick={onDismiss}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
