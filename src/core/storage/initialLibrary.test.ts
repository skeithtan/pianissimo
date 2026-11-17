import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScorePackage } from '../model/score'
import type { ImportCommit } from './pieces'
import { openStorage, type PianissimoStorage } from './storage'
import { freshName, importPiece, makePackage, makePiece, makeSource } from './testkit'

const opened: PianissimoStorage[] = []
async function open(name = freshName()) {
  const storage = await openStorage(name)
  opened.push(storage)
  return storage
}
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close()
})

function initial(): ImportCommit[] {
  return ['a', 'b', 'c'].map((version) => {
    const pkg = makePackage(version)
    return { pkg, piece: makePiece(pkg), source: makeSource(version) }
  })
}

describe('initial library', () => {
  it('stores all three ordinary pieces with their sources and packages and closes eligibility', async () => {
    const storage = await open()
    expect(await storage.needsInitialPieces()).toBe(true)
    const inputs = initial()
    expect(await storage.initializeLibrary(inputs)).toBe(true)
    expect(await storage.needsInitialPieces()).toBe(false)
    expect(await storage.listPieces()).toHaveLength(3)
    for (const { piece, pkg, source } of inputs) {
      expect(await storage.getPiece(piece.id)).toEqual(piece)
      expect(await storage.getPackage(piece.scoreVersionId)).toEqual(pkg)
      expect(await storage.getSource(piece.scoreVersionId)).toEqual(source)
    }
  })

  it('never adds deleted pieces again, including after deleting everything and reopening', async () => {
    const name = freshName()
    const storage = await open(name)
    await storage.initializeLibrary(initial())
    await storage.deletePiece('piece-a')
    expect(await storage.initializeLibrary(initial())).toBe(false)
    expect(await storage.listPieces()).toHaveLength(2)
    await storage.deletePiece('piece-b')
    await storage.deletePiece('piece-c')
    storage.close()
    const reopened = await open(name)
    expect(await reopened.needsInitialPieces()).toBe(false)
    expect(await reopened.initializeLibrary(initial())).toBe(false)
    expect(await reopened.listPieces()).toEqual([])
  })

  it.each([false, true])('never populates an existing version 1 library (populated: %s)', async (populated) => {
    const name = freshName()
    const piece = makePiece(makePackage('existing'))
    const old = await openDB(name, 1, {
      upgrade(db) {
        const pieces = db.createObjectStore('pieces', { keyPath: 'id' })
        pieces.createIndex('lastOpenedAt', 'lastOpenedAt')
        pieces.createIndex('scoreVersionId', 'scoreVersionId')
      },
    })
    if (populated) await old.put('pieces', piece)
    old.close()
    const upgraded = await open(name)
    expect(await upgraded.needsInitialPieces()).toBe(false)
    // Eligibility is checked first: an existing library needs no package stores read or written.
    expect(await upgraded.listPieces()).toEqual(populated ? [piece] : [])
  })

  it('serializes concurrent initializations from separate connections without duplicates or overwrites', async () => {
    const name = freshName()
    const first = await open(name)
    const second = await open(name)
    expect(await first.needsInitialPieces()).toBe(true)
    expect(await second.needsInitialPieces()).toBe(true)
    const results = await Promise.all([first.initializeLibrary(initial()), second.initializeLibrary(initial())])
    expect(results.sort()).toEqual([false, true])
    expect(await first.listPieces()).toHaveLength(3)
    await first.updatePiece('piece-a', { lastMultiplier: 0.7 })
    expect(await second.initializeLibrary(initial())).toBe(false)
    expect((await second.getPiece('piece-a'))?.lastMultiplier).toBe(0.7)
  })

  it('rolls back the whole batch and eligibility marker if any write fails, then allows a retry', async () => {
    const storage = await open()
    const inputs = initial()
    const second = inputs[1]!
    inputs[1] = { ...second, pkg: { ...second.pkg, renderXml: () => '' } as unknown as ScorePackage }
    await expect(storage.initializeLibrary(inputs)).rejects.toThrow()
    expect(await storage.listPieces()).toEqual([])
    expect(await storage.getPackage('a')).toBeUndefined()
    expect(await storage.getSource('a')).toBeUndefined()
    expect(await storage.needsInitialPieces()).toBe(true)
    expect(await storage.initializeLibrary(initial())).toBe(true)
  })

  it('lets an ordinary import win and remembers that choice even after the imported piece is deleted', async () => {
    const storage = await open()
    const { piece } = await importPiece(storage, 'own')
    expect(await storage.needsInitialPieces()).toBe(false)
    expect(await storage.initializeLibrary(initial())).toBe(false)
    expect(await storage.listPieces()).toEqual([piece])
    await storage.deletePiece(piece.id)
    expect(await storage.initializeLibrary(initial())).toBe(false)
  })

  it('does not populate a restored library, including an explicitly empty backup', async () => {
    const source = await open()
    const emptyBackup = await source.exportAll()
    const destination = await open()
    await destination.restore(emptyBackup)
    expect(await destination.needsInitialPieces()).toBe(false)
    expect(await destination.initializeLibrary(initial())).toBe(false)
    expect(await destination.listPieces()).toEqual([])
  })

  it('requires between one and three distinct valid pieces without consuming eligibility on failure', async () => {
    const storage = await open()
    await expect(storage.initializeLibrary([])).rejects.toThrow(/one to three/)
    await expect(storage.initializeLibrary([...initial(), initial()[0]!])).rejects.toThrow(/one to three/)
    await expect(storage.initializeLibrary([initial()[0]!, initial()[0]!])).rejects.toThrow(/distinct/)
    expect(await storage.needsInitialPieces()).toBe(true)
    expect(await storage.listPieces()).toEqual([])
  })
})
