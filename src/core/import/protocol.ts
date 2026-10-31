/**
 * Messages between the import client (main thread) and the import worker. Plain structured-clone
 * data; file bytes travel as transferred ArrayBuffers. The worker never sends the file back: the
 * client keeps its own copy for the `SourceFileRecord`.
 */
import type { SourceFileRecord } from '../model/score'
import type { ImportFailure } from './errors'
import type { ImportLimits } from './limits'
import type { BuildResult, ImportSelection, ImportStage, InspectResult } from './pipeline'

export type ImportWorkerRequest =
  | {
      readonly type: 'inspect'
      readonly job: number
      readonly fileName: string
      readonly bytes: ArrayBuffer
      readonly limits?: Partial<ImportLimits>
    }
  | {
      readonly type: 'build'
      readonly job: number
      readonly fileName: string
      readonly bytes: ArrayBuffer
      readonly selection: ImportSelection
      readonly importedAt: number
      readonly limits?: Partial<ImportLimits>
    }
  | { readonly type: 'cancel'; readonly job: number }

export type BuiltWithoutBytes = Omit<BuildResult, 'source'> & { readonly source: Omit<SourceFileRecord, 'bytes'> }

export type ImportWorkerResponse =
  | { readonly type: 'progress'; readonly job: number; readonly stage: ImportStage; readonly fraction: number }
  | { readonly type: 'inspected'; readonly job: number; readonly result: InspectResult }
  | { readonly type: 'built'; readonly job: number; readonly result: BuiltWithoutBytes }
  | { readonly type: 'failed'; readonly job: number; readonly failure: ImportFailure }
