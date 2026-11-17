import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { importPiece } from '../../core/storage/testkit'
import { COMPOSER_MAX_LENGTH, LibraryModel, normalizePieceName, TITLE_MAX_LENGTH } from './libraryModel'
import { testDeps } from './testkit'

describe('normalizePieceName', () => {
  it('trims both fields and collapses inner runs of whitespace to one space', () => {
    expect(normalizePieceName({ title: '  Clair \t de\n\n lune ', composer: ' Claude   Debussy ' })).toEqual({
      title: 'Clair de lune',
      composer: 'Claude Debussy',
    })
  })

  it('turns an empty or blank composer into undefined and keeps an empty title empty', () => {
    expect(normalizePieceName({ title: 'Etude', composer: '' })).toEqual({ title: 'Etude', composer: undefined })
    expect(normalizePieceName({ title: 'Etude', composer: '   ' })).toEqual({ title: 'Etude', composer: undefined })
    expect(normalizePieceName({ title: '   ', composer: 'Anon' }).title).toBe('')
  })

  it('caps both fields without leaving a trailing space or a split surrogate pair', () => {
    const long = normalizePieceName({ title: 'a'.repeat(200), composer: 'b'.repeat(200) })
    expect(long.title).toHaveLength(TITLE_MAX_LENGTH)
    expect(long.composer).toHaveLength(COMPOSER_MAX_LENGTH)
    expect(normalizePieceName({ title: `${'a'.repeat(TITLE_MAX_LENGTH - 1)} tail`, composer: '' }).title).toBe(
      'a'.repeat(TITLE_MAX_LENGTH - 1),
    )
    const notes = normalizePieceName({ title: '𝄞'.repeat(TITLE_MAX_LENGTH + 5), composer: '' }).title
    expect(Array.from(notes)).toHaveLength(TITLE_MAX_LENGTH)
    expect(notes.endsWith('𝄞')).toBe(true)
  })
})

describe('LibraryModel.rename', () => {
  async function setup() {
    const deps = await testDeps()
    const { piece } = await importPiece(deps.storage, 'v1', {
      title: 'Etude',
      lastOpenedAt: 5_000,
      lastMultiplier: 0.75,
      resume: { occ: 2, position: { n: 2, d: 1 }, hands: 'right', multiplier: 0.75, savedAt: 4_000 },
    })
    await importPiece(deps.storage, 'v2', { title: 'Nocturne', lastOpenedAt: 9_000 })
    const model = new LibraryModel(deps)
    await model.refresh()
    return { deps, piece, model }
  }
  const listed = (model: LibraryModel) =>
    model.state.value.status === 'ready' ? model.state.value.pieces.map((p) => p.title) : []

  it('stores the normalized title and composer, refreshes the list and keeps everything else', async () => {
    const { deps, piece, model } = await setup()
    await model.rename(piece.id, { title: '  Study   in C ', composer: ' Carl  Czerny ' })
    const stored = await deps.storage.getPiece(piece.id)
    expect(stored).toEqual({ ...piece, title: 'Study in C', composer: 'Carl Czerny' })
    expect(stored?.lastOpenedAt).toBe(5_000)
    expect(stored?.scoreVersionId).toBe(piece.scoreVersionId)
    expect(stored?.resume).toEqual(piece.resume)
    // The list refreshed and kept its order (most recently opened first).
    expect(listed(model)).toEqual(['Nocturne', 'Study in C'])
    // The score package keeps the score's own metadata.
    expect((await deps.storage.getPackage(piece.scoreVersionId))?.model.meta.title).toBe('Etude')
  })

  it('removes the composer field when the composer is empty', async () => {
    const { deps, piece, model } = await setup()
    expect(piece.composer).toBe('Anon')
    await model.rename(piece.id, { title: 'Etude', composer: '   ' })
    const stored = await deps.storage.getPiece(piece.id)
    expect(stored).not.toHaveProperty('composer')
    expect(stored?.title).toBe('Etude')
  })

  it('refuses an empty title and leaves the record unchanged', async () => {
    const { deps, piece, model } = await setup()
    await expect(model.rename(piece.id, { title: ' \n ', composer: 'Someone' })).rejects.toThrow(/needs a title/)
    expect(await deps.storage.getPiece(piece.id)).toEqual(piece)
  })

  it('says so when the piece is gone', async () => {
    const { deps, piece, model } = await setup()
    await deps.storage.deletePiece(piece.id)
    await expect(model.rename(piece.id, { title: 'New', composer: '' })).rejects.toThrow(/no longer in the library/)
    expect(await deps.storage.getPiece(piece.id)).toBeUndefined()
  })
})

describe('LibraryModel.exportBackup', () => {
  it('flushes settings waiting on the save debounce before building the backup', async () => {
    const deps = await testDeps()
    const order: string[] = []
    const exportAll = deps.storage.exportAll.bind(deps.storage)
    const model = new LibraryModel({
      ...deps,
      flushSettings: async () => {
        deps.flushes += 1
        order.push('flush')
      },
      getStorage: async () => ({
        ...deps.storage,
        exportAll: () => {
          order.push('export')
          return exportAll()
        },
      }),
    })
    const name = await model.exportBackup()
    expect(deps.flushes).toBe(1)
    expect(order).toEqual(['flush', 'export'])
    expect(deps.downloads.map((d) => d.fileName)).toEqual([name])
  })
})
