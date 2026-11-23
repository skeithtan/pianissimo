import { msg, messageLanguage } from '../../i18n/messages'
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
import { prefersReducedMotion } from '../../ui/motion'
import { formatSpeedPercent } from '../../ui/speed'
import { passFacts, timingText, wrongText } from './format'
import {
  QUICK_FOLD_MS,
  joinMotion,
  panelOpening,
  screenOpening,
  startMotion,
  steerMotion,
  type MotionStep,
} from './resultMotion'
import styles from './practice.module.css'

export { QUICK_FOLD_MS } from './resultMotion'

/** The result card fades and rises in, fades and sinks out (CSS `.result[data-phase]` mirrors it). */
export const RESULT_FADE_MS = 220
/** Played past by the next pass (U101), it slides down out of view in this long (CSS mirrors it). */
export const RESULT_SLIDE_MS = 320

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
          <span>{msg('Piano disconnected. Reconnect it to continue.')}</span>
          <Button onClick={p.onConnection}>{msg('Connection')}</Button>
        </div>
      ) : null}
      {ui.soundStatus && !ui.inputDisconnected ? (
        <div class={styles.banner} role="status">
          <Icon name="sound" size={20} />
          <span>{msg(ui.soundStatus)}</span>
        </div>
      ) : null}
      {ui.micStatus ? (
        <div class={styles.banner} role="status" data-testid="mic-status">
          <Icon name="mic" size={20} />
          <span>{msg(ui.micStatus)}</span>
        </div>
      ) : null}
      {interruption ? (
        <div class={`${styles.banner} ${styles.bannerWarn}`} role="status" data-testid="interruption">
          <Icon name="alert" size={20} />
          <span>{msg(interruption.text)}</span>
          {interruption.canResume ? (
            <>
              <Button variant="primary" onClick={p.onResume}>
                {msg('Resume from here')}
              </Button>
              <Button onClick={p.onRestart}>{msg('Restart')}</Button>
            </>
          ) : (
            <Button variant="primary" icon="restart" onClick={p.onRestart}>
              {msg('Restart passage')}
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
          <span>{msg('Ready. The clock starts with your first note.')}</span>
        </div>
      ) : null}
    </>
  )
}

/**
 * What the speed ladder did after an attempt, in one line ("Speed up: next at 65%" or
 * "Goal reached: 100%"), or null. `multiplier` is the current speed (the goal when done).
 */
export function ladderResultText(r: AttemptSummary, multiplier: number): string | null {
  const l = r.ladder
  if (!l) return null
  if (l.climbedTo !== undefined) return msg('Speed up: next at {0}', formatSpeedPercent(l.climbedTo))
  if (l.done) return msg('Goal reached: {0}', formatSpeedPercent(multiplier))
  return null
}

/**
 * The result card's headline (U97): "Clean pass", else what kept the pass from being clean, the
 * first of: wrong notes ("2 wrong notes"), timing (Keep time), help; "Completed" otherwise.
 */
