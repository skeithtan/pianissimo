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
  /**
   * A phone-size screen (`usePhone`): the expanded result is the whole screen with its own header
   * (U99, 17 November 2026), not a card over the score.
   */
  readonly phone?: boolean
}

/** Space kept between the expanded tablet card and the top of the stage it may cover (px). */
export const DETAILS_MARGIN = 16
/** The expanded tablet card's details are at most this tall (px); its own list scrolls beyond. */
export const DETAILS_MAX_HEIGHT = 880
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
  const toggleButton = useRef<HTMLButtonElement>(null)
  const phone = !!p.phone
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
      toggleRef={toggleButton}
      phone={phone}
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
 * Height the tablet card's details may take above the pill: up to DETAILS_MARGIN under the top
 * of the stage (the score area), at most DETAILS_MAX_HEIGHT. (A phone shows the details full
 * screen: no height to measure.)
 */
function availableHeight(card: HTMLElement | null): number {
  if (!card || typeof window === 'undefined') return DETAILS_MAX_HEIGHT
  const top = card.getBoundingClientRect().top
  const stage = card.closest('[data-activity]')?.querySelector('[data-repeat-bounds]')
  const stageTop = stage?.getBoundingClientRect().top ?? 0
  const room = top - stageTop - DETAILS_MARGIN
  return Math.max(120, Math.min(DETAILS_MAX_HEIGHT, Math.round(room)))
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Keeps keyboard focus inside the full-screen panel (a modal region while it covers the screen):
 * Tab wraps from the last control to the first and Shift+Tab the other way. Returns true when it
 * moved focus (the caller prevents the default).
 */
export function wrapTab(panel: HTMLElement, event: { shiftKey: boolean }, active: Element | null): boolean {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]'))
  if (items.length === 0) return false
  const first = items[0]!
  const last = items[items.length - 1]!
  if (event.shiftKey && (active === first || !panel.contains(active))) {
    last.focus()
    return true
  }
  if (!event.shiftKey && (active === last || !panel.contains(active))) {
    first.focus()
    return true
  }
  return false
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
  toggleRef,
  phone,
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
  toggleRef: RefObject<HTMLButtonElement | null>
  /** Phone-size screen: the expanded result is full screen with its own header. */
  phone: boolean
  details: ComponentChildren
  hasDetails: boolean
  onToggle: () => void
  onRestart: () => void
  onDismiss: () => void
}) {
  const detailsId = useId()
  const panel = useRef<HTMLElement>(null)
  const hide = useRef<HTMLButtonElement>(null)
  // Full screen on a phone: the pill underneath is covered, so it is inert; focus moves into the
  // panel on opening and returns to the pill's chevron on closing; Tab stays inside.
  const full = phone && expanded
  const wasFull = useRef(false)
  const open = unfold !== null
  useLayoutEffect(() => {
    if (full && open) {
      hide.current?.focus()
      wasFull.current = true
    } else if (!full && wasFull.current) {
      wasFull.current = false
      const active = document.activeElement
      if (!active || active === document.body || panel.current?.contains(active)) toggleRef.current?.focus()
    }
  }, [full, open])
  useEffect(() => {
    if (!full) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel.current) return
      if (wrapTab(panel.current, event, document.activeElement)) event.preventDefault()
    }
    const onFocusIn = (event: FocusEvent) => {
      // Not while it is closing: the layout effect hands focus back to the pill's chevron first.
      if (!wasFull.current) return
      const target = event.target as Node | null
      if (target && panel.current && !panel.current.contains(target)) hide.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [full])
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
      data-layout={phone ? 'screen' : 'panel'}
      style={{ '--result-details-max': `${maxHeight}px` }}
    >
      {unfold !== null ? (
        <section
          ref={panel}
          id={detailsId}
          class={styles.resultDetails}
          // A phone: the panel covers the whole screen, so it is a modal dialog (focus stays in it,
          // the rest is not reachable). A tablet: a plain labeled region over the score.
          role={phone ? 'dialog' : undefined}
          aria-modal={phone ? 'true' : undefined}
          aria-label="Details of this pass"
          data-testid="result-details"
          data-layout={phone ? 'screen' : 'panel'}
          data-tone={tone}
          data-phase={unfold}
        >
          {phone ? (
            <header class={styles.screenHeader} data-testid="result-screen-header">
              <button
                ref={hide}
                type="button"
                class={styles.screenBack}
                aria-label="Hide details"
                title="Hide details"
                data-testid="result-details-hide"
                onClick={onToggle}
              >
                <Icon name="down" size={24} />
              </button>
              <h2 class={styles.screenTitle}>
                <span>{resultTitle(r)}</span>
                {dots !== null ? (
                  <span class={styles.resultGoal} role="img" aria-label={`${filled} of ${dots} clean toward the goal`}>
                    {Array.from({ length: dots }, (_, i) => (
                      <span key={i} class={styles.resultDot} data-on={i < filled || undefined} />
                    ))}
                  </span>
                ) : null}
              </h2>
              {showAgain ? (
                <Button variant="primary" icon="restart" class={styles.resultAgain} onClick={onRestart}>
                  Again
                </Button>
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
            </header>
          ) : null}
          {details}
        </section>
      ) : null}
      <div class={styles.result} role="status" inert={full || undefined}>
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
              ref={toggleRef}
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
