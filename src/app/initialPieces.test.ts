import 'fake-indexeddb/auto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTimeline } from '../core/engine/timeline'
import type { ImportClient } from '../core/import/client'
import { buildScorePackage, inspectSource, type ImportFile } from '../core/import/pipeline'
import { openStorage, type PianissimoStorage } from '../core/storage'
import { freshName, importPiece } from '../core/storage/testkit'
import { ensureInitialPieces, INITIAL_PIECES } from './initialPieces'

const opened: PianissimoStorage[] = []
async function open() {
  const storage = await openStorage(freshName())
  opened.push(storage)
  return storage
}
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close()
})

function dependencies() {
  let file: ImportFile
  const client: ImportClient = {
    inspect: vi.fn(async (next) => {
      file = next
      return inspectSource(next)
    }),
    build: vi.fn((selection) => buildScorePackage(file, selection, { now: () => 1_000 })),
    dispose: vi.fn(),
  }
  return {
    createClient: vi.fn(() => client),
    loadFile: vi.fn(async (path: string) => {
      const bytes = await readFile(new URL(`../../public/scores/${path}`, import.meta.url))
      return new Uint8Array(bytes).buffer
    }),
    now: () => 1_000,
    client,
  }
}

describe('initial pieces', () => {
  it('imports exactly twelve bundled files and respects expressive timing marks', async () => {
    const storage = await open()
    const deps = dependencies()
    await ensureInitialPieces(storage, deps)
    const pieces = await storage.listPieces()
    expect(pieces).toHaveLength(12)
    expect(pieces.map(({ title, composer }) => ({ title, composer }))).toEqual(
      INITIAL_PIECES.map(({ title, composer }) => ({ title, composer })),
    )
    for (const [index, piece] of pieces.entries()) {
      const source = await storage.getSource(piece.scoreVersionId)
      expect(new Uint8Array(source!.bytes)).toEqual(new Uint8Array(await deps.loadFile(INITIAL_PIECES[index]!.file)))
      const pkg = await storage.getPackage(piece.scoreVersionId)
      expect(pkg?.model.meta.title).toBe(piece.title)
      expect(pkg?.model.hands.confirmed).toBe(true)
      expect(pkg?.model.unsupported).toEqual([])
      expect(pkg?.model.tempo.segments.length).toBeGreaterThan(0)
      const timeline = buildTimeline(pkg!.model, { hands: 'both', range: null, multiplier: 1 })
      expect(timeline.blockers, piece.title).toEqual([])
      if (INITIAL_PIECES[index]!.file === 'clair-de-lune-easy.mxl') {
        expect(timeline.timingUnscoredReason).toMatch(/morendo/i)
      } else {
        expect(timeline.timingUnscoredReason, piece.title).toBeNull()
      }
      expect(piece).not.toHaveProperty('kind')
    }
    expect(deps.client.dispose).toHaveBeenCalledOnce()
    deps.loadFile.mockClear()
    await ensureInitialPieces(storage, deps)
    expect(deps.loadFile).not.toHaveBeenCalled()
  })

  it('appends only the ten new scores to an existing library and honors later deletions', async () => {
    const storage = await open()
    const { piece } = await importPiece(storage)
    const deps = dependencies()
    await ensureInitialPieces(storage, deps)
    const added = INITIAL_PIECES.slice(2)
    expect(deps.loadFile.mock.calls.map(([file]) => file)).toEqual(added.map(({ file }) => file))
    const pieces = await storage.listPieces()
    expect(pieces[0]).toEqual(piece)
    expect(pieces.slice(1).map(({ title }) => title)).toEqual(added.map(({ title }) => title))

    await storage.deletePiece(pieces[1]!.id)
    deps.loadFile.mockClear()
    deps.createClient.mockClear()
    await ensureInitialPieces(storage, deps)
    expect(deps.loadFile).not.toHaveBeenCalled()
    expect(deps.createClient).not.toHaveBeenCalled()
    expect(await storage.listPieces()).toEqual([piece, ...pieces.slice(2)])
  })

  it('installs only the expansion if a simultaneous user import claims a fresh library', async () => {
    const storage = await open()
    const deps = dependencies()
    const loadFile = deps.loadFile.getMockImplementation()!
    deps.loadFile.mockImplementationOnce(async (file) => {
      await importPiece(storage)
      return loadFile(file)
    })

    await ensureInitialPieces(storage, deps)

    const titles = (await storage.listPieces()).slice(1).map(({ title }) => title)
    expect(titles).toEqual(INITIAL_PIECES.slice(2).map(({ title }) => title))
    expect(await storage.needsLibraryExpansion()).toBe(false)
  })

  it('keeps initialization pending and writes nothing if an asset cannot be fetched', async () => {
    const storage = await open()
    const deps = dependencies()
    deps.loadFile.mockRejectedValueOnce(new Error('offline'))
    await expect(ensureInitialPieces(storage, deps)).rejects.toThrow('offline')
    expect(await storage.listPieces()).toEqual([])
    expect(await storage.needsInitialPieces()).toBe(true)
    expect(deps.createClient).not.toHaveBeenCalled()
  })

  it('disposes the worker and commits nothing if a later score cannot be built', async () => {
    const storage = await open()
    const deps = dependencies()
    const build = deps.client.build
    let builds = 0
    deps.client.build = vi.fn((selection, options) => {
      if (++builds === 2) return Promise.reject(new Error('invalid score'))
      return build(selection, options)
    })
    await expect(ensureInitialPieces(storage, deps)).rejects.toThrow('invalid score')
    expect(await storage.listPieces()).toEqual([])
    expect(await storage.needsInitialPieces()).toBe(true)
    expect(deps.client.dispose).toHaveBeenCalledOnce()
  })
})
