import { msg } from '../i18n/messages'
/**
 * Hand selection as two hand toggles around the primary Start/Pause button (spec "Listening and
 * hand practice", DECISIONS U4, U141): the hands that are *on* are the ones the learner plays or,
 * in Listen, hears. One hand always stays on: a tap on the only lit hand reports `onOnlyHand` and
 * changes nothing. There is no caption (U12): `aria-pressed`, the L / R badge and the tooltip
 * (`onText` / `offText`, the mode's words) say what the selection means.
 */
import type { LearnerHands } from '../core/model/score'
import { Icon } from './icons'
import styles from './HandToggles.module.css'

type Hand = 'left' | 'right'

/** Whether `hand` is on under `selection`. */
export function handIsOn(selection: LearnerHands, hand: Hand): boolean {
  return selection === 'both' || selection === hand
}

/** The selection after a tap on `hand`, or null when it is the only one on (it stays on). */
export function toggledHands(selection: LearnerHands, hand: Hand): LearnerHands | null {
  if (selection === 'both') return hand === 'left' ? 'right' : 'left'
  return selection === hand ? null : 'both'
}

export interface HandTogglesProps {
  readonly hands: LearnerHands
  readonly onHandsChange: (hands: LearnerHands) => void
  /** A tap on the only lit hand, which stays on. */
  readonly onOnlyHand: () => void
  /** What a hand that is on / off means now ("you play it" / "the piano plays it"). */
  readonly onText: string
  readonly offText: string
  readonly playing: boolean
  readonly onPlayPause: () => void
  /** The main button's accessible name and tooltip (Start / Resume / Play / Pause). */
  readonly playLabel: string
  readonly handsDisabled?: boolean
  readonly playDisabled?: boolean
  /** Extra class on the two hand toggles (the Practice view fades them while playing). */
  readonly handClass?: string | undefined
  /** A phone's top bar (U80): 40 px hands (44 px hit area) around a 44 px button, not 58 and 68. */
  readonly compact?: boolean
}

function HandToggle({
  hand,
  on,
  text,
  disabled,
  extraClass,
  compact,
  onToggle,
}: {
  hand: Hand
  on: boolean
  text: string
  disabled: boolean | undefined
  extraClass: string | undefined
  compact: boolean
  onToggle: () => void
}) {
  const name = hand === 'left' ? msg('Left hand') : msg('Right hand')
  return (
    <button
      type="button"
      class={[styles.hand, hand === 'left' ? styles.left : styles.right, extraClass].filter(Boolean).join(' ')}
      aria-pressed={on}
      aria-label={name}
      title={msg('{0}: {1}', name, text)}
      disabled={disabled}
      onClick={onToggle}
    >
      <Icon name={hand === 'left' ? 'handLeft' : 'hand'} size={compact ? 22 : 30} />
      <span class={styles.letter} aria-hidden="true">
        {hand === 'left' ? msg('L') : msg('R')}
      </span>
    </button>
  )
}

/** Centered transport cluster: [left hand] [Start / Pause] [right hand]. */
export function HandToggles({
  hands,
  onHandsChange,
  onOnlyHand,
  onText,
  offText,
  playing,
  onPlayPause,
  playLabel,
  handsDisabled,
  playDisabled,
  handClass,
  compact = false,
}: HandTogglesProps) {
  const toggle = (hand: Hand) => {
    const on = handIsOn(hands, hand)
    return (
      <HandToggle
        hand={hand}
        on={on}
        text={on ? onText : offText}
        disabled={handsDisabled}
        extraClass={handClass}
        compact={compact}
        onToggle={() => {
          const next = toggledHands(hands, hand)
          if (next) onHandsChange(next)
          else onOnlyHand()
        }}
      />
    )
  }
  return (
    <div class={compact ? `${styles.row} ${styles.compact}` : styles.row}>
      {toggle('left')}
      <button
        type="button"
        class={styles.play}
        aria-label={playLabel}
        title={playLabel}
        disabled={playDisabled}
        onClick={onPlayPause}
      >
        <Icon name={playing ? 'pause' : 'play'} size={compact ? 24 : 32} />
      </button>
      {toggle('right')}
    </div>
  )
}
