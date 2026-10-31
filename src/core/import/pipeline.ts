/**
 * Import pipeline entry points, callable directly (tests, Node) or inside the import worker.
 *
 * 1. `inspectSource(file)` — detect the format, open the document(s) and list candidates
 *    (scores/movements with their parts) plus diagnostics. Throws `ImportError` with a readable
 *    message for unusable files.
 * 2. `buildScorePackage(file, selection)` — build the `ScoreModel`, the unfolded render XML, the
 *    import summary and the source record for one candidate and part selection.
 *
 * Both are stateless: the file bytes are passed to each call. Cancellation: `signal` is checked
 * between stages (the worker client terminates the worker instead).
 */
import { IMPORTER_VERSION, type Diagnostic, type ScorePackage, type SourceFileRecord } from '../model/score'
import { buildScore } from './build'
import { describeDocument, type ImportCandidate } from './candidates'
import { DiagnosticSink } from './diagnostics'
import { ImportError } from './errors'
import { type ImportLimits, resolveLimits } from './limits'
import { openSource, type Packaging } from './source'
import { type ImportSummary, summarizeImport } from './summary'
import { scoreVersionId, sha256Hex } from './version'

export interface ImportFile {
  readonly name: string
  readonly bytes: ArrayBuffer | Uint8Array
}

export interface ImportSelection {
  /** `ImportCandidate.id`. */
  readonly candidate: string
  /** Selected part ids (one two-staff part, or two one-staff parts). */
  readonly partIds: readonly string[]
}

export interface InspectResult {
  readonly fileName: string
  readonly packaging: Packaging
  readonly candidates: readonly ImportCandidate[]
  readonly diagnostics: readonly Diagnostic[]
  readonly importerVersion: string
}

export interface BuildResult {
  readonly package: ScorePackage
  readonly summary: ImportSummary
  readonly source: SourceFileRecord
}

export type ImportStage =
  | 'reading'
  | 'parsing'
  | 'measures'
  | 'repeats'
  | 'notes'
  | 'tempo'
  | 'ottavas'
  | 'hands'
  | 'context'
  | 'render'
  | 'hashing'
  | 'done'

export interface PipelineOptions {
  readonly limits?: Partial<ImportLimits>
  readonly signal?: AbortSignal
  readonly onProgress?: (stage: ImportStage, fraction: number) => void
  /** Clock for `meta.importedAt` (ms since epoch). */
  readonly now?: () => number
}

function asBytes(b: ArrayBuffer | Uint8Array): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b)
}

function asArrayBuffer(b: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (!(b instanceof Uint8Array)) return b
  if (b.buffer instanceof ArrayBuffer && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) return b.buffer
  const copy = new Uint8Array(b.byteLength)
  copy.set(b)
  return copy.buffer
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportError('canceled', 'The import was canceled.')
}

function baseName(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Open a file and list its candidates (see module doc). */
export async function inspectSource(file: ImportFile, options: PipelineOptions = {}): Promise<InspectResult> {
  const limits = resolveLimits(options.limits)
  const progress = options.onProgress ?? (() => {})
  checkAborted(options.signal)
  progress('reading', 0)
  const diag = new DiagnosticSink()
  const opened = openSource(asBytes(file.bytes), file.name, limits, diag)
  checkAborted(options.signal)
  progress('parsing', 0.6)
  const candidates = opened.documents.map((doc) => describeDocument(doc, baseName(file.name), diag))
  progress('done', 1)
  return {
    fileName: file.name,
    packaging: opened.packaging,
    candidates,
    diagnostics: diag.list(),
    importerVersion: IMPORTER_VERSION,
  }
}

/** Build the score package for one candidate and part selection (see module doc). */
export async function buildScorePackage(
  file: ImportFile,
  selection: ImportSelection,
  options: PipelineOptions = {},
): Promise<BuildResult> {
  const limits = resolveLimits(options.limits)
  const progress = options.onProgress ?? (() => {})
  const signal = options.signal
  checkAborted(signal)
  progress('reading', 0)
  const bytes = asBytes(file.bytes)
  const diag = new DiagnosticSink()
  const opened = openSource(bytes, file.name, limits, diag, selection.candidate)
  const doc = opened.documents.find((d) => d.id === selection.candidate)
  if (!doc) throw new ImportError('selection-invalid', `The file has no score “${selection.candidate}”.`)
  checkAborted(signal)
  progress('hashing', 0.05)
  const sha256 = await sha256Hex(bytes)
  const versionId = await scoreVersionId(sha256, doc.entry, [...selection.partIds].sort())
  checkAborted(signal)
  const built = buildScore({
    doc,
    packaging: opened.packaging,
    fileName: file.name,
    partIds: selection.partIds,
    scoreVersionId: versionId,
    importedAt: (options.now ?? Date.now)(),
    limits,
    diag,
    progress: (stage, fraction) => {
      checkAborted(signal)
      progress(stage as ImportStage, 0.1 + 0.85 * fraction)
    },
  })
  checkAborted(signal)
  const summary = summarizeImport(built.model)
  progress('done', 1)
  return {
    package: { model: built.model, renderXml: built.renderXml },
    summary,
    source: { fileName: file.name, packaging: opened.packaging, bytes: asArrayBuffer(file.bytes), sha256 },
  }
}
