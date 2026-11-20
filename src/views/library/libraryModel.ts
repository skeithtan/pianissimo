import { msg } from '../../i18n/messages'
/**
 * Library data: the piece list and the actions on it (spec "Main user journey" 1–2, "Storage
 * and recovery"). Framework-light (signals); the components only render it.
 *
 * Nothing here loads a score package for the list itself: `listPieces` reads the small piece
 * records only, so opening the library stays cheap however large the scores are.
 */
import { signal, type Signal } from '@preact/signals'
import { openStudy, openPractice, type PracticeRequest } from '../../app/navigation'
import { BackupError } from '../../core/storage/errors'
import { backupFileName } from '../../core/storage/backupFormat'
import { estimateStorage, isStoragePersistent, isQuotaError } from '../../core/storage/persist'
import { summarizeImport, type ImportSummary } from '../../core/import/summary'
import type { ScorePackage } from '../../core/model/score'
import type { PieceRecord } from '../../core/storage/records'
import type { RestoreReport } from '../../core/storage/backup'
import type { LibraryDeps } from './deps'
import type { StorageStatus } from './importFlow'
import type { FinalizedReview } from './review'

export type LibraryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly pieces: readonly PieceRecord[] }
  | { readonly status: 'unavailable'; readonly message: string }

export const STORAGE_UNAVAILABLE_TEXT =
  'The library cannot be opened because this browser window does not allow saving (a private window often blocks it). ' +
  'Open Pianissimo in a normal window to import and keep scores.'

export interface StoredReview {
  readonly pkg: ScorePackage
  readonly summary: ImportSummary
}

export type RestoreOutcome =
  | { readonly ok: true; readonly report: RestoreReport }
  | { readonly ok: false; readonly message: string; readonly problems: readonly string[] }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Longest title and composer a rename keeps (the inputs use them as `maxLength`). */
export const TITLE_MAX_LENGTH = 120
export const COMPOSER_MAX_LENGTH = 120

export interface PieceName {
  readonly title: string
  /** Undefined when the composer is empty: the field is removed from the piece record. */
  readonly composer: string | undefined
}

function tidy(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, ' ')
  // By code points, so a cut never splits a surrogate pair; trimmed again in case it ends on a space.
  return Array.from(collapsed).slice(0, max).join('').trim()
}

/**
 * The library name a rename stores: both fields trimmed, inner runs of whitespace collapsed to
 * one space and capped in length. An empty title stays empty (the caller refuses it); an empty
 * composer becomes undefined.
 */
export function normalizePieceName(name: { readonly title: string; readonly composer: string }): PieceName {
  const composer = tidy(name.composer, COMPOSER_MAX_LENGTH)
  return { title: tidy(name.title, TITLE_MAX_LENGTH), composer: composer === '' ? undefined : composer }
}

export class LibraryModel {
  readonly state: Signal<LibraryState> = signal({ status: 'loading' })
  readonly storageStatus: Signal<StorageStatus | null> = signal(null)
  #deps: LibraryDeps
  #generation = 0

  constructor(deps: LibraryDeps) {
    this.#deps = deps
  }

  get deps(): LibraryDeps {
    return this.#deps
  }

