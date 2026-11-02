import 'fake-indexeddb/auto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { comparisonContext } from '../history/testkit'
import { measureContextKey } from '../model/practice'
import { toMeasureContext } from '../history/contextKey'
import { DEFAULT_SETTINGS } from '../model/settings'
import type { AppSettings } from '../model/settings'
import { exportBackup, restoreBackup } from './backup'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, backupFileName } from './backupFormat'
import type { BackupManifest } from './backupFormat'
import { BackupError } from './errors'
import { openPianissimoDb } from './schema'
import type { PianissimoStorage } from './storage'
import { attemptFor, importPiece, makePackage, makePiece, makeSource, openFresh } from './testkit'

const open: PianissimoStorage[] = []
async function fresh(options: Parameters<typeof openFresh>[0] = {}): Promise<PianissimoStorage> {
  const s = await openFresh(options)
  open.push(s)
  return s
}
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})

const MKEY = measureContextKey(toMeasureContext(comparisonContext()))

const CUSTOM_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  naming: { ...DEFAULT_SETTINGS.naming, system: 'fixed-do', simplifyEnharmonics: true },
  labels: {
    mode: 'conditional',
    rules: {
      G2: {
        below: { enabled: true, threshold: { step: 'C', alter: 0, octave: 4 } },
        above: { enabled: true, threshold: { step: 'C', alter: 0, octave: 5 } },
      },
      F4: {
        below: { enabled: true, threshold: { step: 'E', alter: 0, octave: 2 } },
        above: { enabled: false, threshold: null },
      },
    },
    tiedContinuations: true,
  },
  hints: { autoThreshold: 3, lifetime: 'until-correct', fadeMs: 250, damageFlash: false },
  suggestions: { enabled: false },
  route: {
    ...DEFAULT_SETTINGS.route,
    inputId: 'in-9',
    inputName: 'Digital Piano',
    outputId: 'out-9',
    outputName: 'Digital Piano',
    outputVerified: true,
    echo: 'none',
    connection: 'usb',
  },
}

/** A library with two pieces, results, histories, settings and cached layouts. */
async function populate(s: PianissimoStorage) {
  const a = await importPiece(s, 'v1', { title: 'Etude', lastOpenedAt: 500 })
  const b = await importPiece(s, 'v2', { title: 'Nocturne', lastOpenedAt: 400 })
  await s.putPackage(makePackage('v1', 'Etude', { confirmed: true, tempo: true }))
  await s.updatePiece(a.piece.id, {
    lastMultiplier: 0.75,
    lastHands: 'right',
    resume: { occ: 7, position: { n: 7, d: 1 }, hands: 'right', multiplier: 0.75, savedAt: 5 },
  })
  for (let i = 0; i < 3; i += 1)
    s.history.queueAttempt(
      attemptFor(a.piece.id, [
        [12, 'error'],
        [13, 'clean'],
      ]),
    )
  s.history.queueAttempt(attemptFor(b.piece.id, [[2, 'clean']]))
  for (let i = 0; i < 3; i += 1) {
    s.history.queueAbandon({ pieceId: b.piece.id, measureContextKey: MKEY, occ: 6, at: 7_000 + i, reason: 'user-stop' })
  }
  await s.history.flush()
  await s.setSuggestionsDisabled(b.piece.id, true)
  await s.saveSettings(CUSTOM_SETTINGS)
  await s.putLayout('layout-1', 'v1', { derived: true }, 100)
  return { a: a.piece, b: b.piece }
}

async function snapshot(s: PianissimoStorage) {
  const pieces = await s.listPieces()
  return {
    pieces,
    packages: await Promise.all(pieces.map((p) => s.getPackage(p.scoreVersionId))),
    sources: await Promise.all(
      pieces.map(async (p) => {
        const src = await s.getSource(p.scoreVersionId)
        return src ? { ...src, bytes: [...new Uint8Array(src.bytes)] } : undefined
      }),
    ),
    attempts: await Promise.all(pieces.map((p) => s.listAttempts({ pieceId: p.id }))),
    history: await Promise.all(pieces.map((p) => s.loadPieceHistory(p.id))),
    settings: await s.loadSettings(),
  }
}

