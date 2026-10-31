/**
 * Repeat mode's loop controls (spec "Repeating passages", DECISIONS U10, U14, U22): a slim group
 * that floats at the top of the score while Repeat mode is open — "Loop start" / "Loop end"
 * steppers (one whole bar per press) and the consecutive-pass target. The strip's handles (which
 * can set note-level edges) and ✕ edit the same loop; the overview row shows it. Without Repeat
 * mode nothing here exists.
 */
import type { PracticeSession } from '../../app/session'
import { barLabel } from '../../core/engine'
import { edgeText } from '../../core/model/passage'
import type { PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { LoopSteppers } from '../../ui/LoopSteppers'
import type { RecedeZone } from './recede'
import { useStoreValue } from './useStore'
import styles from './practice.module.css'

const TARGETS: readonly (number | null)[] = [null, 3, 5, 10]

export interface RepeatPanelProps {
  readonly session: PracticeSession
  readonly model: ScoreModel
  readonly loop: PassageRange | null
  /** Hands whose notes the note steps and the edge texts count. */
  readonly hands: HandSelection
  readonly repeatTarget: number | null
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
      </div>
    </div>
  )
}
