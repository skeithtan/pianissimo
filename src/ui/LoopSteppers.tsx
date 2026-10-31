/**
 * Loop edge steppers: "Loop start" and "Loop end", each with one-bar steps (DECISIONS U6, U22):
 * [‹] value [›]. A chevron moves an edge to the previous or next barline; the steppers are
 * strictly whole-bar (an edge inside a bar, set with the strip's handles, first snaps to its own
 * barline). The rules live in `loopStep.ts`. Optional `children` sit between the two groups
 * (e.g. the passage summary). Every button is a 44 px target.
 */
import type { ComponentChildren } from 'preact'
import { Icon } from './icons'
import { loopStepAvailability, stepLoop, type LoopEdge, type LoopRange, type StepDirection } from './loopStep'
import styles from './LoopSteppers.module.css'

export interface LoopSteppersProps {
  /** Current loop, or null when none exists yet. */
  readonly loop: LoopRange | null
  /** The bar under the cursor line in the current view (the browse position while inspecting). */
  readonly currentOcc: number
  /** Last bar (occurrence index) of the unfolded piece. */
  readonly lastOcc: number
  readonly onLoopChange: (loop: LoopRange) => void
  /** Bar text for an occurrence, e.g. "Bar 12" or "Bar 12 (pass 2)". Default "Bar n". */
  readonly barLabel?: (occ: number) => string
  /**
   * Text of one edge of a loop ("Bar 12, beat 3"); default: the edge's bar (`barLabel`). Used for
   * note-level edges set with the strip's handles.
   */
  readonly edgeLabel?: (loop: LoopRange, edge: LoopEdge) => string
  readonly disabled?: boolean
  /** Shown between the two groups. */
  readonly children?: ComponentChildren
}

const defaultBarLabel = (occ: number): string => `Bar ${occ + 1}`

function StepButton({
  edge,
  title,
  dir,
  enabled,
  onStep,
}: {
  edge: LoopEdge
  title: string
  dir: StepDirection
  enabled: boolean
  onStep: (edge: LoopEdge, dir: StepDirection) => void
}) {
  return (
    <button
      type="button"
      class={styles.step}
      aria-label={`Move ${title.toLowerCase()} one bar ${dir < 0 ? 'earlier' : 'later'}`}
      title={`One bar ${dir < 0 ? 'earlier' : 'later'}`}
      disabled={!enabled}
      onClick={() => onStep(edge, dir)}
    >
      <Icon name={dir < 0 ? 'back' : 'forward'} />
    </button>
  )
}

function Group({
  edge,
  title,
  value,
  bars,
  onStep,
}: {
  edge: LoopEdge
  title: string
  value: string
  bars: { earlier: boolean; later: boolean }
  onStep: (edge: LoopEdge, dir: StepDirection) => void
}) {
  return (
    <div class={styles.group} role="group" aria-label={title}>
      <StepButton edge={edge} title={title} dir={-1} enabled={bars.earlier} onStep={onStep} />
      <div class={styles.label}>
        <span class={styles.title}>{title}</span>
        <span class={styles.value}>{value}</span>
      </div>
      <StepButton edge={edge} title={title} dir={1} enabled={bars.later} onStep={onStep} />
    </div>
  )
}

export function LoopSteppers({
  loop,
  currentOcc,
  lastOcc,
  onLoopChange,
  barLabel = defaultBarLabel,
  edgeLabel,
  disabled,
  children,
}: LoopSteppersProps) {
  const bars = loopStepAvailability(loop, currentOcc, lastOcc)
  const onStep = (edge: LoopEdge, dir: StepDirection) => {
    const next = stepLoop(loop, edge, dir, currentOcc, lastOcc)
    if (next) onLoopChange(next)
  }
  const value = (edge: LoopEdge): string => {
    if (!loop) return 'No loop'
    if (edgeLabel) return edgeLabel(loop, edge)
    return barLabel(edge === 'start' ? loop.fromOcc : loop.toOcc)
  }
  const on = (v: boolean): boolean => !disabled && v
  return (
    <div class={styles.steppers}>
      <Group
        edge="start"
        title="Loop start"
        value={value('start')}
        bars={{ earlier: on(bars.startEarlier), later: on(bars.startLater) }}
        onStep={onStep}
      />
      {children}
      <Group
        edge="end"
        title="Loop end"
        value={value('end')}
        bars={{ earlier: on(bars.endEarlier), later: on(bars.endLater) }}
        onStep={onStep}
      />
    </div>
  )
}
