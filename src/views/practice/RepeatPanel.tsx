/**
 * Repeat mode's loop controls (spec "Repeating passages", DECISIONS U10, U14, U22): a slim group
 * that floats at the top of the score while Repeat mode is open — "Loop start" / "Loop end"
 * steppers (one whole bar per press), the consecutive-pass target, the speed ladder (a goal speed;
 * each met target raises Speed one 5% step until the goal) and an icon-only clear action. The strip's handles (which
 * can set note-level edges) and ✕ edit the same loop; the overview row shows it. Without Repeat
 * mode nothing here exists.
 */
import { LADDER_STEP, type LadderUi, type PracticeSession } from '../../app/session'
import { barLabel } from '../../core/engine'
import { edgeText } from '../../core/model/passage'
import type { PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { LoopSteppers } from '../../ui/LoopSteppers'
import { Icon } from '../../ui/icons'
import { SPEED_PRESETS_PERCENT, formatSpeedPercent } from '../../ui/speed'
import type { RecedeZone } from './recede'
import { useStoreValue } from './useStore'
import styles from './practice.module.css'

const TARGETS: readonly (number | null)[] = [null, 3, 5, 10]

/**
 * Goals the ladder select offers, in percent: the speed presets and 100%, those above the current
 * speed, plus the ladder's own goal while one is set (so the select can show it).
 */
export function ladderGoals(multiplier: number, goal: number | null): number[] {
  const current = Math.round(multiplier * 1000) / 10
  const set = new Set([...SPEED_PRESETS_PERCENT, 100].filter((p) => p > current + 1e-6))
  if (goal !== null) set.add(Math.round(goal * 1000) / 10)
  return [...set].sort((a, b) => a - b)
}

/** The panel's ladder status: "Ladder 60% → 100%" while climbing, "Goal reached" at the goal. */
export function ladderLine(ladder: LadderUi, multiplier: number): string {
  return ladder.done ? 'Goal reached' : `Ladder ${formatSpeedPercent(multiplier)} → ${formatSpeedPercent(ladder.goal)}`
}

export interface RepeatPanelProps {
  readonly session: PracticeSession
  readonly model: ScoreModel
  readonly loop: PassageRange | null
  /** Hands whose notes the note steps and the edge texts count. */
  readonly hands: HandSelection
  readonly repeatTarget: number | null
  /** The current speed (multiplier). */
  readonly multiplier: number
  /** The speed ladder, or null when off. */
  readonly ladder: LadderUi | null
  /** The bar being browsed in the strip, or null (the steppers then act on the cursor's bar). */
  readonly browsedOcc: number | null
  readonly zone: RecedeZone
  /** Repeat mode just closed: the panel sinks away before it unmounts (U14). */
  readonly leaving?: boolean
}

export function RepeatPanel({
  session,
  model,
  loop,
  hands,
  repeatTarget,
  multiplier,
  ladder,
  browsedOcc,
  zone,
  leaving,
}: RepeatPanelProps) {
  const currentOcc = useStoreValue(session.progress, (p) => p.occ)
  return (
    <div class={styles.repeatZone} {...zone}>
      <div
        class={`${styles.repeatPanel} ${styles.recedes}`}
        role="group"
        aria-label="Repeat passage"
        data-testid="repeat-controls"
        data-leaving={leaving || undefined}
      >
        <LoopSteppers
          loop={loop}
          currentOcc={browsedOcc ?? currentOcc}
          lastOcc={model.occurrences.length - 1}
          onLoopChange={(range) => session.setSelection({ range })}
          barLabel={(occ) => `Bar ${barLabel(model, occ)}`}
          edgeLabel={(range, edge) => edgeText(model, range, edge, hands)}
        />
        <div class={styles.repeatActions}>
          <label class={styles.selectWrap}>
            <span class="visually-hidden">Repeat until</span>
            <select
              class={styles.select}
              value={repeatTarget === null ? '' : String(repeatTarget)}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value
                session.setRepeatTarget(v === '' ? null : Number(v))
              }}
            >
              {TARGETS.map((t) => (
                <option key={String(t)} value={t === null ? '' : String(t)}>
                  {t === null ? 'Repeat: no limit' : `Until ${t} clean in a row`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            class={styles.iconButton}
            aria-label="Clear loop"
            title="Clear loop"
            onClick={() => session.setSelection({ range: null })}
          >
            <Icon name="close" size={22} />
          </button>
        </div>
        <div class={styles.ladder}>
          <label class={styles.selectWrap}>
            <span class="visually-hidden">Speed ladder</span>
            <select
              class={styles.select}
              data-testid="ladder-select"
              value={ladder ? String(Math.round(ladder.goal * 1000) / 10) : ''}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value
                session.setLadder(v === '' ? null : { goal: Number(v) / 100, step: LADDER_STEP })
              }}
            >
              <option value="">Ladder: off</option>
              {ladderGoals(multiplier, ladder?.goal ?? null).map((p) => (
                <option key={p} value={String(p)}>
                  {`Ladder to ${p}%`}
                </option>
              ))}
            </select>
          </label>
          {ladder ? (
            <span class={styles.ladderLine} data-testid="ladder-line" data-done={ladder.done || undefined}>
              {ladderLine(ladder, multiplier)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
