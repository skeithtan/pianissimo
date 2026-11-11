/**
 * Message protocol between the microphone follower's main-thread side (`app/audio/micFollower.ts`)
 * and its worker (`workers/follower.worker.ts`, logic in `workerHandler.ts`). Positions are exact
 * `Rational` whole notes inbound (structured-clone safe) and float whole notes outbound.
 */
import type { ScoreModel } from '../model/score'
import type { Rational } from '../music/rational'

export type FollowerRequest =
  /** A (new) follower for this score, expecting the first group at or after `position` (null: the start). */
  | { readonly type: 'configure'; readonly model: ScoreModel; readonly position: Rational | null }
  /** Expect the first group at or after `position` next (a seek). */
  | { readonly type: 'reset'; readonly position: Rational }
  /** Samples are ignored until `resume`. */
  | { readonly type: 'pause' }
  /** Listen again; what sounded before the pause is forgotten. */
  | { readonly type: 'resume' }
  /** Mono samples from the microphone (any block size). */
  | { readonly type: 'samples'; readonly samples: Float32Array; readonly sampleRate: number }

export type FollowerResponse =
  /**
   * The player was heard at a new place: the position of the onset group struck last (float whole
   * notes) and how well the attack matched it (0..1). Posted only when it changes.
   */
  | { readonly type: 'estimate'; readonly position: number; readonly confidence: number }
  | { readonly type: 'error'; readonly message: string }
