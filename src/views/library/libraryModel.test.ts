import 'fake-indexeddb/auto'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en-US.json'
import es from '../../i18n/locales/es-ES.json'
import { readMessagesWith } from '../../i18n/messages'
import type { RecordingInfo } from '../../core/recording/records'
import type { RestoreReport } from '../../core/storage/backup'
import { importPiece, openFresh } from '../../core/storage/testkit'
import {
  COMPOSER_MAX_LENGTH,
  describeRestore,
  LibraryModel,
  normalizePieceName,
  TITLE_MAX_LENGTH,
} from './libraryModel'
import { testDeps } from './testkit'

afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

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

const take = (id: string): RecordingInfo => ({
  id,
  pieceId: 'p',
  title: `Take ${id}`,
  context: '[]',
  passage: 'Whole piece',
  passageRange: null,
  hands: 'both',
  createdAt: 1,
  durationMs: 1,
  input: 'Piano',
  score: { expected: 1, played: 1, matched: 1 },
  interrupted: false,
})
const takeFiles = (bytes: number) => ({
  midi: new Blob([new Uint8Array([1, 2, 3])]),
  audio: new Blob([new Uint8Array(bytes).fill(9)]),
})

describe('backups with recordings', () => {
  it('leaves recordings out of the export when asked, and counts them for the switch', async () => {
    const deps = await testDeps()
    await deps.storage.saveRecording(take('a'), takeFiles(1000))
    const model = new LibraryModel(deps)
    await model.refreshRecordings()
    expect(model.recordings.value).toEqual({ count: 1, bytes: 1003 })
    await model.exportBackup({ includeRecordings: false })
    const entries = unzipSync(new Uint8Array(await deps.downloads[0]!.bytes.arrayBuffer()))
    expect(Object.keys(entries).some((n) => n.startsWith('recording'))).toBe(false)
    expect(JSON.parse(strFromU8(entries['manifest.json']!))).toMatchObject({ recordingsExcluded: true })
  })

  it('restores a picked file by slices and reports the takes with the other stores', async () => {
    const other = await openFresh()
    await other.saveRecording(take('a'), takeFiles(10))
    await other.saveRecording(take('b'), takeFiles(20))
    const archive = await other.exportAll()
    other.close()
    const deps = await testDeps()
    await deps.storage.saveRecording(take('a'), takeFiles(10))
    const model = new LibraryModel(deps)
    const outcome = await model.restore(new File([archive], 'backup.pianissimo.zip'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.report.recordings).toEqual({ added: 1, skipped: 1, failed: 0 })
    expect(describeRestore(outcome.report)[0]).toBe('Recordings: 1 added, 1 already on this device')
    expect(model.recordings.value).toEqual({ count: 2, bytes: 36 })
  })
})

describe('describeRestore', () => {
  const report = (over: Partial<RestoreReport>): RestoreReport => {
    const none = { added: 0, updated: 0, unchanged: 0, skipped: 0 }
    return {
      manifest: {
        format: 'pianissimo-backup',
        formatVersion: 1,
        appVersion: 'x',
        createdAt: 0,
        dbVersion: 4,
        counts: {
          pieces: 0,
          packages: 0,
          sources: 0,
          attempts: 0,
          measureHistory: 0,
          suggestionState: 0,
          abandonEvents: 0,
          settings: 0,
        },
      },
      stores: {
        pieces: none,
        packages: none,
        sources: none,
        attempts: none,
        measureHistory: none,
        suggestionState: none,
        abandonEvents: none,
      },
      recordings: { added: 0, skipped: 0, failed: 0 },
      settings: 'not-in-backup',
      warnings: [],
      ...over,
    }
  }

  it('counts takes added, already here and failed, so a backup of takes alone is not "already on this device"', () => {
    expect(describeRestore(report({ recordings: { added: 2, skipped: 1, failed: 1 } }))).toEqual([
      'Recordings: 2 added, 1 already on this device, 1 failed',
      'The backup had no settings. Yours were kept.',
    ])
  })

  it('says that restored settings leave out the piano connection, the metronome output and the recording input', () => {
    expect(describeRestore(report({ settings: 'restored' })).at(-1)).toBe(
      'Settings were restored from the backup (this device keeps its own piano connection, metronome output and recording input).',
    )
  })

  it('says when the backup left recordings out', () => {
    const base = report({})
    expect(describeRestore({ ...base, manifest: { ...base.manifest, recordingsExcluded: true } })).toEqual([
      'Everything in the backup was already on this device.',
      'The backup did not include recordings.',
      'The backup had no settings. Yours were kept.',
    ])
  })

  it('speaks the interface language', () => {
    const strings = Object.fromEntries(Object.entries(es).map(([id, value]) => [en[id as keyof typeof en], value]))
    readMessagesWith(() => ({ language: 'es-ES', strings }))
    expect(describeRestore(report({ recordings: { added: 2, skipped: 0, failed: 1 } }))[0]).toBe(
      'Grabaciones: 2 añadidos, 1 con error',
    )
  })
})
