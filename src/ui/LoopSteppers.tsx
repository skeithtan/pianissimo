import { msg } from '../i18n/messages'
/**
 * Loop edge steppers (DECISIONS U6, U22): one rounded selector, ‹ 12 › – ‹ 14 ›, where each
 * number has its own pair of chevrons. A chevron moves an edge to the previous or next barline;
 * the steppers are strictly whole-bar (an edge inside a bar, set with the strip's handles, first
 * snaps to its own barline). The rules live in `loopStep.ts`.
 *
 * The selector shows short edge text ("12", "12·3"): the caller puts a "Bars" label beside it
 * where there is room (U22, revised 15 November 2026). Each edge is a group named "Loop start" /
 * "Loop end" that also carries the full wording ("Bar 12, beat 3") as visually hidden text, so a
 * screen reader hears the whole edge. Every button is a 44 px target.
 */
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
   * Full text of one edge of a loop ("Bar 12, beat 3"), read by screen readers; default: the
   * edge's bar (`barLabel`). Used for note-level edges set with the strip's handles.
   */
  readonly edgeLabel?: (loop: LoopRange, edge: LoopEdge) => string
  /** Short visible text of one edge ("12", "12·3"); default: the bar number. */
  readonly shortLabel?: (loop: LoopRange, edge: LoopEdge) => string
  readonly disabled?: boolean
  /** Extra class on the selector (a phone lets it grow to the row's width). */
  readonly class?: string | undefined
}

const defaultBarLabel = (occ: number): string => msg('Bar {0}', occ + 1)

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
      aria-label={msg('Move {0} one bar {1}', title.toLowerCase(), dir < 0 ? msg('earlier') : msg('later'))}
      title={msg('One bar {0}', dir < 0 ? msg('earlier') : msg('later'))}
      disabled={!enabled}
      onClick={() => onStep(edge, dir)}
    >
      <Icon name={dir < 0 ? 'back' : 'forward'} size={18} />
    </button>
  )
}

function Group({
  edge,
  title,
  short,
  full,
  bars,
  onStep,
}: {
  edge: LoopEdge
  title: string
  short: string
  full: string
  bars: { earlier: boolean; later: boolean }
  onStep: (edge: LoopEdge, dir: StepDirection) => void
}) {
  return (
    <div class={styles.group} role="group" aria-label={title}>
      <StepButton edge={edge} title={title} dir={-1} enabled={bars.earlier} onStep={onStep} />
      <span class={styles.value} data-edge={edge}>
        <span aria-hidden="true">{short}</span>
        <span class="visually-hidden">{full}</span>
      </span>
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
  shortLabel,
  disabled,
  class: className,
}: LoopSteppersProps) {
  const bars = loopStepAvailability(loop, currentOcc, lastOcc)
  const onStep = (edge: LoopEdge, dir: StepDirection) => {
    const next = stepLoop(loop, edge, dir, currentOcc, lastOcc)
    if (next) onLoopChange(next)
  }
  const full = (edge: LoopEdge): string => {
    if (!loop) return msg('No loop')
    if (edgeLabel) return edgeLabel(loop, edge)
    return barLabel(edge === 'start' ? loop.fromOcc : loop.toOcc)
  }
  const short = (edge: LoopEdge): string => {
    if (!loop) return '–'
    if (shortLabel) return shortLabel(loop, edge)
    return String((edge === 'start' ? loop.fromOcc : loop.toOcc) + 1)
  }
  const on = (v: boolean): boolean => !disabled && v
  return (
    <div class={[styles.steppers, className].filter(Boolean).join(' ')}>
      <Group
        edge="start"
        title={msg('Loop start')}
        short={short('start')}
        full={full('start')}
        bars={{ earlier: on(bars.startEarlier), later: on(bars.startLater) }}
        onStep={onStep}
      />
      <span class={styles.dash} aria-hidden="true">
        –
      </span>
      <Group
        edge="end"
        title={msg('Loop end')}
        short={short('end')}
        full={full('end')}
        bars={{ earlier: on(bars.endEarlier), later: on(bars.endLater) }}
        onStep={onStep}
      />
    </div>
  )
}
