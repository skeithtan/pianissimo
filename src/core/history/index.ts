export * from './types'
export { parseMeasureContextKey, toMeasureContext } from './contextKey'
export { applyTraversal, isAssisted, isErrorBearing } from './traversal'
export { barEvidence, compareEvidence, meetsFlagRule } from './detection'
export type { BarEvidence } from './detection'
export { MAX_CORE_BARS, adjacentRuns, chunkRun, withContextBars } from './clusters'
export { createBarLabeler } from './barLabels'
export type { BarLabeler } from './barLabels'
export { ingestAbandon, ingestAttempt } from './ingest'
export { describeContext, selectSuggestions } from './selection'
export type { SelectOptions, Suggestion, SuggestionBar, SuggestionProgress, SuggestionSelection } from './selection'
export { SessionDismissals, clearPracticeHistory, setSuggestionsDisabled } from './controls'
export {
  compareCleanRuns,
  isAssistedAttempt,
  isCleanUnassistedCompletion,
  practiceStreak,
  summarizeByContext,
  summarizeContext,
  timeDifferenceSec,
} from './results'
export type { ContextResults, PracticeStreak } from './results'
export { COMPLETION_TIME_DEFINITION, buildScorecard, formatSeconds } from './scorecard'
export type { AssistanceDetails, Scorecard, ScorecardRow, ScorecardRowId, TimingKind } from './scorecard'
