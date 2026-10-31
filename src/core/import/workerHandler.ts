/**
 * The import worker's message handler, independent of the worker global so it can be tested
 * in-process. Each job is stateless: it receives the file bytes, runs the pipeline, posts the
 * result and drops every reference (parsed trees, buffers) when it returns (spec: "Release
 * import-worker resources and temporary buffers after each job").
 */
import { toImportFailure } from './errors'
import { buildScorePackage, type ImportStage, inspectSource } from './pipeline'
import type { ImportWorkerRequest, ImportWorkerResponse } from './protocol'

export type PostResponse = (message: ImportWorkerResponse) => void

export function createImportWorkerHandler(post: PostResponse): (request: ImportWorkerRequest) => Promise<void> {
  const canceled = new Set<number>()
  const send = (job: number, message: ImportWorkerResponse) => {
    if (!canceled.has(job)) post(message)
  }
  return async (request) => {
    if (request.type === 'cancel') {
      canceled.add(request.job)
      return
    }
    const { job } = request
    const onProgress = (stage: ImportStage, fraction: number) => send(job, { type: 'progress', job, stage, fraction })
    const limits = request.limits ? { limits: request.limits } : {}
    try {
      if (request.type === 'inspect') {
        const result = await inspectSource({ name: request.fileName, bytes: request.bytes }, { ...limits, onProgress })
        send(job, { type: 'inspected', job, result })
      } else {
        const r = await buildScorePackage({ name: request.fileName, bytes: request.bytes }, request.selection, {
          ...limits,
          onProgress,
          now: () => request.importedAt,
        })
        send(job, {
          type: 'built',
          job,
          result: {
            package: r.package,
            summary: r.summary,
            source: { fileName: r.source.fileName, packaging: r.source.packaging, sha256: r.source.sha256 },
          },
        })
      }
    } catch (err) {
      send(job, { type: 'failed', job, failure: toImportFailure(err) })
    } finally {
      canceled.delete(job)
    }
  }
}
