/**
 * Loading for the Results view: everything it needs from storage in one call, against a narrow
 * interface so tests can pass a fake or an in-memory database.
 */
import type { SuggestionSelection } from '../../core/history'
import type { PassageWords } from '../../core/model/passage'
import type { AttemptRecord } from '../../core/model/practice'
import type { MeasureOccurrence } from '../../core/model/score'
import type { PianissimoStorage, PieceRecord } from '../../core/storage'

export type ResultsStorage = Pick<
  PianissimoStorage,
  'getPiece' | 'getPackage' | 'getAttempt' | 'listAttempts' | 'loadSuggestions' | 'setSuggestionsDisabled'
> & { readonly history: Pick<PianissimoStorage['history'], 'flush'> }

export interface ResultsData {
  readonly piece: PieceRecord
  /** Attempts of the shown score version (the piece's current one unless an old attempt was requested). */
  readonly attempts: readonly AttemptRecord[]
  /** Occurrence labels; empty when the version's package is gone (bars then show their index). */
  readonly occurrences: readonly MeasureOccurrence[]
  /** What names a note-level passage ("Bar 12, beat 3 – bar 14"); absent when the package is gone. */
  readonly words?: PassageWords | null
  readonly suggestions: SuggestionSelection
}

export type LoadedResults = { readonly kind: 'ready'; readonly data: ResultsData } | { readonly kind: 'missing' }

/**
 * Queued practice records are flushed first (the attempt that just ended may still be in the
 * writer's queue), then the piece's attempts for one score version are read. The version is the
 * current one, or the requested attempt's when it belongs to an earlier version of the score.
 */
export async function loadResultsData(
  storage: ResultsStorage,
  request: { readonly pieceId: string; readonly attemptId?: string | undefined },
  dismissed?: { has(id: string): boolean },
): Promise<LoadedResults> {
  await storage.history.flush().catch(() => undefined)
  const piece = await storage.getPiece(request.pieceId)
  if (!piece) return { kind: 'missing' }

  let version = piece.scoreVersionId
  if (request.attemptId !== undefined) {
    const requested = await storage.getAttempt(request.attemptId)
    if (requested && requested.pieceId === piece.id) version = requested.context.scoreVersionId
  }
  const [attempts, pkg, suggestions] = await Promise.all([
    storage.listAttempts({ pieceId: piece.id, scoreVersionId: version }),
    storage.getPackage(version),
    storage.loadSuggestions(piece.id, dismissed),
  ])
  const m = pkg?.model
  const words: PassageWords | null = m
    ? {
        occurrences: m.occurrences,
        meters: m.meters,
        sourceMeasures: m.sourceMeasures,
        notes: m.notes,
        totalDuration: m.totalDuration,
      }
    : null
  return { kind: 'ready', data: { piece, attempts, occurrences: m?.occurrences ?? [], words, suggestions } }
}
