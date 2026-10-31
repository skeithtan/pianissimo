/**
 * The import flow as a small state machine (spec "MusicXML score import", "Storage and
 * recovery", "Execution and rendering architecture"):
 *
 *   pick a file → read → inspect (worker, progress, Cancel) → choose score/parts when there is a
 *   choice (I8) → build (worker, progress, Cancel) → review the summary (hands, tempo) → save
 *   (`commitImport`, one transaction) → idle (the sheet closes; the caller opens Practice) while
 *   persistent storage is asked for once.
 *
 * Every asynchronous step carries the job token it started with; `cancel()` and `close()` bump
 * the token, so a canceled or superseded job never changes `phase` again (spec: a canceled job
 * produces no later UI mutations). The import client is disposed when the flow closes, which
 * terminates its worker and drops the retained file (spec "Import memory lifecycle").
 */
import { signal, type Signal } from '@preact/signals'
import type { ImportCandidate } from '../../core/import/candidates'
import type { ImportClient } from '../../core/import/client'
import { ImportError } from '../../core/import/errors'
import { DEFAULT_IMPORT_LIMITS } from '../../core/import/limits'
import type { BuildResult, ImportStage, InspectResult } from '../../core/import/pipeline'
import type { Diagnostic } from '../../core/model/score'
import {
  estimateStorage,
  isQuotaError,
  isStoragePersistent,
  requestPersistentStorage,
  type PersistOutcome,
  type StorageEstimate,
} from '../../core/storage/persist'
import { newPieceRecord, type PieceRecord } from '../../core/storage/records'
import type { LibraryDeps } from './deps'
import { finalizeImport, type ReviewDraft } from './review'
import { needsChoice, selectionProblem, togglePart } from './selection'

export type FlowMode = { readonly kind: 'new' } | { readonly kind: 'replace'; readonly piece: PieceRecord }

export type WorkStep = 'reading' | 'inspecting' | 'building'

export interface StorageStatus {
  /** Outcome of the one persistence request, or the current state when already asked. */
  readonly persistence: PersistOutcome | 'unknown'
  readonly estimate: StorageEstimate | undefined
}

export type FlowPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'working'
      readonly step: WorkStep
      readonly fileName: string
      readonly stage: ImportStage | null
      readonly fraction: number
    }
  | {
      readonly kind: 'choose'
      readonly fileName: string
      readonly inspect: InspectResult
      readonly candidateId: string
      readonly partIds: readonly string[]
      readonly error: string | null
    }
  | {
      readonly kind: 'review'
      readonly fileName: string
      readonly inspect: InspectResult
      readonly result: BuildResult
      readonly candidateId: string
      readonly partIds: readonly string[]
      /** The user picked the score/parts (so "Change parts" makes sense). */
      readonly choiceOffered: boolean
      readonly saving: boolean
      readonly saveError: string | null
    }
  | {
      readonly kind: 'failed'
      readonly fileName: string | null
      readonly message: string
      readonly diagnostics: readonly Diagnostic[]
    }

/** Readable progress wording per importer stage. */
export const STAGE_TEXT: Readonly<Record<ImportStage, string>> = {
  reading: 'Reading the file',
  parsing: 'Reading the MusicXML',
  measures: 'Measuring bars',
  repeats: 'Unfolding repeats',
  notes: 'Reading notes',
  tempo: 'Building the tempo map',
  ottavas: 'Checking ottava lines',
  hands: 'Assigning hands',
  context: 'Reading keys, meters and clefs',
  render: 'Preparing the notation',
  hashing: 'Fingerprinting the score',
  done: 'Finishing',
}

let persistenceRequested = false

/** Tests only: forget that persistence was requested this session. */
export function resetPersistenceRequestForTests(): void {
  persistenceRequested = false
}

function errorMessage(error: unknown): { message: string; diagnostics: readonly Diagnostic[] } {
  if (error instanceof ImportError) return { message: error.message, diagnostics: error.diagnostics }
  // ImportErrors that crossed a structured clone lose their prototype; keep their message.
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const e = error as { message: unknown; diagnostics?: unknown }
    return {
      message: String(e.message),
      diagnostics: Array.isArray(e.diagnostics) ? (e.diagnostics as Diagnostic[]) : [],
    }
  }
  return { message: String(error), diagnostics: [] }
}

function isCanceled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'canceled'
}

/** Called once a piece is saved; `storage` resolves when persistence and quota are known. */
export type OnSaved = (piece: PieceRecord, info: { replaced: boolean; storage: Promise<StorageStatus> }) => void

export class ImportFlow {
  readonly phase: Signal<FlowPhase> = signal({ kind: 'idle' })
  readonly mode: FlowMode
  #deps: LibraryDeps
  #client: ImportClient | null = null
  #job = 0
  #abort: AbortController | null = null
  #onSaved: OnSaved

