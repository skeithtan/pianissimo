/**
 * Input, expansion and processing limits (spec: "Validate MusicXML and compressed input with
 * file-size, expansion, and processing limits"). Sized for the reference tablet (an older iPad): a long piano score is a
 * few megabytes of XML; anything far beyond these bounds is refused before it is expanded.
 */
export interface ImportLimits {
  /** Bytes of the picked file (compressed or not). */
  readonly maxInputBytes: number
  /** Decoded characters of one MusicXML document. */
  readonly maxXmlChars: number
  /** Elements in one parsed document. */
  readonly maxElements: number
  /** Entries listed in a compressed archive. */
  readonly maxZipEntries: number
  /** Uncompressed bytes of one archive entry we expand. */
  readonly maxZipEntryBytes: number
  /** Uncompressed bytes of all entries we expand from one archive. */
  readonly maxZipTotalBytes: number
  /** Uncompressed ÷ compressed size; checked for entries above `zipRatioMinBytes`. */
  readonly maxZipRatio: number
  readonly zipRatioMinBytes: number
  /** Scores offered from one file (several rootfiles or an opus). */
  readonly maxCandidates: number
  readonly maxOpusDepth: number
  readonly maxMeasures: number
  readonly maxNotes: number
  /** Measure occurrences after unfolding repeats. */
  readonly maxOccurrences: number
}

const MiB = 1024 * 1024

export const DEFAULT_IMPORT_LIMITS: ImportLimits = Object.freeze({
  maxInputBytes: 32 * MiB,
  maxXmlChars: 64 * MiB,
  maxElements: 4_000_000,
  maxZipEntries: 2000,
  maxZipEntryBytes: 64 * MiB,
  maxZipTotalBytes: 96 * MiB,
  maxZipRatio: 100,
  zipRatioMinBytes: 1 * MiB,
  maxCandidates: 64,
  maxOpusDepth: 4,
  maxMeasures: 10_000,
  maxNotes: 300_000,
  maxOccurrences: 20_000,
})

export function resolveLimits(partial?: Partial<ImportLimits>): ImportLimits {
  return partial ? { ...DEFAULT_IMPORT_LIMITS, ...partial } : DEFAULT_IMPORT_LIMITS
}
