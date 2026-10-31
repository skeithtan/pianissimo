import { describe, expect, it, vi } from 'vitest'
import { fixtureBytes } from '../../../tests/unit/import/fixtures'
import { createImportClient, type ImportWorkerLike, type WorkerErrorLike } from './client'
import { ImportError } from './errors'
import type { ImportWorkerRequest, ImportWorkerResponse } from './protocol'
import { createImportWorkerHandler } from './workerHandler'

/** A worker stand-in running the real handler in-process with structured cloning and async delivery. */
class FakeWorker implements ImportWorkerLike {
  onmessage: ((event: { readonly data: ImportWorkerResponse }) => void) | null = null
  onerror: ((event: WorkerErrorLike) => void) | null = null
  terminated = false
  readonly received: ImportWorkerRequest[] = []
  private readonly handle = createImportWorkerHandler((message) => {
    const copy = structuredClone(message)
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: copy })
    }, 0)
  })

  constructor(private readonly delayMs = 0) {}

  postMessage(message: ImportWorkerRequest, transfer: Transferable[]): void {
    const cloned = structuredClone(message, { transfer: transfer as ArrayBuffer[] })
    this.received.push(cloned)
    setTimeout(() => {
      if (!this.terminated) void this.handle(cloned)
    }, this.delayMs)
  }

  terminate(): void {
    this.terminated = true
  }
}

function setup(delayMs = 0, extra: { fallbackFails?: boolean } = {}) {
  const workers: FakeWorker[] = []
  const fallbacks: FakeWorker[] = []
  const logs: string[] = []
  const client = createImportClient({
    createWorker: () => {
      const w = new FakeWorker(delayMs)
      workers.push(w)
      return w
    },
    createFallbackWorker: async () => {
      const w = new FakeWorker(0)
      fallbacks.push(w)
      if (extra.fallbackFails) w.postMessage = () => setTimeout(() => w.onerror?.({ message: 'inline boom' }), 0)
      return w
    },
    log: (message) => logs.push(message),
    now: () => 42,
  })
  return { client, workers, fallbacks, logs }
}

const file = () => ({ name: 'two-hands.musicxml', bytes: fixtureBytes('two-hands.musicxml') })