export function resultTitle(r: AttemptSummary): string {
  if (r.passed) return msg('Clean pass')
  if (r.wrongAttacks > 0) return wrongText(r.wrongAttacks)
  if (r.timing && r.timing.onTime < r.timing.groups) return msg('Timing slipped')
  if (r.assistance !== 'none') return msg('Played with help')
  return msg('Completed')
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
/** Shared duration of the result opening and its reverse. */
export const DETAILS_FOLD_MS = 420
/** The opening's easing (`--ease-standard`). */
const OPEN_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'
/** A newly completed loop briefly reveals more of its preview before settling. */
const RESULT_PREVIEW_MS = 960
const RESULT_SWIPE_PX = 40
const RESULT_TAP_SLOP_PX = 10

/** The opening under way: its animations, and how to stop following the panel's contents. */
interface ResultMotion {
  readonly opening: ResultOpening
  readonly animations: Animation[]
  readonly unfollow: () => void
}

interface ResultOpening {
  readonly id: string
  readonly phone: boolean
  /** The pill's rectangle and corner radius when it was tapped: the opening starts from them. */
  readonly bounds: DOMRect
  readonly radius: number
}

/**
 * The result after a completed attempt (U97, revising U33), docked at the bottom of the stage: it
 * fades and rises in, keeps the last result while it fades out, and shows nothing while playing
 * through (P12). A tap or swipe up opens details above the pill. The dock keeps the same height
 * while it opens. A swipe down dismisses the result. A new result starts folded. Tap the pill or
 * press Escape to fold it again. On the next pass's first correct note, the pill folds and dims
 * (U101). A tap restores it to full strength. Playing past it slides it out of view.
 */
export function AttemptResult(p: AttemptResultProps) {
  const { ui } = p
  const r = ui.activity === 'playing' ? null : ui.lastResult
  // While it fades out, the card keeps showing the last result it had.
  const last = useRef<AttemptSummary | null>(r)
  if (r) last.current = r
  // Dimmed while the next pass plays (U101), until a tap brings this result back to full strength.
  const [restoredId, setRestoredId] = useState<string | null>(null)
  const lastDimmed = useRef(false)
  if (r) lastDimmed.current = ui.resultDimmed && restoredId !== r.id
  const dimmed = lastDimmed.current
  const exit = r ? null : ui.resultExit
  const shown = r ?? last.current
  const seenResult = useRef(r?.id)
  const [introId, setIntroId] = useState<string | null>(null)
  useLayoutEffect(() => {
    const id = r?.id
    if (seenResult.current === id) return
    seenResult.current = id
    if (!id || !ui.repeat || !p.details || prefersReducedMotion()) return
    setIntroId(id)
    const timer = setTimeout(() => setIntroId(null), RESULT_PREVIEW_MS)
    return () => clearTimeout(timer)
  }, [r?.id])
  // Worded here, on a render, never in the input path; it follows the naming settings live.
  const first = shown?.repeatedMistakes?.[0]
  const note = useMemo(
    () => (first ? repeatedMistakeLine(first, p.model, p.naming) : null),
    [first, p.model, p.naming, messageLanguage()],
  )
  // Expanded for one result only: a new pass (or none) folds it.
  const [ownId, setOwnId] = useState<string | null>(null)
  const expandedId = p.onExpandedChange ? (p.expandedId ?? null) : ownId
  const setExpandedId = p.onExpandedChange ?? setOwnId
  const expanded = !!r && expandedId === r.id && !!p.details
  // The next pass is under way: the details fold, quickly (the pill stays, dimmed).
  const [quickFold, setQuickFold] = useState(false)
  useEffect(() => {
    if (r && ui.resultDimmed && expandedId === r.id) {
      setQuickFold(true)
      setExpandedId(null)
    }
  }, [r?.id, ui.resultDimmed])
  useEffect(() => {
    if (expanded) setQuickFold(false)
  }, [expanded])
  const foldMs = quickFold ? QUICK_FOLD_MS : DETAILS_FOLD_MS
  // The details unfold and fold: they stay mounted while folding.
  const unfold = useFadePresence(expanded, foldMs)
  const presence = useFadePresence(!!r || unfold.mounted, ui.resultExit === 'played' ? RESULT_SLIDE_MS : RESULT_FADE_MS)
  const root = useRef<HTMLDivElement>(null)
  const toggleButton = useRef<HTMLButtonElement>(null)
  const phone = !!p.phone
  const [opening, setOpening] = useState<ResultOpening | null>(null)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  // The room above the pill, measured once the card is laid out expanded (before the opening starts).
  useLayoutEffect(() => {
    const card = root.current
    if (expanded && unfold.mounted && !phone && card) setMaxHeight(availableHeight(card))
  }, [expanded, unfold.mounted, phone])

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
      if (!phone) toggleButton.current?.focus({ preventScroll: true })
      return
    }
    if (unfold.mounted && opening?.id === r.id && opening.phone === phone) {
      setExpandedId(r.id)
      return
    }
    const pill = root.current
    const bounds = pill?.getBoundingClientRect()
    const row = pill?.querySelector(`.${styles.result}`)
    const radius = row ? parseFloat(getComputedStyle(row).borderBottomLeftRadius) : NaN
    setOpening(
      bounds && bounds.width > 0 && !prefersReducedMotion()
        ? { id: r.id, phone, bounds, radius: Number.isFinite(radius) ? radius : 22 }
        : null,
    )
    setMaxHeight(null)
    setIntroId(null)
    setExpandedId(r.id)
  }

  const restore = () => {
    if (r && dimmed) setRestoredId(r.id)
  }

  if (!presence.mounted || !shown) return null
  return (
    <ResultCard
      r={shown}
      note={note}
      phase={presence.phase}
      dimmed={dimmed}
      exit={exit}
      onRestore={restore}
      multiplier={ui.multiplier}
      goal={ui.repeat ? ui.repeatTarget : null}
      showAgain={!ui.repeat || shown.targetReached}
      expanded={expanded}
      intro={!!r && introId === r.id && !expanded && !ui.resultDimmed}
      opening={shown.id === opening?.id && opening.phone === phone ? opening : null}
      // The tablet card's height is known: its opening can be laid out and started.
      measured={phone || maxHeight !== null}
      maxHeight={maxHeight ?? DETAILS_MAX_HEIGHT}
      foldMs={foldMs}
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

/**
 * The details can replace their loading line while the card opens: what appears in `panel` then joins
 * the running motion at its point, so it never shows ahead of the clip. Returns how to stop.
 */
function followContents(panel: Element | null, steps: readonly MotionStep[], animations: Animation[]): () => void {
  const contents = panel ? Array.from(panel.children) : []
  const keyframes = steps.find((step) => contents.includes(step.target))?.keyframes
  if (!panel || !keyframes || typeof MutationObserver === 'undefined') return () => undefined
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of Array.from(record.addedNodes)) {
        const reference = animations[0]
        if (!(node instanceof Element) || !reference) continue
        const joined = joinMotion(node, keyframes, reference, DETAILS_FOLD_MS, OPEN_EASING)
        if (joined) animations.push(joined)
      }
  })
  observer.observe(panel, { childList: true })
  return () => observer.disconnect()
}

