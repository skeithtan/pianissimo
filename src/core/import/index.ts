/**
 * MusicXML importer public API. See README.md in this folder.
 *
 * In the app, use the worker client (`createImportClient`); the same pure pipeline functions
 * (`inspectSource`, `buildScorePackage`) run synchronously in tests and Node.
 */
export { createImportClient } from './client'
export type { ImportClient, ImportClientOptions, ImportJobOptions, ImportWorkerLike } from './client'
export { buildScorePackage, inspectSource } from './pipeline'
export type { BuildResult, ImportFile, ImportSelection, ImportStage, InspectResult, PipelineOptions } from './pipeline'
export type { CandidatePart, ImportCandidate } from './candidates'
export { applyHandAssignment } from './hands'
export { withUserTempo } from './rolls'
export { summarizeImport } from './summary'
export type { ImportSummary, SummaryOttava, SummaryRoll, SummaryTempo, SummaryVoice } from './summary'
export { ImportError, type ImportErrorCode, type ImportFailure } from './errors'
export { DEFAULT_IMPORT_LIMITS, type ImportLimits } from './limits'