/** Rebuild a backup after editing its files. */
function edit(bytes: Uint8Array, change: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(bytes)
  change(files)
  return zipSync(files)
}
const json = (files: Record<string, Uint8Array>, name: string): unknown => JSON.parse(strFromU8(files[name]!))
const put = (files: Record<string, Uint8Array>, name: string, value: unknown): void => {
  files[name] = strToU8(JSON.stringify(value))
}

async function expectBackupError(run: Promise<unknown>, code: BackupError['code']): Promise<BackupError> {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(BackupError)
  expect((error as BackupError).code).toBe(code)
  return error as BackupError
}

describe('export', () => {
  it('writes a manifest, one JSON file per store, the original sources and every package', async () => {
    const s = await fresh({ appVersion: '9.9.9', now: () => 1_700_000_123_000 })
    await populate(s)
    const bytes = await s.exportAll()
    const files = unzipSync(bytes)
    expect(Object.keys(files).sort()).toEqual([
      'abandonEvents.json',
      'attempts.json',
      'manifest.json',
      'measureHistory.json',
      'packages/v1.json',
      'packages/v2.json',
      'pieces.json',
      'settings.json',
      'sources.json',
      'sources/v1.bin',
      'sources/v2.bin',
      'suggestionState.json',
    ])
    const manifest = json(files, 'manifest.json') as BackupManifest
    expect(manifest).toMatchObject({
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: '9.9.9',
      createdAt: 1_700_000_123_000,
      counts: { pieces: 2, packages: 2, sources: 2, attempts: 4, settings: 1 },
    })
    expect(manifest.counts.measureHistory).toBeGreaterThan(0)
    expect(new Uint8Array(files['sources/v1.bin']!)).toEqual(new Uint8Array(makeSource('v1').bytes))
    expect(json(files, 'settings.json')).toEqual({ settings: CUSTOM_SETTINGS })
  })

  it('excludes the derived layout cache', async () => {
    const s = await fresh()
    await populate(s)
    const files = unzipSync(await s.exportAll())
    expect(Object.keys(files).some((n) => /layout/i.test(n))).toBe(false)
    expect(JSON.stringify(Object.values(files).map((f) => strFromU8(f).slice(0, 4000)))).not.toContain('derived')
  })

  it('exports an empty library', async () => {
    const s = await fresh()
    const files = unzipSync(await s.exportAll())
    expect((json(files, 'manifest.json') as BackupManifest).counts).toEqual({
      pieces: 0,
      packages: 0,
      sources: 0,
      attempts: 0,
      measureHistory: 0,
      suggestionState: 0,
      abandonEvents: 0,
      settings: 0,
    })
    const target = await fresh()
    const report = await target.restore(await s.exportAll())
    expect(report.settings).toBe('not-in-backup')
    expect(await target.listPieces()).toEqual([])
  })

  it('includes records still queued for writing', async () => {
    const s = await fresh()
    const { piece } = await importPiece(s, 'v1')
    s.history.queueAttempt(attemptFor(piece.id, [[1, 'clean']]))
    const files = unzipSync(await s.exportAll())
    expect((json(files, 'attempts.json') as unknown[]).length).toBe(1)
  })

  it('names the file after the date', () => {
    expect(backupFileName(new Date(2026, 9, 28, 12).getTime())).toBe('pianissimo-2026-10-28.pianissimo.zip')
  })

  it('keeps ids with unusual characters in safe entry names and restores them', async () => {
    const s = await fresh()
    await importPiece(s, 'sha256:ab/cd e', { title: 'Odd id' })
    const bytes = await s.exportAll()
    expect(Object.keys(unzipSync(bytes))).toContain('packages/sha256%3Aab%2Fcd%20e.json')
    const target = await fresh()
    await target.restore(bytes)
    expect(await target.getPackage('sha256:ab/cd e')).toBeDefined()
    expect(await target.getSource('sha256:ab/cd e')).toBeDefined()
  })
})

