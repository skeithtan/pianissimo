import type { RecordingInfo, RecordingFiles } from '../../core/recording/records'
export interface SavedTake {
  info: RecordingInfo
  files: RecordingFiles
}

// Keep a finished take downloadable and retryable even if the database is full.
export const unsaved = new Map<string, SavedTake>()
