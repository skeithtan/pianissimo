/**
 * Main-thread client for the import worker (spec "Execution and rendering architecture": expand,
 * validate and normalize in a dedicated worker; one heavy import at a time, with cancellation and
 * progress; a canceled job produces no later UI mutations; release worker resources).
 *
 * - One job at a time. Starting a job while another runs cancels the older one.
 * - `signal` abort → the worker is terminated and the promise rejects once with an
 *   `ImportError` whose code is "canceled"; no progress or result is delivered afterwards.
 * - The client keeps the last inspected file so `build` can follow `inspect` (and be repeated
 *   with another part selection); each job transfers its own copy of the bytes to the worker.
 * - After `build` settles the worker is terminated, returning its memory; the next job starts a
 *   fresh one. `dispose()` terminates everything and forgets the file.
 * - If the worker itself fails (its script cannot load, or it crashes without a reply: seen on
 *   the iPad on 2026-10-31 with an empty error), the job is run again on the main thread with the
 *   same handler, and every later job of this client stays there. The failure is logged with
 *   whatever the browser says; the learner sees an error only if that fallback fails too.
 */
import { IMPORTER_VERSION } from '../model/score'
import { ImportError, fromImportFailure } from './errors'
import type { ImportLimits } from './limits'
import type { BuildResult, ImportFile, ImportSelection, ImportStage, InspectResult } from './pipeline'
import type { ImportWorkerRequest, ImportWorkerResponse } from './protocol'

/** The subset of `Worker` the client uses (a fake can stand in for tests). */
export interface ImportWorkerLike {
  postMessage(message: ImportWorkerRequest, transfer: Transferable[]): void
  terminate(): void
  onmessage: ((event: { readonly data: ImportWorkerResponse }) => void) | null
  onerror: ((event: WorkerErrorLike) => void) | null
}

/** What a worker `error` event may carry (Safari gives an empty message when the script fails to load). */
export interface WorkerErrorLike {
  readonly message?: string
  readonly filename?: string
  readonly lineno?: number
}

export interface ImportJobOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (stage: ImportStage, fraction: number) => void
}

export interface ImportClient {
  /** Detect the format and list the candidate scores and parts. */
  inspect(file: ImportFile, options?: ImportJobOptions): Promise<InspectResult>
  /** Build the package for a candidate and part selection of the last inspected file. */
  build(selection: ImportSelection, options?: ImportJobOptions): Promise<BuildResult>
  /** Terminate the worker and forget the file. Any running job is canceled. */
  dispose(): void
}

export interface ImportClientOptions {
  readonly createWorker?: () => ImportWorkerLike
  /** The main-thread stand-in used after the worker fails (default: the real handler, loaded lazily). */
  readonly createFallbackWorker?: () => Promise<ImportWorkerLike>
  readonly limits?: Partial<ImportLimits>
  readonly now?: () => number
  /** Where worker failures are reported (default `console.error`). */
  readonly log?: (message: string, detail?: unknown) => void
}

/** The import pipeline on the main thread, behind the worker's message protocol. */
async function inlineWorker(): Promise<ImportWorkerLike> {
  const { createImportWorkerHandler } = await import('./workerHandler')
  let alive = true
  const w: ImportWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      if (!alive) return
      void handle(message).catch((e: unknown) => {
        if (alive) w.onerror?.({ message: e instanceof Error ? e.message : String(e) })
      })
    },
    terminate() {
      alive = false
    },
  }
  const handle = createImportWorkerHandler((response) => {
    if (alive) w.onmessage?.({ data: response })
  })
  return w
}

function describeWorkerError(event: WorkerErrorLike): string {
  const where = event.filename ? ` (${event.filename}${event.lineno ? `:${event.lineno}` : ''})` : ''
  return event.message ? `${event.message}${where}` : `no message from the browser${where}`
}

function defaultWorker(): ImportWorkerLike {
  return new Worker(new URL('../../workers/import.worker.ts', import.meta.url), {
    type: 'module',
    name: `pianissimo-import-${IMPORTER_VERSION}`,
  }) as unknown as ImportWorkerLike
}

function cancelledError(): ImportError {
  return new ImportError('canceled', 'The import was canceled.')
}