  async refresh(): Promise<void> {
    const generation = ++this.#generation
    try {
      const storage = await this.#deps.getStorage()
      const pieces = await storage.listPieces()
      if (generation !== this.#generation) return
      this.state.value = { status: 'ready', pieces }
    } catch {
      if (generation !== this.#generation) return
      this.state.value = { status: 'unavailable', message: STORAGE_UNAVAILABLE_TEXT }
    }
  }

  /** Persistence and usage, for the footer. Never throws. */
  async refreshStorageStatus(): Promise<void> {
    const manager = this.#deps.storageManager
    const [persistent, estimate] = await Promise.all([isStoragePersistent(manager), estimateStorage(manager)])
    this.storageStatus.value = {
      persistence: persistent === undefined ? 'unknown' : persistent ? 'granted' : 'denied',
      estimate,
    }
  }

  /**
   * Record that the piece was opened now (Library order and "last opened"). `notBefore` keeps the
   * time after a just-added piece's `createdAt`, so its row never reads "Not opened yet" even when
   * the clock has not moved since the import (`neverOpened`).
   */
  async markOpened(pieceId: string, notBefore = 0): Promise<void> {
    try {
      const storage = await this.#deps.getStorage()
      await storage.updatePiece(pieceId, { lastOpenedAt: Math.max(this.#deps.now(), notBefore) })
    } catch {
      // Ordering only; never block opening the piece.
    }
  }

  /** Open a piece in Practice (optionally with a preset), marking it as opened. */
  async open(
    pieceId: string,
    preset?: PracticeRequest['preset'],
    go: (r: PracticeRequest) => void = openPractice,
  ): Promise<void> {
    await this.markOpened(pieceId)
    go(preset ? { pieceId, preset } : { pieceId })
  }

  /** Study a piece (U72): listen and read, nothing practiced. */
  async study(pieceId: string): Promise<void> {
    await this.markOpened(pieceId)
    openStudy({ pieceId })
  }

  /**
   * Rename a library entry: its title and composer only (`normalizePieceName`). The score package
   * and the source file keep the score's own metadata, and the piece keeps its place in the list
   * (`lastOpenedAt` is untouched). An empty composer removes the field.
   */
  async rename(pieceId: string, name: { title: string; composer: string }): Promise<void> {
    const next = normalizePieceName(name)
    if (next.title === '') throw new Error(msg('A piece needs a title.'))
    const storage = await this.#deps.getStorage()
    const updated = await storage.updatePiece(pieceId, { title: next.title, composer: next.composer })
    if (!updated) throw new Error(msg('This piece is no longer in the library.'))
    await this.refresh()
  }

  /** Delete a piece with its results and history (one transaction, storage cascades). */
  async remove(pieceId: string): Promise<void> {
    const storage = await this.#deps.getStorage()
    await storage.deletePiece(pieceId)
    await this.refresh()
  }

  /**
   * A stored piece's package and summary for "Review hands and tempo" (loads the package, which
   * the list itself never does).
   */
  async loadReview(piece: PieceRecord): Promise<StoredReview> {
    const storage = await this.#deps.getStorage()
    const pkg = await storage.getPackage(piece.scoreVersionId)
    if (!pkg)
      throw new Error(msg('The score of this piece is missing from this device. Delete it and import its score again.'))
    return { pkg, summary: summarizeImport(pkg.model) }
  }

  /**
   * Save a reviewed hand assignment and/or practice tempo (DECISIONS L5): the same score version,
   * source and bars, so resume, passages and results stay; the new `handsId` / `tempoMapId`
   * start a separate history. One transaction through `commitImport` (same version: nothing is
   * released). The package is shared by every piece of this score version, so it is written
   * even when another piece uses it (`replaceSharedPackage`); `commitImport` drops the cached
   * layouts, which carry each note's hand, when the assignment changed.
   */
  async saveReview(piece: PieceRecord, pkg: ScorePackage, fin: FinalizedReview): Promise<PieceRecord> {
    const storage = await this.#deps.getStorage()
    const version = piece.scoreVersionId
    const [source, current] = await Promise.all([storage.getSource(version), storage.getPiece(piece.id)])
    if (!source)
      throw new Error(
        msg(
          'The original file of this score is missing from this device. Delete the piece and import its score again.',
        ),
      )
    if (!current || current.scoreVersionId !== version)
      throw new Error(msg('This piece changed in the meantime. Close and try again.'))
    const { userTempo: _previous, ...rest } = current
    const next: PieceRecord = { ...rest, ...(fin.userTempo ? { userTempo: fin.userTempo } : {}) }
    await storage.commitImport({
      source,
      pkg: { model: fin.model, renderXml: pkg.renderXml },
      piece: next,
      replaceSharedPackage: true,
    })
    await this.refresh()
    return next
  }

  /** ST5: measure histories, suggestions and abandon events; attempt records only on request. */
  async clearHistory(pieceId: string, alsoResults: boolean): Promise<void> {
    const storage = await this.#deps.getStorage()
    await storage.clearPracticeHistory(pieceId, { attempts: alsoResults })
  }

  /** Build the backup and hand it to the browser as a download. Returns the file name. */
  async exportBackup(): Promise<string> {
    // Settings still waiting on the save debounce belong in the backup too.
    await this.#deps.flushSettings()
    const storage = await this.#deps.getStorage()
    const bytes = await storage.exportAll()
    const name = backupFileName(this.#deps.now())
    this.#deps.download(bytes, name)
    return name
  }

  /**
   * Restore a backup: validated first (nothing written on failure), merged by id, settings
   * replaced except this device's MIDI route (ST3, ST4); then the app reloads its settings.
   */
  async restore(file: Pick<File, 'arrayBuffer'>): Promise<RestoreOutcome> {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
    } catch (error) {
      return { ok: false, message: msg('The file could not be read: {0}', message(error)), problems: [] }
    }
    try {
      await this.#deps.flushSettings()
      const storage = await this.#deps.getStorage()
      const report = await storage.restore(bytes)
      await this.#deps.reloadSettings()
      await this.refresh()
      return { ok: true, report }
    } catch (error) {
      if (error instanceof BackupError) return { ok: false, message: error.message, problems: error.problems }
      if (isQuotaError(error)) {
        return {
          ok: false,
          message: msg(
            'There is not enough storage space in this browser to restore this backup. Nothing was changed.',
          ),
          problems: [],
        }
      }
      return {
        ok: false,
        message: msg('The backup could not be restored: {0}. Nothing was changed.', message(error)),
        problems: [],
      }
    }
  }
}

/** "2 pieces added, 1 updated · 34 results added" from a restore report. */
export function describeRestore(report: RestoreReport): string[] {
  const lines: string[] = []
  const s = report.stores
  const part = (label: string, c: { added: number; updated: number; skipped: number }) => {
    const bits: string[] = []
    if (c.added) bits.push(msg('{0} added', c.added))
    if (c.updated) bits.push(msg('{0} updated', c.updated))
    if (c.skipped) bits.push(msg('{0} skipped', c.skipped))
    return bits.length ? `${label}: ${bits.join(', ')}` : null
  }
  for (const line of [
    part(msg('Pieces'), s.pieces),
    part(msg('Results'), s.attempts),
    part(msg('Bar histories'), s.measureHistory),
    part(msg('Suggestions'), s.suggestionState),
  ]) {
    if (line) lines.push(line)
  }
  if (lines.length === 0) lines.push(msg('Everything in the backup was already on this device.'))
  lines.push(
    report.settings === 'restored'
      ? msg('Settings were restored from the backup (this device keeps its own piano connection).')
      : report.settings === 'kept'
        ? msg('Settings on this device were kept.')
        : msg('The backup had no settings. Yours were kept.'),
  )
  return lines
}
