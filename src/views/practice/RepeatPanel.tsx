import { msg, percentage } from '../../i18n/messages'
/**
 * Repeat mode's loop controls (spec "Repeating passages"; DECISIONS U10, U14, U22, U61, U77,
 * revised 15 November 2026). Two clusters, which bars and what goal, plus an always-visible exit:
 *
 *  - `float` (tablets and desktops): "Bars", the passage selector ‹ 12 › – ‹ 14 ›, a goal button
 *    whose label sums up the goal ("Until 3 clean | 60% → 100%") and opens the options as a
 *    popover, then ✕. It floats at the top of the score and recedes while playing.
 *  - `compact` (a phone on its side): the selector, ⋯ (options) and ✕, floating over the score;
 *    it recedes while playing and a tap on the screen brings it back, like the other chrome.
 *  - `docked` (an upright phone): the same three in a row of their own under the overview; the
 *    practice screen folds that row away while playing.
 *
 * The options (`RepeatOptions`): Repeat until (No limit, 3, 5, 10 clean in a row) and the speed
 * ladder (100% by default, starting at 75% if already at or above 100%). Reaching the target
 * raises Speed by one step. On a phone the options open in a sheet. ✕ clears the loop and leaves
 * Repeat mode (U61). The strip's handles (which can set note-level edges) and ✕ edit the same
 * loop; the overview row shows it. Without Repeat mode nothing here exists.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  fullSpeedLadderStart,
  LADDER_DEFAULT_TARGET,
  LADDER_FULL_SPEED_GOAL,
  LADDER_STEP,
  type LadderUi,
  type PracticeSession,
} from '../../app/session'
import { barLabel } from '../../core/engine'
import { edgeShortText, edgeText } from '../../core/model/passage'
import type { PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { Segmented, Toggle } from '../../ui/controls'
import { useFadePresence } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { LoopSteppers } from '../../ui/LoopSteppers'
import { placePopover, type PopoverPlacement } from '../../ui/popoverPlacement'
import { SPEED_PRESETS_PERCENT, formatSpeedPercent } from '../../ui/speed'
import type { RecedeZone } from './recede'
import { useStoreValue } from './useStore'
import styles from './practice.module.css'

const TARGETS: readonly (number | null)[] = [null, 3, 5, 10]
const FULL_SPEED_PERCENT = LADDER_FULL_SPEED_GOAL * 100
/** Space between the goal button and its options, as close as an option menu's (px). */
const GOAL_MENU_GAP = 4

export type RepeatLayout = 'float' | 'compact' | 'docked'

/**
 * Always offer 100%. Other presets must be above the current speed, except for the saved goal
 * so it stays visible while selected.
 */
export function ladderGoals(multiplier: number, goal: number | null): number[] {
  const current = Math.round(multiplier * 1000) / 10
  const set = new Set(SPEED_PRESETS_PERCENT.filter((p) => p === FULL_SPEED_PERCENT || p > current + 1e-6))
  if (goal !== null) set.add(Math.round(goal * 1000) / 10)
  return [...set].sort((a, b) => a - b)
}

/** The ladder's summary on the goal button: "60% → 100%" while climbing, "Goal reached" at the goal. */
export function ladderLine(ladder: LadderUi, multiplier: number): string {
  return ladder.done ? msg('Goal reached') : `${formatSpeedPercent(multiplier)} → ${formatSpeedPercent(ladder.goal)}`
}

/** "Until 3 clean" or "No limit": the target half of the goal button. */
export function targetLine(target: number | null): string {
  return target === null ? msg('No limit') : msg('Until {0} clean', target)
}

/** The goal in words, for the options button's accessible name and the ladder note. */
export function goalWords(target: number | null, ladder: LadderUi | null, multiplier: number): string {
  const until = target === null ? msg('repeat with no limit') : msg('until {0} clean in a row', target)
  if (!ladder) return until
  return ladder.done
    ? msg('{0}; speed ladder goal reached', until)
    : msg('{0}; speed ladder {1} to {2}', until, formatSpeedPercent(multiplier), formatSpeedPercent(ladder.goal))
}

export interface RepeatOptionsProps {
  readonly session: PracticeSession
  readonly repeatTarget: number | null
  readonly multiplier: number
  readonly ladder: LadderUi | null
}

