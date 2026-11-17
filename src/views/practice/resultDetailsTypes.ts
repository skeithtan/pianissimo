import type { AttemptSummary, RankedMistake, ReadonlyStore, ResultDetails, SnippetState } from '../../app/session'
import type { SnippetKind } from '../../app/session/snippets'
import type { ScoreModel } from '../../core/model/score'
import type { NamingSettings } from '../../core/model/settings'
import type { PreparedLayout } from '../../render'
import type { ResultsData } from '../results/data'

/** What the expanded result card is given (DECISIONS U99). */
export interface ResultDetailsProps {
  /** The session: what to rank (`resultDetails`) and the mistake snippets (U100). */
  readonly session: {
    resultDetails(): ResultDetails | null
    readonly snippet: ReadonlyStore<SnippetState | null>
    snippetBlocked(attemptId: string, occ: number, kind: SnippetKind): string | null
    playSnippet(attemptId: string, occ: number, kind: SnippetKind): Promise<string | null>
    stopSnippet(): void
  }
  readonly result: AttemptSummary
  readonly model: ScoreModel
  readonly naming: NamingSettings
  readonly pieceId: string
  /** The layout the score view shows (the excerpts are cut from it); null before it is ready. */
  readonly layout: PreparedLayout | null
  /** The Repeat target ("until N clean"), or null outside Repeat. */
  readonly goal: number | null
  /** Ranks the session's details (default `rankMistakes`; tests pass their own). */
  readonly rank?: (
    records: ResultDetails['records'],
    timeline: ResultDetails['timeline'],
    model: ScoreModel,
    marks: ResultDetails['marks'],
  ) => readonly RankedMistake[]
  /** Loads the stored attempts of the piece (tests pass a fake; default: this browser's storage). */
  readonly loadHistory?: (pieceId: string, attemptId: string) => Promise<ResultsData | null>
}
