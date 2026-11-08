/**
 * Message protocol between the microphone follower's main-thread side (`app/audio/micFollower.ts`)
 * and its worker (`workers/follower.worker.ts`, logic in `workerHandler.ts`). Positions are exact
 * `Rational` whole notes inbound (structured-clone safe) and float whole notes outbound.
 */
import type { ScoreModel } from '../model/score'
import type { Rational } from '../music/rational'
import type { TempoMapData } from '../music/tempo'

export type FollowerRequest =
  /** A (new) follower for this score at this speed, following from `position` (null: the start). */
  | {
      readonly type: 'configure'
      readonly model: ScoreModel
      readonly tempo: TempoMapData
      readonly multiplier: number
      readonly position: Rational | null
    }
  /** Follow again from `position` (a seek, a resume). */
  | { readonly type: 'reset'; readonly position: Rational }
  /** Samples are ignored until `resume`. */
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  /** Mono samples from the microphone (any block size). */
  | { readonly type: 'samples'; readonly samples: Float32Array; readonly sampleRate: number }

export type FollowerResponse =
  /** The latest position estimate (float whole notes) and its confidence (0..1). */
  | { readonly type: 'estimate'; readonly position: number; readonly confidence: number }
  | { readonly type: 'error'; readonly message: string }