describe('restore into an empty browser', () => {
  it("reproduces the library, histories and settings (the route stays this browser's)", async () => {
    const source = await fresh()
    const { a, b } = await populate(source)
    const bytes = await source.exportAll()

    const target = await fresh()
    const report = await target.restore(bytes)
    expect(report.settings).toBe('restored')
    expect(report.warnings).toEqual([])
    expect(report.stores.pieces).toEqual({ added: 2, updated: 0, unchanged: 0, skipped: 0 })
    expect(report.stores.packages.added).toBe(2)
    expect(report.stores.sources.added).toBe(2)
    expect(report.stores.attempts.added).toBe(4)
    expect(report.manifest.formatVersion).toBe(1)

    const expected = await snapshot(source)
    const actual = await snapshot(target)
    expect(actual.pieces).toEqual(expected.pieces)
    expect(actual.packages).toEqual(expected.packages)
    expect(actual.sources).toEqual(expected.sources)
    expect(actual.attempts).toEqual(expected.attempts)
    expect(actual.history).toEqual(expected.history)
    expect(actual.settings).toEqual({ ...CUSTOM_SETTINGS, route: DEFAULT_SETTINGS.route })
    expect((await target.loadPieceHistory(b.id)).disabled).toBe(true)
    expect((await target.loadPieceHistory(a.id)).suggestions).toHaveLength(1)
    // The layout cache is derived and does not travel.
    expect(await target.getLayout('layout-1')).toBeUndefined()
  })

  it('label settings (mode and per-clef conditions) survive export and restore', async () => {
    const source = await fresh()
    await source.saveSettings(CUSTOM_SETTINGS)
    const target = await fresh()
    await target.restore(await source.exportAll())
    const restored = await target.loadSettings()
    expect(restored.labels).toEqual(CUSTOM_SETTINGS.labels)
    expect(restored.naming).toEqual(CUSTOM_SETTINGS.naming)
    expect(restored.hints).toEqual(CUSTOM_SETTINGS.hints)
  })

  it('keeps suggestion progress and recovery streaks, so recovery continues on the new device', async () => {
    const source = await fresh()
    const { piece } = await importPiece(source, 'v1')
    for (let i = 0; i < 3; i += 1) source.history.queueAttempt(attemptFor(piece.id, [[12, 'error']]))
    for (let i = 0; i < 2; i += 1) source.history.queueAttempt(attemptFor(piece.id, [[12, 'clean']]))
    await source.history.flush()

    const target = await fresh()
    await target.restore(await source.exportAll())
    const restored = await target.loadPieceHistory(piece.id)
    expect(Object.values(restored.bars)[0]?.cleanStreak).toBe(2)
    target.history.queueAttempt(attemptFor(piece.id, [[12, 'clean']]))
    expect((await target.loadPieceHistory(piece.id)).suggestions[0]?.status).toBe('improved')
  })

  it('restores a record set larger than one merge chunk', async () => {
    const source = await fresh()
    const { piece } = await importPiece(source, 'v1')
    await source.addAttempts(Array.from({ length: 450 }, () => attemptFor(piece.id, [[1, 'clean']])))
    const target = await fresh()
    const report = await target.restore(await source.exportAll())
    expect(report.stores.attempts.added).toBe(450)
    expect(await target.listAttempts({ pieceId: piece.id })).toHaveLength(450)
  })

  it('is idempotent: restoring the same backup again changes nothing', async () => {
    const source = await fresh()
    await populate(source)
    const bytes = await source.exportAll()
    const target = await fresh()
    await target.restore(bytes)
    const before = await snapshot(target)
    const report = await target.restore(bytes)
    for (const counts of Object.values(report.stores)) {
      expect(counts.added).toBe(0)
      expect(counts.updated).toBe(0)
    }
    expect(await snapshot(target)).toEqual(before)
  })

  it('can restore from a freshly opened database of another name (second device)', async () => {
    const source = await fresh()
    const { a } = await populate(source)
    const second = await fresh()
    await second.restore(await source.exportAll())
    expect((await second.getPiece(a.id))?.resume?.occ).toBe(7)
  })
})

