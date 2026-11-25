import type { PassageRange } from '../model/practice'
import type { NoteScore } from './performance'

export interface RecordingInfo {
  readonly id: string
  readonly pieceId: string
  readonly title: string
  readonly context: string
  /**
   * The passage in words, in the interface language of the moment the take was recorded. Shown
   * only when the label cannot be rebuilt: takes without `passageRange`, or whose score is gone.
   */
  readonly passage: string
  /**
   * The passage the take recorded (null = the whole piece). Its label is formatted when shown, in
   * the current interface language. Absent on takes saved before labels were rebuilt.
   */
  readonly passageRange?: PassageRange | null
  readonly hands: 'both' | 'left' | 'right'
  readonly createdAt: number
  /** Minutes east of UTC when capture started. Earlier recordings were named in UTC. */
  readonly startUtcOffsetMinutes?: number
  readonly durationMs: number
  readonly input: string
  readonly score: NoteScore
  readonly interrupted: boolean
  /** Played from the opening of the passage to its ending. Absent on takes saved before it was stored. */
  readonly playedThrough?: boolean
  /** Discarded then, and still to be removed: no list, summary or backup holds it. Undo clears it. */
  readonly discardedAt?: number
}

export interface RecordingFiles {
  readonly midi: Blob
  readonly audio: Blob
}
