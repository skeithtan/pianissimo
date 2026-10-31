import type { Hand } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'

/**
 * What a highlighted key shows (DECISIONS U15), strongest first when a key is several things:
 * - `wrong`: held, and it was a wrong attack;
 * - `target`: required in the current group, not played yet;
 * - `accepted`: required and already played correctly (kept after release);
 * - `sounding`: app playback (Listen, the accompaniment) is sounding it;
 * - `held`: physically held, none of the above.
 */
export type GuideKeyState = 'wrong' | 'target' | 'accepted' | 'sounding' | 'held'

/** One highlighted key of the 88-key guide. */
export interface GuideKey {
  /** Sounding MIDI note (ottava already resolved). */
  readonly midi: number
  readonly state: GuideKeyState
  /** Part color of the bar; null draws a neutral bar (no hand, a unison between hands, a key the score does not have). */
  readonly hand: Hand | null
  /** Note name, already formatted with the naming settings; shown above the key. */
  readonly label: string
  /** Physically held right now (a dot near the bottom of the key). */
  readonly held: boolean
}

export interface KeyboardGuideProps {
  /** The highlighted keys, any order; every other key is drawn plain. */
  readonly keys: readonly GuideKey[]
  /** Marked arpeggio direction of the current group: 'up' rolls low to high. */
  readonly rollDirection?: 'up' | 'down' | undefined
  /** Fades the whole guide in and out over `fadeMs`. Default true. */
  readonly visible?: boolean | undefined
  /** Fade duration in ms (default 300, from `HintSettings.fadeMs`). */
  readonly fadeMs?: number | undefined
  /** Naming preferences for the octave landmarks (C1…C8). Defaults to the spec defaults. */
  readonly naming?: NamingSettings | undefined
  readonly class?: string | undefined
}
