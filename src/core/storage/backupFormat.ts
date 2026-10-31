/**
 * The backup format's constants and shapes, kept free of the zip code so the library view can
 * name a file and read a manifest without loading it (the zip layer is a lazily imported chunk).
 */
export const BACKUP_FORMAT = 'pianissimo-backup'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_EXTENSION = '.pianissimo.zip'

export interface BackupCounts {
  readonly pieces: number
  readonly packages: number
  readonly sources: number
  readonly attempts: number
  readonly measureHistory: number
  readonly suggestionState: number
  readonly abandonEvents: number
  /** 1 when the backup carries settings. */
  readonly settings: number
}

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT
  readonly formatVersion: number
  readonly appVersion: string
  readonly createdAt: number
  readonly dbVersion: number
  readonly counts: BackupCounts
}

/** `pianissimo-2026-10-28.pianissimo.zip` (local date). */
export function backupFileName(now: number = Date.now()): string {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `pianissimo-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${BACKUP_EXTENSION}`
}