describe('restore merges by id and never deletes local data', () => {
  it('adds the backup next to what is already there', async () => {
    const source = await fresh()
    const { a } = await populate(source)
    const bytes = await source.exportAll()

    const target = await fresh()
    const local = await importPiece(target, 'local', { title: 'Local only' })
    target.history.queueAttempt(attemptFor(local.piece.id, [[1, 'clean']]))
    await target.history.flush()
    await target.saveSettings({ ...DEFAULT_SETTINGS, view: { ...DEFAULT_SETTINGS.view, zoom: 2 } })

    await target.restore(bytes)
    const titles = (await target.listPieces()).map((p) => p.title).sort()
    expect(titles).toEqual(['Etude', 'Local only', 'Nocturne'])
    expect(await target.getPackage('local')).toEqual(local.pkg)
    expect(await target.listAttempts({ pieceId: local.piece.id })).toHaveLength(1)
    expect(await target.listAttempts({ pieceId: a.id })).toHaveLength(3)
  })

  it('resolves a piece present on both sides by recency and keeps a tempo from either side', async () => {
    const source = await fresh()
    const pkg = makePackage('v1')
    const base = makePiece(pkg, { id: 'shared', lastOpenedAt: 1_000 })
    await source.commitImport({ source: makeSource('v1'), pkg, piece: base })
    await source.updatePiece('shared', {
      lastOpenedAt: 9_000,
      lastMultiplier: 1.5,
      resume: { occ: 3, position: { n: 3, d: 1 }, hands: 'both', multiplier: 1.5, savedAt: 9_000 },
    })
    const bytes = await source.exportAll()

    const target = await fresh()
    await target.commitImport({ source: makeSource('v1'), pkg, piece: base })
    await target.updatePiece('shared', {
      lastOpenedAt: 2_000,
      lastMultiplier: 0.5,
      userTempo: { beatBpm: 90, beatUnit: { n: 1, d: 4 } },
    })
    const report = await target.restore(bytes)
    expect(report.stores.pieces.updated).toBe(1)
    const merged = await target.getPiece('shared')
    expect(merged).toMatchObject({ lastOpenedAt: 9_000, lastMultiplier: 1.5, userTempo: { beatBpm: 90 } })
    expect(merged?.resume?.occ).toBe(3)

    // An older backup does not overwrite newer local state.
    const older = await fresh()
    await older.commitImport({ source: makeSource('v1'), pkg, piece: { ...base, lastOpenedAt: 10, lastMultiplier: 2 } })
    await target.restore(await older.exportAll())
    expect((await target.getPiece('shared'))?.lastMultiplier).toBe(1.5)
  })

  it('never replaces an existing attempt and ignores nothing else', async () => {
    const source = await fresh()
    const { piece } = await importPiece(source, 'v1')
    const original = attemptFor(piece.id, [[1, 'clean']], { id: 'same-id', wrongAttacks: 0 })
    await source.addAttempts([original])
    const bytes = await source.exportAll()

    const target = await fresh()
    await importPiece(target, 'v1')
    await target.addAttempts([{ ...original, wrongAttacks: 9 }])
    const report = await target.restore(bytes)
    expect(report.stores.attempts.unchanged).toBe(1)
    expect((await target.getAttempt('same-id'))?.wrongAttacks).toBe(9)
  })

  it('keeps the package with more user input: confirmed hands and tempo', async () => {
    const source = await fresh()
    await importPiece(source, 'v1')
    await source.putPackage(makePackage('v1', 'Piece v1', { confirmed: true, tempo: true }))
    const confirmed = await source.exportAll()

    const target = await fresh()
    await importPiece(target, 'v1')
    const report = await target.restore(confirmed)
    expect(report.stores.packages.updated).toBe(1)
    expect((await target.getPackage('v1'))?.model.hands.confirmed).toBe(true)

    const plain = await fresh()
    await importPiece(plain, 'v1')
    await target.restore(await plain.exportAll())
    expect((await target.getPackage('v1'))?.model.hands.confirmed).toBe(true)
  })

  it('keeps the piece record and its package consistent', async () => {
    const unit = { n: 1, d: 4 }
    const withTempo = (bpm: number, hand: 'L' | 'R') => {
      const pkg = makePackage('vT', 'Etude', { confirmed: true, tempo: true })
      const [segment] = pkg.model.tempo.segments
      return {
        ...pkg,
        model: {
          ...pkg.model,
          hands: { ...pkg.model.hands, byVoice: { 'P1/1': hand } },
          tempo: { segments: [{ ...segment!, beatBpm: bpm, quarterBpm: bpm }] },
        },
      }
    }
    const laptop = await fresh()
    const ipad = await fresh()
    const p80 = withTempo(80, 'R')
    await laptop.commitImport({
      source: makeSource('vT'),
      pkg: p80,
      piece: makePiece(p80, { id: 'p', lastOpenedAt: 100, userTempo: { beatBpm: 80, beatUnit: unit } }),
    })
    await laptop.putLayout('laptop-layout', 'vT', { hands: 'R' }, 10)
    const p100 = withTempo(100, 'L')
    await ipad.commitImport({
      source: makeSource('vT'),
      pkg: p100,
      piece: makePiece(p100, { id: 'p', lastOpenedAt: 200, userTempo: { beatBpm: 100, beatUnit: unit } }),
    })

    const report = await laptop.restore(await ipad.exportAll())
    expect(report.stores.packages.updated).toBe(1)
    const piece = (await laptop.getPiece('p'))!
    const pkg = (await laptop.getPackage('vT'))!
    expect(pkg.model.tempo.segments[0]!.beatBpm).toBe(piece.userTempo!.beatBpm)
    expect(piece.userTempo?.beatBpm).toBe(100)
    expect(pkg.model.hands.byVoice).toEqual({ 'P1/1': 'L' }) // the iPad's hand reassignment comes along
    expect(await laptop.getLayout('laptop-layout')).toBeUndefined() // engraved with the old hands

    // The other way round, the more recently opened local piece keeps its package.
    const older = await fresh()
    await older.commitImport({
      source: makeSource('vT'),
      pkg: p80,
      piece: makePiece(p80, { id: 'p', lastOpenedAt: 50, userTempo: { beatBpm: 80, beatUnit: unit } }),
    })
    await laptop.restore(await older.exportAll())
    expect((await laptop.getPackage('vT'))?.model.tempo.segments[0]?.beatBpm).toBe(100)
    expect((await laptop.getPiece('p'))?.userTempo?.beatBpm).toBe(100)
  })

  it('merges measure histories (newer wins), suggestions and abandon events', async () => {
    const remote = await fresh()
    const { piece } = await importPiece(remote, 'v1')
    const pkg = makePackage('v1')
    for (let i = 0; i < 3; i += 1)
      remote.history.queueAttempt(attemptFor(piece.id, [[12, 'error']], { createdAt: 10_000 + i }))
    for (let i = 0; i < 3; i += 1) {
      remote.history.queueAbandon({
        pieceId: piece.id,
        measureContextKey: MKEY,
        occ: 20,
        at: 5_000 + i,
        reason: 'user-restart',
      })
    }
    await remote.history.flush()
    const bytes = await remote.exportAll()

    const local = await fresh()
    await local.commitImport({ source: makeSource('v1'), pkg, piece })
    for (let i = 0; i < 4; i += 1)
      local.history.queueAttempt(attemptFor(piece.id, [[12, 'error']], { createdAt: 20_000 + i }))
    local.history.queueAttempt(attemptFor(piece.id, [[30, 'error']], { createdAt: 21_000 }))
    for (let i = 0; i < 2; i += 1) {
      local.history.queueAbandon({
        pieceId: piece.id,
        measureContextKey: MKEY,
        occ: 20,
        at: 6_000 + i,
        reason: 'user-stop',
      })
    }
    await local.history.flush()
    await local.setSuggestionsDisabled(piece.id, true)

    await local.restore(bytes)
    const history = await local.loadPieceHistory(piece.id)
    expect(history.disabled).toBe(true) // the local switch wins
    const bar12 = Object.values(history.bars).find((b) => b.occ === 12)
    expect(bar12?.updatedAt).toBe(20_003) // local was newer
    expect(Object.values(history.bars).some((b) => b.occ === 30)).toBe(true) // local-only bar survives
    expect(history.abandons[`${MKEY}#20`]?.map((e) => e.at)).toEqual([5_000, 5_001, 5_002, 6_000, 6_001].slice(-5))
    expect(history.suggestions.filter((s) => s.status === 'active').length).toBeGreaterThan(0)
  })

  it('skips records of pieces it cannot restore and says why', async () => {
    const source = await fresh()
    const { piece } = await importPiece(source, 'v1')
    source.history.queueAttempt(attemptFor(piece.id, [[1, 'clean']]))
    await source.history.flush()
    const bytes = edit(await source.exportAll(), (files) => {
      // Simulate a backup in which the package of the piece was lost.
      delete files['packages/v1.json']
      delete files['sources/v1.bin']
      const manifest = json(files, 'manifest.json') as BackupManifest
      put(files, 'manifest.json', { ...manifest, counts: { ...manifest.counts, packages: 0, sources: 0 } })
      put(files, 'sources.json', [])
    })
    const target = await fresh()
    const report = await target.restore(bytes)
    expect(report.warnings).toEqual(['"Piece v1" was skipped: its score data is not in the backup.'])
    expect(report.stores.pieces.skipped).toBe(1)
    expect(report.stores.attempts.skipped).toBe(1)
    expect(await target.listPieces()).toEqual([])
    expect(await target.listAttempts({ pieceId: piece.id })).toEqual([])
  })

  it('accepts a piece whose package already exists locally', async () => {
    const source = await fresh()
    const { piece } = await importPiece(source, 'v1')
    const bytes = edit(await source.exportAll(), (files) => {
      delete files['packages/v1.json']
      delete files['sources/v1.bin']
      const manifest = json(files, 'manifest.json') as BackupManifest
      put(files, 'manifest.json', { ...manifest, counts: { ...manifest.counts, packages: 0, sources: 0 } })
      put(files, 'sources.json', [])
    })
    const target = await fresh()
    await target.commitImport({
      source: makeSource('v1'),
      pkg: makePackage('v1'),
      piece: makePiece(makePackage('v1'), { id: 'other' }),
    })
    const report = await target.restore(bytes)
    expect(report.warnings).toEqual([])
    expect((await target.getPiece(piece.id))?.scoreVersionId).toBe('v1')
  })
})