interface Job {
  readonly id: number
  readonly onProgress: ((stage: ImportStage, fraction: number) => void) | undefined
  /** Builds the request again (fresh transferable bytes) so a job can be re-run after a crash. */
  readonly makeRequest: () => { request: ImportWorkerRequest; transfer: Transferable[] }
  readonly settle: (message: ImportWorkerResponse) => void
  readonly fail: (error: ImportError) => void
  readonly detach: () => void
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (!(bytes instanceof Uint8Array)) return bytes
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export function createImportClient(options: ImportClientOptions = {}): ImportClient {
  const createWorker = options.createWorker ?? defaultWorker
  const createFallbackWorker = options.createFallbackWorker ?? inlineWorker
  const log = options.log ?? ((message: string, detail?: unknown) => console.error(message, detail))
  const now = options.now ?? Date.now
  let worker: ImportWorkerLike | null = null
  let current: Job | null = null
  let nextId = 1
  let lastFile: { readonly name: string; readonly bytes: ArrayBuffer } | null = null
  let disposed = false
  /** After a worker failure every job runs on the main thread. */
  let onMainThread = false

  const terminate = () => {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    worker = null
  }

  const attach = (w: ImportWorkerLike, inline: boolean): ImportWorkerLike => {
    w.onmessage = (event) => {
      const msg = event.data
      const job = current
      if (!job || msg.job !== job.id) return
      if (msg.type === 'progress') {
        job.onProgress?.(msg.stage, msg.fraction)
        return
      }
      job.settle(msg)
    }
    w.onerror = (event) => {
      const job = current
      terminate()
      const detail = describeWorkerError(event)
      if (inline || onMainThread) {
        job?.fail(new ImportError('internal', `The import failed: ${detail}.`))
        return
      }
      // The worker could not load or crashed: run this job, and the next ones, on the main thread.
      onMainThread = true
      log(`The import worker failed (${detail}). Importing on the main thread instead.`, event)
      if (job) dispatch(job)
    }
    worker = w
    return w
  }

  const dispatch = (job: Job): void => {
    const { request, transfer } = job.makeRequest()
    if (onMainThread) {
      void createFallbackWorker()
        .then((w) => {
          if (current?.id !== job.id) return
          attach(w, true).postMessage(request, transfer)
        })
        .catch((e: unknown) => {
          if (current?.id !== job.id) return
          job.fail(new ImportError('internal', `The import failed: ${e instanceof Error ? e.message : String(e)}.`))
        })
      return
    }
    try {
      ;(worker ?? attach(createWorker(), false)).postMessage(request, transfer)
    } catch (e) {
      terminate()
      job.fail(
        new ImportError('internal', `Could not start the import worker: ${e instanceof Error ? e.message : String(e)}`),
      )
    }
  }

  /** Cancel the running job (if any): terminate the worker and reject it once. */
  const cancelCurrent = () => {
    const job = current
    if (!job) return
    terminate()
    job.fail(cancelledError())
  }

  function run<T>(
    makeRequest: (id: number) => { request: ImportWorkerRequest; transfer: Transferable[] },
    onSettled: (message: ImportWorkerResponse) => T,
    jobOptions: ImportJobOptions,
    terminateAfter: boolean,
  ): Promise<T> {
    if (disposed) return Promise.reject(new ImportError('internal', 'The import client has been disposed.'))
    cancelCurrent()
    const { signal } = jobOptions
    if (signal?.aborted) return Promise.reject(cancelledError())
    return new Promise<T>((resolve, reject) => {
      const id = nextId++
      const onAbort = () => {
        if (current?.id === id) cancelCurrent()
      }
      const detach = () => {
        signal?.removeEventListener('abort', onAbort)
        if (current?.id === id) current = null
      }
      const job: Job = {
        id,
        onProgress: jobOptions.onProgress,
        makeRequest: () => makeRequest(id),
        detach,
        fail: (error) => {
          detach()
          reject(error)
        },
        settle: (message) => {
          detach()
          if (terminateAfter) terminate()
          if (message.type === 'failed') {
            reject(fromImportFailure(message.failure))
            return
          }
          try {
            resolve(onSettled(message))
          } catch (e) {
            reject(e instanceof ImportError ? e : new ImportError('internal', String(e)))
          }
        },
      }
      current = job
      signal?.addEventListener('abort', onAbort, { once: true })
      dispatch(job)
    })
  }

  return {
    inspect(file, jobOptions = {}) {
      const bytes = toArrayBuffer(file.bytes)
      lastFile = { name: file.name, bytes: bytes === file.bytes ? bytes.slice(0) : bytes }
      const kept = lastFile
      return run(
        (job) => {
          const copy = kept.bytes.slice(0)
          const request: ImportWorkerRequest = { type: 'inspect', job, fileName: kept.name, bytes: copy }
          return { request: options.limits ? { ...request, limits: options.limits } : request, transfer: [copy] }
        },
        (message) => {
          if (message.type !== 'inspected') throw new ImportError('internal', 'Unexpected import worker reply.')
          return message.result
        },
        jobOptions,
        false,
      )
    },

    build(selection, jobOptions = {}) {
      const file = lastFile
      if (!file) return Promise.reject(new ImportError('no-source', 'Open a MusicXML file before building the score.'))
      return run(
        (job) => {
          const copy = file.bytes.slice(0)
          const request: ImportWorkerRequest = {
            type: 'build',
            job,
            fileName: file.name,
            bytes: copy,
            selection: { candidate: selection.candidate, partIds: [...selection.partIds] },
            importedAt: now(),
          }
          return { request: options.limits ? { ...request, limits: options.limits } : request, transfer: [copy] }
        },
        (message) => {
          if (message.type !== 'built') throw new ImportError('internal', 'Unexpected import worker reply.')
          const r = message.result
          return { package: r.package, summary: r.summary, source: { ...r.source, bytes: file.bytes } }
        },
        jobOptions,
        true,
      )
    },

    dispose() {
      cancelCurrent()
      terminate()
      lastFile = null
      disposed = true
    },
  }
}
