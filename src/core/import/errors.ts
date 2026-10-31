/**
 * Import failures. Every failure carries a stable `code` and a message written for the
 * person importing the file (spec: "Malformed XML, damaged compressed files, and unsupported
 * score structures must produce readable diagnostics").
 */
import type { Diagnostic } from '../model/score'

export type ImportErrorCode =
  | 'file-empty'
  | 'file-too-large'
  | 'unsupported-format'
  | 'not-musicxml'
  | 'xml-malformed'
  | 'xml-encoding'
  | 'xml-entity-declaration'
  | 'xml-too-large'
  | 'mxl-damaged'
  | 'mxl-limits'
  | 'mxl-no-container'
  | 'mxl-rootfile-missing'
  | 'mxl-no-score'
  | 'opus-external'
  | 'score-structure'
  | 'score-too-large'
  | 'selection-invalid'
  | 'no-source'
  | 'canceled'
  | 'internal'

export class ImportError extends Error {
  readonly code: ImportErrorCode
  readonly diagnostics: readonly Diagnostic[]

  constructor(code: ImportErrorCode, message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message)
    this.name = 'ImportError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

/** Plain, structured-clone-safe form of an import failure (crosses the worker boundary). */
export interface ImportFailure {
  readonly code: ImportErrorCode
  readonly message: string
  readonly diagnostics: readonly Diagnostic[]
}

export function toImportFailure(err: unknown): ImportFailure {
  if (err instanceof ImportError) {
    return { code: err.code, message: err.message, diagnostics: err.diagnostics }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { code: 'internal', message: `Unexpected import failure: ${message}`, diagnostics: [] }
}

export function fromImportFailure(f: ImportFailure): ImportError {
  return new ImportError(f.code, f.message, f.diagnostics)
}