/** The goal settings, shared by the popover (tablets) and the phone's sheet. */
export function RepeatOptions({ session, repeatTarget, multiplier, ladder }: RepeatOptionsProps) {
  const goals = ladderGoals(multiplier, ladder?.goal ?? null)
  const defaultStart = fullSpeedLadderStart(multiplier)
  const goalValue = ladder ? String(Math.round(ladder.goal * 1000) / 10) : null
  const setGoal = (percent: number) => session.setLadder({ goal: percent / 100, step: LADDER_STEP })
  const passes = repeatTarget ?? LADDER_DEFAULT_TARGET
  return (
    <div class={styles.repeatOptions} data-testid="repeat-options">
      <div class={styles.optionBlock}>
        <span class={styles.optionLabel} aria-hidden="true">
          {msg('Repeat until · clean passes in a row')}
        </span>
        <Segmented
          label={msg('Repeat until')}
          value={repeatTarget === null ? 'none' : String(repeatTarget)}
          options={TARGETS.map((t) => ({
            value: t === null ? 'none' : String(t),
            label: t === null ? msg('No limit') : String(t),
            title: t === null ? msg('Repeat with no limit') : msg('Until {0} clean in a row', t),
          }))}
          onChange={(v) => session.setRepeatTarget(v === 'none' ? null : Number(v))}
        />
      </div>
      <div class={styles.optionDivider} />
      <div class={styles.optionBlock}>
        <Toggle
          label={msg('Speed ladder')}
          checked={ladder !== null}
          description={
            ladder ? '' : msg('Build up from {0} to 100% of the written tempo.', formatSpeedPercent(defaultStart))
          }
          onChange={(on) => (on ? setGoal(FULL_SPEED_PERCENT) : session.setLadder(null))}
        />
        {ladder ? (
          <>
            <div class={styles.optionRow}>
              <span class={styles.optionLabel} aria-hidden="true">
                {msg('Up to')}
              </span>
              <Segmented
                label={msg('Ladder goal')}
                value={goalValue}
                options={goals.map((p) => ({ value: String(p), label: percentage(p / 100) }))}
                onChange={(v) => {
                  if (v !== goalValue) setGoal(Number(v))
                }}
              />
            </div>
            <p class={styles.optionNote} data-testid="ladder-note">
              {ladder.done
                ? msg('Goal reached: {0}.', formatSpeedPercent(ladder.goal))
                : msg(
                    'Now {0}. Speed rises toward {1} after every {2} clean passes in a row.',
                    formatSpeedPercent(multiplier),
                    formatSpeedPercent(ladder.goal),
                    passes,
                  )}
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}

export interface RepeatPanelProps extends RepeatOptionsProps {
  readonly model: ScoreModel
  readonly loop: PassageRange | null
  /** Hands whose notes the edge texts count. */
  readonly hands: HandSelection
  /** The bar being browsed on the page, or null (the steppers then act on the cursor's bar, U151). */
  readonly browsedOcc: number | null
  readonly zone: RecedeZone
  readonly layout: RepeatLayout
  /** Starting playback closes the popover. The revealed button can reopen it. */
  readonly playing: boolean
  /** Phone layouts: open the options sheet (the practice screen owns it). */
  readonly onOpenOptions?: () => void
  /** The options sheet is open (phone layouts), for the ⋯ button's state. */
  readonly optionsOpen?: boolean
  /** Repeat mode just closed: the panel sinks away before it unmounts (U14). */
  readonly leaving?: boolean
}

/**
 * Drops the options from the goal button like an option menu: left edges aligned, just below
 * it (above when the stage has more room there), shifted and capped to stay inside the stage,
 * which clips it. It is measured again after every render and whenever the panel changes size:
 * a choice in the options can widen the goal button ("100% → 125%"), which moves it within the
 * centered panel, and the menu must stay on the button.
 */
function useStagePlacement(
  mounted: boolean,
  anchor: { current: HTMLElement | null },
  panel: { current: HTMLElement | null },
): PopoverPlacement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  const measure = useRef<() => void>(() => undefined)
  measure.current = () => {
    const a = anchor.current
    const el = panel.current
    const stage = a?.closest<HTMLElement>('[data-repeat-bounds]')
    if (!mounted || !a || !el || !stage) return
    const s = stage.getBoundingClientRect()
    const r = a.getBoundingClientRect()
    const next = placePopover({
      anchor: { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height },
      size: { width: el.offsetWidth, height: el.scrollHeight },
      viewport: { width: s.width, height: s.height },
      preferred: 'down',
      align: 'start',
      gap: GOAL_MENU_GAP,
    })
    setPlacement((prev) =>
      prev && prev.side === next.side && Math.abs(prev.left - next.left) < 0.5 && prev.maxHeight === next.maxHeight
        ? prev
        : next,
    )
  }
  // After every render: the button may have moved with what the options just changed.
  useLayoutEffect(() => {
    if (mounted) measure.current()
    else setPlacement(null)
  })
  useEffect(() => {
    if (!mounted) return undefined
    const again = () => measure.current()
    window.addEventListener('resize', again)
    const row = anchor.current?.closest('[data-testid="repeat-controls"]')
    const observer = typeof ResizeObserver === 'function' && row ? new ResizeObserver(again) : null
    if (observer && row) observer.observe(row)
    return () => {
      window.removeEventListener('resize', again)
      observer?.disconnect()
    }
  }, [mounted, anchor])
  return placement
}

function GoalPopover(
  props: RepeatOptionsProps & { readonly playing: boolean; readonly leaving?: boolean | undefined },
) {
  const { repeatTarget, multiplier, ladder, playing, leaving } = props
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const popover = useFadePresence(open && !leaving, 160)
  const fit = useStagePlacement(popover.mounted, trigger, panel)

  useEffect(() => {
    // Close on playback starting, while still allowing the revealed button to reopen the menu.
    if (playing || leaving) setOpen(false)
  }, [playing, leaving])
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  useEffect(() => {
    if (popover.phase === 'entering') panel.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
  }, [popover.phase])

  return (
    <div
      class={styles.goalWrap}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        class={styles.goalButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={msg('Repeat goal: {0}. Open repeat options', goalWords(repeatTarget, ladder, multiplier))}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="repeat" size={18} />
        <span data-testid="target-line">{targetLine(repeatTarget)}</span>
        {ladder ? (
          <>
            <span class={styles.goalDivider} aria-hidden="true" />
            <Icon name="ladder" size={18} />
            <span class={styles.goalLadder} data-testid="ladder-line" data-done={ladder.done || undefined}>
              {ladderLine(ladder, multiplier)}
            </span>
          </>
        ) : null}
        <span class={styles.goalChevron} data-open={open || undefined}>
          <Icon name="forward" size={14} />
        </span>
      </button>
      {popover.mounted ? (
        <div
          ref={panel}
          class={`${styles.goalPopover} ${fit?.side === 'up' ? styles.goalPopoverUp : ''}`}
          // WebKit focuses no switch or button it clicks: the press focuses the popover, so Escape
          // still reaches it.
          tabIndex={-1}
          role="dialog"
          aria-label={msg('Repeat options')}
          style={{
            ...popover.style,
            ...(fit ? { left: `${fit.left}px` } : {}),
            ...(fit?.maxHeight != null ? { maxHeight: `${fit.maxHeight}px` } : {}),
          }}
        >
          <RepeatOptions {...props} />
        </div>
      ) : null}
    </div>
  )
}

export function RepeatPanel(props: RepeatPanelProps) {
  const {
    session,
    model,
    loop,
    hands,
    repeatTarget,
    multiplier,
    ladder,
    browsedOcc,
    zone,
    layout,
    playing,
    onOpenOptions,
    optionsOpen,
    leaving,
  } = props
  const currentOcc = useStoreValue(session.progress, (p) => p.occ)
  const goalSet = repeatTarget !== null || ladder !== null
  const panel = (
    <div
      class={`${styles.repeatPanel} ${layout === 'docked' ? '' : styles.recedes}`}
      role="group"
      aria-label={msg('Repeat passage')}
      data-testid="repeat-controls"
      data-layout={layout}
      data-leaving={leaving || undefined}
    >
      {layout === 'float' ? (
        <span class={styles.barsLabel} aria-hidden="true">
          {msg('Bars')}
        </span>
      ) : null}
      <LoopSteppers
        class={styles.passage}
        loop={loop}
        currentOcc={browsedOcc ?? currentOcc}
        lastOcc={model.occurrences.length - 1}
        onLoopChange={(range) => session.setSelection({ range })}
        barLabel={(occ) => msg('Bar {0}', barLabel(model, occ))}
        edgeLabel={(range, edge) => edgeText(model, range, edge, hands)}
        shortLabel={(range, edge) => edgeShortText(model, range, edge, hands)}
      />
      {layout === 'float' ? (
        <GoalPopover
          session={session}
          repeatTarget={repeatTarget}
          multiplier={multiplier}
          ladder={ladder}
          playing={playing}
          leaving={leaving}
        />
      ) : (
        <button
          type="button"
          class={styles.moreButton}
          aria-haspopup="dialog"
          aria-expanded={optionsOpen ?? false}
          aria-label={msg('Repeat options: {0}', goalWords(repeatTarget, ladder, multiplier))}
          title={msg('Repeat options')}
          onClick={() => onOpenOptions?.()}
        >
          <Icon name="more" size={22} />
          {goalSet ? <span class={styles.moreDot} data-testid="repeat-goal-dot" aria-hidden="true" /> : null}
        </button>
      )}
      {layout === 'float' ? <span class={styles.exitDivider} aria-hidden="true" /> : null}
      <button
        type="button"
        class={styles.iconButton}
        aria-label={msg('Exit repeat')}
        title={msg('Exit repeat')}
        onClick={() => session.setSelection({ range: null })}
      >
        <Icon name="close" size={22} />
      </button>
    </div>
  )
  return layout === 'docked' ? (
    panel
  ) : (
    <div class={styles.repeatZone} data-layout={layout} {...zone}>
      {panel}
    </div>
  )
}