/**
 * How far inside the panel's sides its contents begin: the smallest distance from either side of
 * `section` to the padded edge of any of `content` (0 for none, or for content without padding).
 */
function paddedInset(section: Element, content: readonly Element[]): number {
  const box = section.getBoundingClientRect()
  let inset = Infinity
  for (const el of content) {
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    inset = Math.min(
      inset,
      r.left + parseFloat(style.paddingLeft) - box.left,
      box.right - r.right + parseFloat(style.paddingRight),
    )
  }
  return Number.isFinite(inset) ? Math.max(0, inset) : 0
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
 * mistake (P24), and the Again and Hide actions. A clipped preview shows actual pass facts.
 * The summary is one large expand control and stays in place when the details open above it.
 */
function ResultCard({
  r,
  note,
  phase,
  dimmed,
  exit,
  onRestore,
  multiplier,
  goal,
  showAgain,
  expanded,
  intro,
  opening,
  measured,
  unfold,
  maxHeight,
  foldMs,
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
  /** The next pass is under way (U101): the pill recedes; a tap (or focus) brings it back. */
  dimmed: boolean
  /** How it leaves once gone: 'played' slides down out of view (U101), else it fades. */
  exit: 'played' | 'dismissed' | null
  onRestore: () => void
  multiplier: number
  /** The Repeat target ("until N clean") shown as dots, or null. */
  goal: number | null
  showAgain: boolean
  expanded: boolean
  intro: boolean
  /** Where the pill was when it was tapped (null: no motion, as with reduced motion). */
  opening: ResultOpening | null
  /** The expanded layout is final (the tablet card's height is set): the opening may start. */
  measured: boolean
  /** The details while unfolded or folding (their fade phase), else null. */
  unfold: FadePhase | null
  maxHeight: number
  /** How long the current fold takes (a quick one when the next pass starts). */
  foldMs: number
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
  // panel on opening and returns to the pill on closing; Tab stays inside.
  const full = phone && expanded
  const wasFull = useRef(false)
  const open = unfold !== null
  const row = useRef<HTMLDivElement>(null)
  const outline = useRef<HTMLDivElement>(null)
  const motion = useRef<ResultMotion | null>(null)
  // The pill grows into the card once the expanded layout is final; a fold (or a quick second tap)
  // plays the same motion from wherever it is (U130), faster when the next pass starts.
  useLayoutEffect(() => {
    const card = rootRef.current
    const closing = unfold === 'leaving'
    if (motion.current && (!open || motion.current.opening !== opening)) {
      motion.current.unfollow()
      for (const animation of motion.current.animations) animation.cancel()
      motion.current = null
    }
    if (!card || !open) return
    if (!motion.current && opening && measured && !closing) {
      const steps = openingSteps(card, opening)
      const animations = startMotion(steps, DETAILS_FOLD_MS, OPEN_EASING)
      motion.current = { opening, animations, unfollow: followContents(panel.current, steps, animations) }
    }
    if (motion.current) {
      steerMotion(motion.current.animations, closing, DETAILS_FOLD_MS / foldMs)
      return
    }
    // No pill to grow from (reduced motion): the details' own unfold, reversed from where it is.
    for (const animation of panel.current?.getAnimations?.() ?? []) {
      const reversing = animation.playbackRate < 0
      if ('animationName' in animation && closing !== reversing) animation.reverse()
    }
  }, [unfold, opening, measured, foldMs])
  useEffect(() => () => motion.current?.unfollow(), [])
  const openingSteps = (card: HTMLElement, from: ResultOpening): MotionStep[] => {
    const section = panel.current
    if (!section) return []
    // The contents (a phone's header and the details, or their loading line) fade in once the
    // growing clip is clear of their padding. Measured once, here.
    const content = Array.from(section.children)
    const inset = paddedInset(section, content)
    if (from.phone)
      return screenOpening(section, from.bounds, section.getBoundingClientRect(), from.radius, content, inset)
    const summary = row.current?.querySelector(`.${styles.resultSummary}`) ?? null
    const starts = [`.${styles.resultBadge}`, `.${styles.resultText}`].map((q) => summary?.querySelector(q))
    const box = (row.current ?? card).getBoundingClientRect()
    const panelTop = section.getBoundingClientRect().top
    // The outline spans the expanded card, from the panel's top to the row's bottom.
    if (outline.current) outline.current.style.top = `${panelTop - box.top}px`
    return panelOpening(
      {
        card,
        panel: section,
        content,
        row: row.current,
        summary,
        start: starts.filter((el): el is Element => !!el),
        end: summary?.querySelector(`.${styles.resultActions}`) ?? null,
        outline: Array.from(outline.current?.children ?? []),
      },
      from.bounds,
      box,
      panelTop,
      { height: window.innerHeight },
      inset,
    )
  }
  useLayoutEffect(() => {
    if (full && open) {
      hide.current?.focus({ preventScroll: true })
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
      // The layout effect hands focus back to the pill as the panel closes.
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
  const gesture = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  // After a drag, the click a mouse sends on release must not also toggle; a touch drag sends none,
  // so the flag lasts only until the next task and covers only the element the drag started on.
  const skipClick = useRef<Element | null>(null)
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearSkip = () => {
    if (skipTimer.current !== null) clearTimeout(skipTimer.current)
    skipTimer.current = null
    skipClick.current = null
  }
  useEffect(() => clearSkip, [])
  // The phone header takes swipes while the details below it scroll normally.
  const swipe = {
    onPointerDown(event: PointerEvent) {
      if (event.button !== 0 || !event.isPrimary || gesture.current) return
      clearSkip()
      const target = event.target as Element
      const button = target.closest('button')
      if (button && button !== toggleRef.current) return
      gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      // Capture on the original target so a tap still clicks the native summary button.
      target.setPointerCapture?.(event.pointerId)
    },
    onPointerUp(event: PointerEvent) {
      const start = gesture.current
      if (!start || start.pointerId !== event.pointerId) return
      gesture.current = null
      const dx = Math.abs(event.clientX - start.x)
      const dy = event.clientY - start.y
      if (Math.max(dx, Math.abs(dy)) >= RESULT_TAP_SLOP_PX && event.currentTarget instanceof Element) {
        clearSkip()
        skipClick.current = event.currentTarget
        skipTimer.current = setTimeout(clearSkip, 0)
      }
      if (Math.abs(dy) < RESULT_SWIPE_PX || Math.abs(dy) <= dx * 1.2) return
      if (dy > 0) onDismiss()
      else if (!expanded && hasDetails) {
        onRestore()
        onToggle()
      }
    },
    // Capture lost before the release (the element went away): no click follows this drag.
    onLostPointerCapture(event: PointerEvent) {
      if (gesture.current?.pointerId !== event.pointerId) return
      gesture.current = null
      clearSkip()
    },
    onPointerCancel(event: PointerEvent) {
      if (gesture.current?.pointerId === event.pointerId) gesture.current = null
      clearSkip()
    },
  }
  const timing = r.timing ? timingText(r.timing) : null
  const ladder = ladderResultText(r, multiplier)
  const dots = goal !== null && goal > 1 ? goal : null
  const filled = dots === null ? 0 : r.targetReached ? dots : Math.min(r.streak, dots)
  const tone = r.passed ? 'clean' : r.wrongAttacks > 0 ? 'wrong' : 'plain'
  const hasPreview = hasDetails && r.groupsTotal > 0
  const status = [
    timing ? (
      <span key="timing" data-testid="timing-result">
        {timing}
      </span>
    ) : null,
    r.streak > 1 ? <span key="streak">{msg('{0} clean in a row', r.streak)}</span> : null,
    ladder ? (
      <span key="ladder" data-testid="ladder-result">
        {ladder}
      </span>
    ) : null,
    r.targetReached ? <span key="goal">{msg('Goal reached. Repeat is off.')}</span> : null,
  ].filter((part) => part !== null)
  return (
    <div
      ref={rootRef}
      class={styles.resultCard}
      data-testid="attempt-result"
      data-passed={r.passed}
      data-tone={tone}
      data-phase={phase}
      data-expanded={open || undefined}
      data-preview={hasPreview || undefined}
      data-intro={(intro && hasPreview && !open) || undefined}
      data-opening={(open && !!opening) || undefined}
      data-layout={phone ? 'screen' : 'panel'}
      data-dimmed={dimmed || undefined}
      data-exit={exit ?? undefined}
      style={{
        '--result-open-duration': `${DETAILS_FOLD_MS}ms`,
        '--result-details-max': `${maxHeight}px`,
        '--result-preview-duration': `${RESULT_PREVIEW_MS}ms`,
      }}
      // Dimmed, the first tap only brings the pill back: its controls do not act on it.
      onClickCapture={(event) => {
        const dragged = skipClick.current
        if (dragged && event.detail > 0 && event.target instanceof Node && dragged.contains(event.target)) {
          clearSkip()
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (!dimmed) return
        event.preventDefault()
        event.stopPropagation()
        onRestore()
      }}
      onFocusIn={onRestore}
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
          aria-label={msg('Details of this pass')}
          inert={unfold === 'leaving' || undefined}
          data-testid="result-details"
          data-layout={phone ? 'screen' : 'panel'}
          data-tone={tone}
          data-phase={unfold}
        >
          {phone ? (
            <header class={styles.screenHeader} data-testid="result-screen-header" {...swipe}>
              <button
                ref={hide}
                type="button"
                class={styles.screenBack}
                aria-label={msg('Hide details')}
                title={msg('Hide details')}
                data-testid="result-details-hide"
                onClick={onToggle}
              >
                <Icon name="down" size={24} />
              </button>
              <h2 class={styles.screenTitle}>
                <span>{resultTitle(r)}</span>
                {dots !== null ? (
                  <span
                    class={styles.resultGoal}
                    role="img"
                    aria-label={msg('{0} of {1} clean toward the goal', filled, dots)}
                  >
                    {Array.from({ length: dots }, (_, i) => (
                      <span key={i} class={styles.resultDot} data-on={i < filled || undefined} />
                    ))}
                  </span>
                ) : null}
              </h2>
              {showAgain ? (
                <Button variant="primary" icon="restart" class={styles.resultAgain} onClick={onRestart}>
                  {msg('Again')}
                </Button>
              ) : null}
              <button
                type="button"
                class={styles.resultIconButton}
                aria-label={msg('Hide result')}
                title={msg('Hide')}
                onClick={onDismiss}
              >
                <Icon name="close" size={20} />
              </button>
            </header>
          ) : null}
          {details}
        </section>
      ) : null}
      {open && opening && !phone ? (
        // The edges the growing card's clips cut, drawn while it grows (`resultMotion.ts`).
        <div ref={outline} class={styles.resultOutline} aria-hidden="true">
          {(['tl', 'tr', 'bl', 'br', 'l', 'r'] as const).map((edge) => (
            <span key={edge} data-edge={edge} />
          ))}
        </div>
      ) : null}
      <div
        ref={row}
        class={styles.result}
        role="status"
        inert={full || phase === 'leaving' || undefined}
        data-expandable={hasDetails || undefined}
        {...swipe}
      >
        <div class={styles.resultSummary}>
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
                <span
                  class={styles.resultGoal}
                  role="img"
                  aria-label={msg('{0} of {1} clean toward the goal', filled, dots)}
                >
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
                {msg('Again')}
              </Button>
            ) : null}
            {hasDetails ? (
              <button
                ref={toggleRef}
                type="button"
                class={open ? styles.resultDetailsButton : styles.resultSurface}
                aria-expanded={expanded}
                aria-controls={expanded ? detailsId : undefined}
                aria-label={expanded ? msg('Hide details') : msg('Show details of this pass')}
                title={expanded ? msg('Hide details') : undefined}
                data-testid="result-details-toggle"
                onClick={onToggle}
              >
                {open ? (
                  <>
                    <Icon name="down" size={20} />
                    <span class={styles.resultDetailsLabel} aria-hidden="true">
                      {msg('Details')}
                    </span>
                  </>
                ) : (
                  <span class={styles.resultLift} aria-hidden="true">
                    <Icon name="up" size={20} />
                  </span>
                )}
              </button>
            ) : null}
            <button
              type="button"
              class={styles.resultIconButton}
              aria-label={msg('Hide result')}
              title={msg('Hide')}
              onClick={onDismiss}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        </div>
        {hasPreview && !open ? (
          <ul class={styles.resultPreview} data-testid="result-details-preview" aria-hidden="true">
            {passFacts(r, goal)
              .slice(0, r.timing || r.completionTimeSec === null ? 2 : 3)
              .map((line) => (
                <li key={line}>{line}</li>
              ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
