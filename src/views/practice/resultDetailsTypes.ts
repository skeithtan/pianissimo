import type { ComponentChildren } from 'preact'
import type {
  AttemptSummary,
  PassRecord,
  RankedMistake,
  ReadonlyStore,
  ResultDetails,
  SnippetState,
} from '../../app/session'
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
    canDrill(attemptId: string, group: number): boolean
    drillSpot(attemptId: string, group: number): boolean
  }
  readonly result: AttemptSummary
  /** What the card offers to do next (Loop, Again), shown directly under the verdict (U142). */
  readonly actions?: ComponentChildren
  readonly model: ScoreModel
  readonly naming: NamingSettings
  readonly pieceId: string
  /** The layout the score view shows (the excerpts are cut from it); null before it is ready. */
  readonly layout: PreparedLayout | null
  /** The Repeat target ("until N clean"), or null outside Repeat. */
  readonly goal: number | null
  /** Ranks the session's details (default `rankMistakes`; tests pass their own). */
  readonly rank?: (
    latest: PassRecord | undefined,
    timeline: ResultDetails['timeline'],
    model: ScoreModel,
    marks: ResultDetails['marks'],
    spots: ResultDetails['spots'],
  ) => readonly RankedMistake[]
  /** Loads the stored attempts of the piece (tests pass a fake; default: this browser's storage). */
  readonly loadHistory?: (pieceId: string, attemptId: string) => Promise<ResultsData | null>
}