describe('settings policy', () => {
  async function pair() {
    const source = await fresh()
    await source.saveSettings(CUSTOM_SETTINGS)
    const bytes = await source.exportAll()
    const target = await fresh()
    const localRoute = { ...DEFAULT_SETTINGS.route, inputId: 'local-in', inputName: 'Local', outputVerified: false }
    await target.saveSettings({ ...DEFAULT_SETTINGS, route: localRoute, view: { ...DEFAULT_SETTINGS.view, zoom: 3 } })
    return { bytes, target, localRoute }
  }

  it("restores the backup settings but keeps this browser's MIDI route by default", async () => {
    const { bytes, target, localRoute } = await pair()
    const report = await target.restore(bytes)
    expect(report.settings).toBe('restored')
    const settings = await target.loadSettings()
    expect(settings.labels).toEqual(CUSTOM_SETTINGS.labels)
    expect(settings.view.zoom).toBe(1)
    expect(settings.route).toEqual(localRoute)
  })

  it('restores the route too when asked', async () => {
    const { bytes, target } = await pair()
    await target.restore(bytes, { route: 'backup' })
    expect((await target.loadSettings()).route).toEqual(CUSTOM_SETTINGS.route)
  })

  it('leaves local settings alone when asked', async () => {
    const { bytes, target, localRoute } = await pair()
    const report = await target.restore(bytes, { settings: 'keep' })
    expect(report.settings).toBe('kept')
    const settings = await target.loadSettings()
    expect(settings.view.zoom).toBe(3)
    expect(settings.route).toEqual(localRoute)
    expect(settings.labels).toEqual(DEFAULT_SETTINGS.labels)
  })

  it('leaves local settings alone when the backup has none', async () => {
    const source = await fresh()
    const target = await fresh()
    await target.saveSettings(CUSTOM_SETTINGS)
    const report = await target.restore(await source.exportAll())
    expect(report.settings).toBe('not-in-backup')
    expect((await target.loadSettings()).labels).toEqual(CUSTOM_SETTINGS.labels)
  })
})