  constructor(deps: LibraryDeps, mode: FlowMode, onSaved: OnSaved = () => undefined) {
    this.#deps = deps
    this.mode = mode
    this.#onSaved = onSaved
  }

  get busy(): boolean {
    const p = this.phase.peek()
    return p.kind === 'working' || (p.kind === 'review' && p.saving)
  }

  #client_(): ImportClient {
    this.#client ??= this.#deps.createImportClient()
    return this.#client
  }

  #begin(): { token: number; signal: AbortSignal } {
    this.#abort?.abort()
    const abort = new AbortController()
    this.#abort = abort
    this.#job += 1
    return { token: this.#job, signal: abort.signal }
  }

  #live(token: number): boolean {
    return token === this.#job
  }

  #progress(token: number, step: WorkStep, fileName: string) {
    return (stage: ImportStage, fraction: number) => {
      if (!this.#live(token)) return
      this.phase.value = { kind: 'working', step, fileName, stage, fraction }
    }
  }

  #fail(token: number, fileName: string | null, error: unknown): void {
    if (!this.#live(token) || isCanceled(error)) return
    const { message, diagnostics } = errorMessage(error)
    this.phase.value = { kind: 'failed', fileName, message, diagnostics }
  }

  /** Read and inspect a picked file. */
  async openFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<void> {
    const { token, signal } = this.#begin()
    const fileName = file.name
    this.phase.value = { kind: 'working', step: 'reading', fileName, stage: null, fraction: 0 }
    if (file.size > DEFAULT_IMPORT_LIMITS.maxInputBytes) {
      const mib = Math.round(DEFAULT_IMPORT_LIMITS.maxInputBytes / (1024 * 1024))
      this.#fail(
        token,
        fileName,
        new ImportError('file-too-large', `“${fileName}” is larger than ${mib} MB, the most a score may be.`),
      )
      return
    }
    let bytes: ArrayBuffer
    try {
      bytes = await file.arrayBuffer()
    } catch (error) {
      this.#fail(
        token,
        fileName,
        new ImportError('file-empty', `“${fileName}” could not be read: ${errorMessage(error).message}`),
      )
      return
    }
    if (!this.#live(token)) return
    this.phase.value = { kind: 'working', step: 'inspecting', fileName, stage: null, fraction: 0 }
    let inspect: InspectResult
    try {
      inspect = await this.#client_().inspect(
        { name: fileName, bytes },
        { signal, onProgress: this.#progress(token, 'inspecting', fileName) },
      )
    } catch (error) {
      this.#fail(token, fileName, error)
      return
    }
    if (!this.#live(token)) return
    const first = inspect.candidates[0]
    if (!first) {
      this.#fail(token, fileName, new ImportError('score-structure', 'The file contains no score.'))
      return
    }
    if (needsChoice(inspect)) {
      this.phase.value = {
        kind: 'choose',
        fileName,
        inspect,
        candidateId: first.id,
        partIds: first.suggestedParts,
        error: null,
      }
      return
    }
    await this.#build(token, signal, fileName, inspect, first.id, first.suggestedParts, false)
  }

  #candidate(inspect: InspectResult, id: string): ImportCandidate | undefined {
    return inspect.candidates.find((c) => c.id === id)
  }

  chooseCandidate(id: string): void {
    const p = this.phase.peek()
    if (p.kind !== 'choose') return
    const c = this.#candidate(p.inspect, id)
    if (!c) return
    this.phase.value = { ...p, candidateId: id, partIds: c.suggestedParts, error: null }
  }

  togglePart(partId: string): void {
    const p = this.phase.peek()
    if (p.kind !== 'choose') return
    const c = this.#candidate(p.inspect, p.candidateId)
    if (!c) return
    this.phase.value = { ...p, partIds: togglePart(c, p.partIds, partId), error: null }
  }

  /** The selection problem for the current choice, if any. */
  choiceProblem(): string | null {
    const p = this.phase.peek()
    if (p.kind !== 'choose') return null
    const c = this.#candidate(p.inspect, p.candidateId)
    return c ? selectionProblem(c, p.partIds) : 'Choose a score.'
  }

  async confirmChoice(): Promise<void> {
    const p = this.phase.peek()
    if (p.kind !== 'choose') return
    const problem = this.choiceProblem()
    if (problem) {
      this.phase.value = { ...p, error: problem }
      return
    }
    const { token, signal } = this.#begin()
    await this.#build(token, signal, p.fileName, p.inspect, p.candidateId, p.partIds, true)
  }

  async #build(
    token: number,
    signal: AbortSignal,
    fileName: string,
    inspect: InspectResult,
    candidate: string,
    partIds: readonly string[],
    choiceOffered: boolean,
  ): Promise<void> {
    this.phase.value = { kind: 'working', step: 'building', fileName, stage: null, fraction: 0 }
    let result: BuildResult
    try {
      result = await this.#client_().build(
        { candidate, partIds },
        { signal, onProgress: this.#progress(token, 'building', fileName) },
      )
    } catch (error) {
      if (this.#live(token) && !isCanceled(error) && choiceOffered) {
        // Let the user pick other parts rather than start over.
        const { message } = errorMessage(error)
        this.phase.value = { kind: 'choose', fileName, inspect, candidateId: candidate, partIds, error: message }
        return
      }
      this.#fail(token, fileName, error)
      return
    }
    if (!this.#live(token)) return
    this.phase.value = {
      kind: 'review',
      fileName,
      inspect,
      result,
      candidateId: candidate,
      partIds,
      choiceOffered,
      saving: false,
      saveError: null,
    }
  }

  /** From the summary back to the score/part choice. */
  backToChoice(): void {
    const p = this.phase.peek()
    if (p.kind !== 'review' || p.saving) return
    this.#job += 1
    this.phase.value = {
      kind: 'choose',
      fileName: p.fileName,
      inspect: p.inspect,
      candidateId: p.candidateId,
      partIds: p.partIds,
      error: null,
    }
  }

  /** Commit the reviewed import (hands confirmed, tempo supplied). */
  async save(draft: ReviewDraft): Promise<void> {
    const p = this.phase.peek()
    if (p.kind !== 'review' || p.saving) return
    const token = this.#job
    let piece: PieceRecord
    let pkg
    try {
      const fin = finalizeImport(p.result.package.model, p.result.summary, draft)
      pkg = { model: fin.model, renderXml: p.result.package.renderXml }
      piece = this.#pieceFor(pkg, fin.userTempo)
    } catch (error) {
      this.phase.value = { ...p, saveError: errorMessage(error).message }
      return
    }
    this.phase.value = { ...p, saving: true, saveError: null }
    try {
      const storage = await this.#deps.getStorage()
      await storage.commitImport({ source: p.result.source, pkg, piece })
    } catch (error) {
      if (!this.#live(token)) return
      const message = isQuotaError(error)
        ? 'There is not enough storage space left in this browser. Export a backup and delete pieces you no longer need, then try again.'
        : `The score could not be saved: ${errorMessage(error).message}. Your library is unchanged.`
      this.phase.value = { ...p, saving: false, saveError: message }
      return
    }
    // The worker was already released after building; drop the retained file as well.
    this.#client?.dispose()
    this.#client = null
    // Saved: the sheet closes at once (L6); the caller reports it and opens Practice. Persistent storage is
    // requested after the first import (L3) and the status reaches the library when known.
    const storage = this.#storageStatus()
    this.phase.value = { kind: 'idle' }
    this.#onSaved(piece, { replaced: this.mode.kind === 'replace', storage })
    await storage
  }

  #pieceFor(pkg: Parameters<typeof newPieceRecord>[0], userTempo: PieceRecord['userTempo']): PieceRecord {
    const { meta, scoreVersionId } = pkg.model
    if (this.mode.kind === 'new') {
      const fresh = newPieceRecord(pkg, { now: this.#deps.now() })
      return userTempo ? { ...fresh, userTempo } : fresh
    }
    // Replacing a source (ST1, DECISIONS L2): same piece id, new score version. Positions saved
    // against the old version (resume and last passage) no longer apply.
    const { composer: _oldComposer, userTempo: _oldTempo, ...old } = this.mode.piece
    return {
      ...old,
      title: meta.title,
      ...(meta.composer !== undefined ? { composer: meta.composer } : {}),
      ...(userTempo ? { userTempo } : {}),
      scoreVersionId,
      lastOpenedAt: this.#deps.now(),
      resume: null,
      lastPassage: null,
    }
  }

  async #storageStatus(): Promise<StorageStatus> {
    const manager = this.#deps.storageManager
    let persistence: StorageStatus['persistence']
    if (!persistenceRequested) {
      persistenceRequested = true
      persistence = await requestPersistentStorage(manager)
    } else {
      const now = await isStoragePersistent(manager)
      persistence = now === undefined ? 'unknown' : now ? 'granted' : 'denied'
    }
    return { persistence, estimate: await estimateStorage(manager) }
  }

  /** Stop the running job (if any) and return to the start. Nothing from that job shows later. */
  cancel(): void {
    this.#abort?.abort()
    this.#abort = null
    this.#job += 1
    this.phase.value = { kind: 'idle' }
  }

  /** Close the flow: cancel anything running and release the worker and the file. */
  close(): void {
    this.cancel()
    this.#client?.dispose()
    this.#client = null
  }
}
