import type { NoteScore } from './performance'

export interface RecordingInfo {
  readonly id: string
  readonly pieceId: string
  readonly title: string
  readonly context: string
  readonly passage: string
  readonly hands: 'both' | 'left' | 'right'
  readonly createdAt: number
  readonly durationMs: number
  readonly input: string
  readonly score: NoteScore
  readonly interrupted: boolean
}

export interface RecordingFiles {
  readonly midi: Blob
  readonly audio: Blob
}
