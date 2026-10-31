/**
 * Test helpers for the Library (not imported by application code): a fake import client that
 * runs the pure pipeline in-process with controllable timing, fixture files, and injectable deps
 * over a fresh fake-indexeddb database. Fixture files: `bytesFile(name, fixtureBytes(name))` in the
 * test files (reading fixtures needs Node).
 */
import {
  buildScorePackage,
  inspectSource,
  type BuildResult,
  type ImportStage,
  type InspectResult,
} from '../../core/import/pipeline'
import type { ImportClient, ImportJobOptions } from '../../core/import/client'
import { ImportError } from '../../core/import/errors'
import { openFresh } from '../../core/storage/testkit'
import type { PianissimoStorage } from '../../core/storage/storage'
import type { StorageManagerLike } from '../../core/storage/persist'
import type { LibraryDeps } from './deps'

export type FileLike = Pick<File, 'name' | 'size' | 'arrayBuffer'>

export function bytesFile(name: string, bytes: Uint8Array): FileLike & File {
  const copy = () => {
    const out = new Uint8Array(bytes.byteLength)
    out.set(bytes)
    return out.buffer
  }
  return { name, size: bytes.byteLength, arrayBuffer: async () => copy() } as unknown as File
}

interface Deferred {
  release(): void
}

/**
 * In-process `ImportClient`. With `hold`, each job waits until `releaseAll()`; an abort rejects
 * it at once with `canceled` unless `lateResults` is set, in which case the (misbehaving)
 * client still resolves later, so tests can prove the flow ignores it.
 */
export class FakeImportClient implements ImportClient {
  hold = false
  lateResults = false
  disposed = 0
  readonly calls: string[] = []
  #file: { name: string; bytes: ArrayBuffer } | null = null
  #pending: Deferred[] = []

  releaseAll(): void {
    const pending = this.#pending
    this.#pending = []
    for (const p of pending) p.release()
  }

  get pendingJobs(): number {
    return this.#pending.length
  }

  async #job<T>(run: () => Promise<T>, options: ImportJobOptions, stage: ImportStage): Promise<T> {
    options.onProgress?.(stage, 0.3)
    const { signal } = options
    if (signal?.aborted) throw new ImportError('canceled', 'The import was canceled.')
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        this.#pending.push({ release: resolve })
        signal?.addEventListener('abort', () => {
          if (!this.lateResults) reject(new ImportError('canceled', 'The import was canceled.'))
        })
      })
    }
    const result = await run()
    options.onProgress?.('done', 1)
    return result
  }

  inspect(
    file: { name: string; bytes: ArrayBuffer | Uint8Array },
    options: ImportJobOptions = {},
  ): Promise<InspectResult> {
    this.calls.push('inspect')
    const bytes = file.bytes instanceof Uint8Array ? file.bytes.slice().buffer : file.bytes.slice(0)
    this.#file = { name: file.name, bytes }
    return this.#job(() => inspectSource({ name: file.name, bytes }), options, 'parsing')
  }

  build(
    selection: { candidate: string; partIds: readonly string[] },
    options: ImportJobOptions = {},
  ): Promise<BuildResult> {
    this.calls.push(`build:${selection.partIds.join('+')}`)
    const file = this.#file
    if (!file) return Promise.reject(new ImportError('no-source', 'No file.'))
    return this.#job(
      () => buildScorePackage({ name: file.name, bytes: file.bytes }, selection, { now: () => 0 }),
      options,
      'notes',
    )
  }

  dispose(): void {
    this.disposed += 1
    this.#file = null
  }
}

export class FakeStorageManager implements StorageManagerLike {
  persisted_ = false
  grant = true
  persistCalls = 0
  persist = async () => {
    this.persistCalls += 1
    this.persisted_ = this.grant
    return this.grant
  }
  persisted = async () => this.persisted_
  estimate = async () => ({ usage: 1_500_000, quota: 2_000_000_000 })
}

export interface TestDeps extends LibraryDeps {
  readonly storage: PianissimoStorage
  readonly client: FakeImportClient
  readonly manager: FakeStorageManager
  readonly downloads: { bytes: Uint8Array; fileName: string }[]
  flushes: number
  reloads: number
  clock: number
}

export async function testDeps(storage?: PianissimoStorage): Promise<TestDeps> {
  const db = storage ?? (await openFresh())
  const client = new FakeImportClient()
  const manager = new FakeStorageManager()
  const deps: TestDeps = {
    storage: db,
    client,
    manager,
    downloads: [],
    flushes: 0,
    reloads: 0,
    clock: Date.UTC(2026, 9, 29, 12),
    getStorage: () => Promise.resolve(db),
    createImportClient: () => client,
    storageManager: manager,
    now: () => deps.clock,
    download: (bytes, fileName) => {
      deps.downloads.push({ bytes, fileName })
    },
    flushSettings: async () => {
      deps.flushes += 1
    },
    reloadSettings: async () => {
      deps.reloads += 1
    },
    isAppleMobile: () => false,
  }
  return deps
}

/** Let promises and short timers settle. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
