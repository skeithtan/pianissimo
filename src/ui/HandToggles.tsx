/**
 * Hand selection as two hand toggles around the primary Start/Pause button (spec "Listening and
 * hand practice"): an *on* hand is played by the learner, an *off* hand is played by the piano,
 * and with both off the app is in Listen mode and the piano plays everything (DECISIONS U4, U9).
 * There is no caption (U12): `aria-pressed`, the L / R badge, the tooltip and the main button's
 * label (Start / Listen) say what the selection means. Without a connected piano the hands are
 * unavailable (`handsUnavailable`): both toggles show off, and a tap explains instead of toggling.
 */
import type { HandSelection } from '../core/model/score'
import { Icon } from './icons'
import styles from './HandToggles.module.css'

type Hand = 'left' | 'right'

/** Whether the learner plays `hand` under `selection`. */
export function handIsOn(selection: HandSelection, hand: Hand): boolean {
  return selection === 'both' || selection === hand
}

/** Selection for a pair of toggle states: both -> both, one -> that hand, none -> Listen. */
export function handsFromToggles(left: boolean, right: boolean): HandSelection {
  if (left && right) return 'both'
  if (left) return 'left'
  if (right) return 'right'
  return 'none'
}

/** Default label of the primary button: Pause while running, Listen with both hands off, otherwise Start. */
export function playButtonLabel(selection: HandSelection, playing: boolean): string {
  if (playing) return 'Pause'
  return selection === 'none' ? 'Listen' : 'Start'
}

export interface HandTogglesProps {
  readonly hands: HandSelection
  readonly onHandsChange: (hands: HandSelection) => void
  readonly playing: boolean
  readonly onPlayPause: () => void
  /** Overrides the default Start / Pause / Listen label (also the accessible name). */
  readonly playLabel?: string
  readonly handsDisabled?: boolean
  /**
   * Why no hand can be chosen now ("Piano not connected"): both toggles show off and unavailable
   * (`aria-disabled`, still tappable; the text is their tooltip) and a tap calls
   * `onHandsUnavailable` instead of changing the selection.
   */
  readonly handsUnavailable?: string | undefined
  readonly onHandsUnavailable?: (() => void) | undefined
  readonly playDisabled?: boolean
  /** Extra class on the two hand toggles (the Practice view fades them while playing). */
  readonly handClass?: string | undefined
}

function HandToggle({
  hand,
  on,
  disabled,
  unavailable,
  extraClass,
  onToggle,
  onUnavailable,
}: {
  hand: Hand
  on: boolean
  disabled: boolean | undefined
  unavailable: string | undefined
  extraClass: string | undefined
  onToggle: () => void
  onUnavailable: (() => void) | undefined
}) {
  const name = hand === 'left' ? 'Left hand' : 'Right hand'
  const blocked = unavailable !== undefined
  return (
    <button
      type="button"
      class={[styles.hand, hand === 'left' ? styles.left : styles.right, extraClass].filter(Boolean).join(' ')}
      aria-pressed={blocked ? false : on}
      aria-disabled={blocked || undefined}
      aria-label={name}
      title={`${name}: ${blocked ? unavailable : on ? 'you play it' : 'the piano plays it'}`}
      disabled={disabled}
      onClick={blocked ? onUnavailable : onToggle}
    >
      <Icon name={hand === 'left' ? 'handLeft' : 'hand'} size={30} />
      <span class={styles.letter} aria-hidden="true">
        {hand === 'left' ? 'L' : 'R'}
      </span>
    </button>
  )
}

/** Centered transport cluster: [left hand] [Start / Pause] [right hand]. */
export function HandToggles({
  hands,
  onHandsChange,
  playing,
  onPlayPause,
  playLabel,
  handsDisabled,
  handsUnavailable,
  onHandsUnavailable,
  playDisabled,
  handClass,
}: HandTogglesProps) {
  const left = handIsOn(hands, 'left')
  const right = handIsOn(hands, 'right')
  const label = playLabel ?? playButtonLabel(hands, playing)
  return (
    <div class={styles.row}>
      <HandToggle
        hand="left"
        on={left}
        disabled={handsDisabled}
        unavailable={handsUnavailable}
        extraClass={handClass}
        onToggle={() => onHandsChange(handsFromToggles(!left, right))}
        onUnavailable={onHandsUnavailable}
      />
      <button
        type="button"
        class={styles.play}
        aria-label={label}
        title={label}
        disabled={playDisabled}
        onClick={onPlayPause}
      >
        <Icon name={playing ? 'pause' : 'play'} size={32} />
      </button>
      <HandToggle
        hand="right"
        on={right}
        disabled={handsDisabled}
        unavailable={handsUnavailable}
        extraClass={handClass}
        onToggle={() => onHandsChange(handsFromToggles(left, !right))}
        onUnavailable={onHandsUnavailable}
      />
    </div>
  )
}
