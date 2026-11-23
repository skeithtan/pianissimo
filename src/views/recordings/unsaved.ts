import { signal } from '@preact/signals'
import type { RecordingInfo, RecordingFiles } from '../../core/recording/records'
export interface SavedTake {
  info: RecordingInfo
  files: RecordingFiles
}

// Keep a finished take downloadable and retryable even if the database is full.
export const unsaved = new Map<string, SavedTake>()

/** The take deleted last, in any list of takes: its pill goes with it. */
export const deletedTake = signal<string | null>(null)
