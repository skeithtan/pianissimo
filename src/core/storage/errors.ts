export type BackupErrorCode =
  /** The file is not a Pianissimo backup at all. */
  | 'not-a-backup'
  /** Written by a newer backup format than this app reads. */
  | 'unsupported-version'
  /** Truncated, corrupted or inconsistent. */
  | 'damaged'
  /** Readable, but records do not have the expected shape; see `problems`. */
  | 'invalid'
  | 'too-large'

/** A restore failure with a message fit to show the player. Nothing was written. */
export class BackupError extends Error {
  readonly code: BackupErrorCode
  /** Specific record problems, at most `MAX_PROBLEMS`. */
  readonly problems: readonly string[]

  constructor(code: BackupErrorCode, message: string, problems: readonly string[] = []) {
    super(message)
    this.name = 'BackupError'
    this.code = code
    this.problems = problems
  }
}

export const MAX_PROBLEMS = 20