describe('import client', () => {
  it('inspects then builds through the worker, keeping the source bytes on the main thread', async () => {
    const { client, workers } = setup()
    const progress = vi.fn()
    const f = file()
    const inspected = await client.inspect(f, { onProgress: progress })
    expect(inspected.candidates).toHaveLength(1)
    expect(progress).toHaveBeenCalled()
    const c = inspected.candidates[0]!
    const built = await client.build({ candidate: c.id, partIds: c.suggestedParts })
    expect(built.package.model.notes.length).toBeGreaterThan(0)
    expect(built.package.model.meta.importedAt).toBe(42)
    expect(new Uint8Array(built.source.bytes)).toEqual(f.bytes)
    expect(built.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    // The bytes sent to the worker were transferred copies; the caller's buffer is intact.
    expect(f.bytes.byteLength).toBeGreaterThan(0)
    expect(workers[0]!.received.map((r) => r.type)).toEqual(['inspect', 'build'])
    // The worker is released after a build.
    expect(workers[0]!.terminated).toBe(true)
  })

  it('rejects build before any inspect', async () => {
    const { client } = setup()
    await expect(client.build({ candidate: 'score', partIds: ['P1'] })).rejects.toMatchObject({ code: 'no-source' })
  })

  it('turns pipeline failures into ImportError with a readable message', async () => {
    const { client } = setup()
    const error = await client
      .inspect({ name: 'bad.xml', bytes: new TextEncoder().encode('<html><body/></html>') })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportError)
    expect((error as ImportError).code).toBe('not-musicxml')
    expect((error as ImportError).message).toContain('<html>')
  })

  it('abort terminates the worker, rejects once with "canceled" and never calls back', async () => {
    const { client, workers } = setup(20)
    const progress = vi.fn()
    const controller = new AbortController()
    const pending = client.inspect(file(), { signal: controller.signal, onProgress: progress })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'canceled' })
    expect(workers[0]!.terminated).toBe(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(progress).not.toHaveBeenCalled()
    // A later job uses a fresh worker and succeeds.
    const ok = await client.inspect(file())
    expect(ok.candidates).toHaveLength(1)
    expect(workers).toHaveLength(2)
  })

  it('an already-aborted signal rejects without starting a worker', async () => {
    const { client, workers } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(client.inspect(file(), { signal: controller.signal })).rejects.toMatchObject({ code: 'canceled' })
    expect(workers).toHaveLength(0)
  })

  it('starting a new job cancels the running one (one job at a time)', async () => {
    const { client, workers } = setup(10)
    const first = client.inspect(file())
    const second = client.inspect(file())
    await expect(first).rejects.toMatchObject({ code: 'canceled' })
    await expect(second).resolves.toMatchObject({ fileName: 'two-hands.musicxml' })
    expect(workers[0]!.terminated).toBe(true)
  })

  it('after a worker crash the job and every later one run on the main thread', async () => {
    const { client, workers, fallbacks, logs } = setup(30)
    const pending = client.inspect(file())
    workers[0]!.onerror?.({ filename: 'import.worker.js', lineno: 1 })
    await expect(pending).resolves.toMatchObject({ fileName: 'two-hands.musicxml' })
    expect(workers[0]!.terminated).toBe(true)
    expect(fallbacks).toHaveLength(1)
    expect(logs[0]).toContain('no message from the browser (import.worker.js:1)')
    const c = (await pending).candidates[0]!
    await expect(client.build({ candidate: c.id, partIds: c.suggestedParts })).resolves.toBeTruthy()
    expect(workers).toHaveLength(1) // no new worker was tried
    expect(fallbacks).toHaveLength(2)
  })

  it('reports an error when the main-thread fallback fails too', async () => {
    const { client, workers } = setup(30, { fallbackFails: true })
    const pending = client.inspect(file())
    workers[0]!.onerror?.({ message: 'boom' })
    await expect(pending).rejects.toMatchObject({ code: 'internal', message: 'The import failed: inline boom.' })
  })

  it('dispose cancels and refuses further jobs', async () => {
    const { client } = setup(10)
    const pending = client.inspect(file())
    client.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'canceled' })
    await expect(client.inspect(file())).rejects.toBeInstanceOf(ImportError)
  })
})

describe('worker handler', () => {
  it('suppresses messages for a canceled job', async () => {
    const posted: ImportWorkerResponse[] = []
    const handle = createImportWorkerHandler((m) => posted.push(m))
    const bytes = fixtureBytes('two-hands.musicxml')
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    await handle({ type: 'cancel', job: 7 })
    await handle({ type: 'inspect', job: 7, fileName: 'x.musicxml', bytes: buffer })
    expect(posted).toEqual([])
    await handle({ type: 'inspect', job: 8, fileName: 'x.musicxml', bytes: buffer })
    expect(posted.at(-1)?.type).toBe('inspected')
  })

  it('sends built results without the file bytes', async () => {
    const posted: ImportWorkerResponse[] = []
    const handle = createImportWorkerHandler((m) => posted.push(m))
    const bytes = fixtureBytes('two-hands.musicxml')
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    await handle({
      type: 'build',
      job: 1,
      fileName: 'x.musicxml',
      bytes: buffer,
      selection: { candidate: 'score', partIds: ['P1'] },
      importedAt: 5,
    })
    const built = posted.find((m) => m.type === 'built')
    expect(built?.type).toBe('built')
    if (built?.type === 'built') {
      expect('bytes' in built.result.source).toBe(false)
      expect(built.result.package.model.meta.importedAt).toBe(5)
    }
  })
})