describe('invalid backups are refused with a readable error and write nothing', () => {
  async function good(): Promise<{ bytes: Uint8Array; target: PianissimoStorage }> {
    const source = await fresh()
    await populate(source)
    const target = await fresh()
    await importPiece(target, 'keep', { title: 'Keep me' })
    return { bytes: await source.exportAll(), target }
  }

  async function untouched(target: PianissimoStorage): Promise<void> {
    expect((await target.listPieces()).map((p) => p.title)).toEqual(['Keep me'])
    expect(await target.getPackage('v1')).toBeUndefined()
    expect(await target.listAttempts({ pieceId: 'piece-v1' })).toEqual([])
    expect(await target.loadSettings()).toEqual(DEFAULT_SETTINGS)
  }

  it('rejects files that are not zip archives', async () => {
    const { target } = await good()
    for (const bytes of [new Uint8Array(0), strToU8('{"hello":"world"}'), new Uint8Array(500).fill(7)]) {
      const error = await expectBackupError(target.restore(bytes), 'not-a-backup')
      expect(error.message).toMatch(/not a Pianissimo backup/)
    }
    await untouched(target)
  })

  it('rejects a zip that is not a Pianissimo backup', async () => {
    const { target } = await good()
    await expectBackupError(target.restore(zipSync({ 'notes.txt': strToU8('hello') })), 'not-a-backup')
    await expectBackupError(
      target.restore(
        zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'something-else', formatVersion: 1 })) }),
      ),
      'not-a-backup',
    )
    await untouched(target)
  })

  it('rejects a backup written by a newer format with advice to update', async () => {
    const { bytes, target } = await good()
    const newer = edit(bytes, (files) => {
      const manifest = json(files, 'manifest.json') as BackupManifest
      put(files, 'manifest.json', { ...manifest, formatVersion: BACKUP_FORMAT_VERSION + 1, appVersion: '9.0.0' })
    })
    const error = await expectBackupError(target.restore(newer), 'unsupported-version')
    expect(error.message).toMatch(/Update the app/)
    expect(error.message).toMatch(/9\.0\.0/)
    await untouched(target)
  })

  it('rejects a truncated file', async () => {
    const { bytes, target } = await good()
    const error = await expectBackupError(target.restore(bytes.subarray(0, Math.floor(bytes.length / 2))), 'damaged')
    expect(error.message).toMatch(/damaged/)
    await untouched(target)
  })

  it('rejects a backup with a missing file or a count that does not match the manifest', async () => {
    const { bytes, target } = await good()
    const missing = edit(bytes, (files) => {
      delete files['attempts.json']
    })
    expect((await expectBackupError(target.restore(missing), 'damaged')).message).toMatch(/attempts\.json is missing/)

    const short = edit(bytes, (files) => {
      put(files, 'attempts.json', (json(files, 'attempts.json') as unknown[]).slice(1))
    })
    expect((await expectBackupError(target.restore(short), 'damaged')).message).toMatch(
      /lists 4 attempts but contains 3/,
    )

    const lostPackage = edit(bytes, (files) => {
      delete files['packages/v2.json']
    })
    expect((await expectBackupError(target.restore(lostPackage), 'damaged')).message).toMatch(/score packages/)

    const notJson = edit(bytes, (files) => {
      files['pieces.json'] = strToU8('{ not json')
    })
    expect((await expectBackupError(target.restore(notJson), 'damaged')).message).toMatch(/pieces\.json.*not readable/)
    await untouched(target)
  })

  it('rejects records of the wrong shape and names them', async () => {
    const { bytes, target } = await good()
    const badPiece = edit(bytes, (files) => {
      const pieces = json(files, 'pieces.json') as Array<Record<string, unknown>>
      pieces[1] = { ...pieces[1], title: 42 }
      put(files, 'pieces.json', pieces)
    })
    const error = await expectBackupError(target.restore(badPiece), 'invalid')
    expect(error.problems).toEqual(['pieces.json[1] title is missing or invalid'])
    expect(error.message).toMatch(/Nothing was restored/)

    const badAttempt = edit(bytes, (files) => {
      const attempts = json(files, 'attempts.json') as Array<Record<string, unknown>>
      attempts[0] = { ...attempts[0], completion: 'exploded' }
      put(files, 'attempts.json', attempts)
    })
    expect((await expectBackupError(target.restore(badAttempt), 'invalid')).problems[0]).toMatch(
      /attempts\.json\[0\] completion/,
    )

    const badBar = edit(bytes, (files) => {
      const bars = json(files, 'measureHistory.json') as Array<Record<string, unknown>>
      bars[0] = { ...bars[0], recent: 'lots' }
      put(files, 'measureHistory.json', bars)
    })
    expect((await expectBackupError(target.restore(badBar), 'invalid')).problems[0]).toMatch(
      /measureHistory\.json\[0\] recent/,
    )
    await untouched(target)
  })

  it('rejects a score package from an unsupported format', async () => {
    const { bytes, target } = await good()
    const future = edit(bytes, (files) => {
      const pkg = json(files, 'packages/v1.json') as { model: Record<string, unknown> }
      put(files, 'packages/v1.json', { ...pkg, model: { ...pkg.model, format: 99 } })
    })
    const error = await expectBackupError(target.restore(future), 'invalid')
    expect(error.problems[0]).toMatch(/format 99 is not supported/)
    await untouched(target)
  })

  it('rejects a damaged source file by checksum', async () => {
    const { bytes, target } = await good()
    const corrupted = edit(bytes, (files) => {
      const data = new Uint8Array(files['sources/v1.bin']!)
      data[3] = (data[3]! + 1) & 0xff
      files['sources/v1.bin'] = data
    })
    const error = await expectBackupError(target.restore(corrupted), 'invalid')
    expect(error.problems[0]).toMatch(/checksum mismatch/)
    await untouched(target)
  })

  it('rejects a source whose size does not match the index', async () => {
    const { bytes, target } = await good()
    const resized = edit(bytes, (files) => {
      files['sources/v2.bin'] = new Uint8Array(files['sources/v2.bin']!).subarray(0, 10)
    })
    expect((await expectBackupError(target.restore(resized), 'invalid')).problems[0]).toMatch(/size does not match/)
    await untouched(target)
  })

  it('reports at most twenty problems', async () => {
    const { bytes, target } = await good()
    const many = edit(bytes, (files) => {
      const attempts = json(files, 'attempts.json') as Array<Record<string, unknown>>
      put(
        files,
        'attempts.json',
        Array.from({ length: 50 }, () => ({ ...attempts[0], passed: 'yes' })),
      )
      const manifest = json(files, 'manifest.json') as BackupManifest
      put(files, 'manifest.json', { ...manifest, counts: { ...manifest.counts, attempts: 50 } })
    })
    expect((await expectBackupError(target.restore(many), 'invalid')).problems).toHaveLength(20)
  })

  it('is atomic: a storage failure part-way through leaves the library exactly as it was', async () => {
    const source = await fresh()
    await populate(source)
    const bytes = await source.exportAll()

    const real = await openPianissimoDb(`atomic-${Math.random()}`)
    try {
      const before = await Promise.all(
        (['pieces', 'packages', 'sources', 'attempts', 'measureHistory', 'settings'] as const).map((n) =>
          real.count(n),
        ),
      )
      let puts = 0
      const failing = new Proxy(real, {
        get(target, prop) {
          if (prop === 'transaction') {
            return (...args: [never, never]) => {
              const tx = (target.transaction as (...a: unknown[]) => unknown)(...args) as object
              return new Proxy(tx, {
                get(t, p) {
                  if (p === 'objectStore') {
                    return (name: string) => {
                      const store = (t as { objectStore(n: string): object }).objectStore(name)
                      return new Proxy(store, {
                        get(s, q) {
                          if (name === 'attempts' && q === 'put') {
                            return (...a: unknown[]) => {
                              puts += 1
                              if (puts > 2) throw new Error('disk full')
                              return (s as { put(...x: unknown[]): unknown }).put(...a)
                            }
                          }
                          const v = Reflect.get(s, q) as unknown
                          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(s) : v
                        },
                      })
                    }
                  }
                  const v = Reflect.get(t, p) as unknown
                  return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
                },
              })
            }
          }
          const v = Reflect.get(target, prop) as unknown
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v
        },
      })
      await expect(restoreBackup(failing, bytes)).rejects.toThrow(/disk full/)
      expect(puts).toBeGreaterThan(2)
      const after = await Promise.all(
        (['pieces', 'packages', 'sources', 'attempts', 'measureHistory', 'settings'] as const).map((n) =>
          real.count(n),
        ),
      )
      expect(after).toEqual(before)
      // The same backup restores fine once storage works again.
      const report = await restoreBackup(real, bytes)
      expect(report.stores.pieces.added).toBe(2)
    } finally {
      real.close()
    }
  })

  it('exportBackup/restoreBackup also work directly on a database handle', async () => {
    const db = await openPianissimoDb(`direct-${Math.random()}`)
    try {
      const bytes = await exportBackup(db, { now: 5 })
      const report = await restoreBackup(db, bytes)
      expect(report.manifest.createdAt).toBe(5)
    } finally {
      db.close()
    }
  })
})
