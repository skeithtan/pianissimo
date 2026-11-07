import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { attemptRecord } from '../history/testkit'
import { DEFAULT_SETTINGS } from '../model/settings'
import type { ScorePackage } from '../model/score'
import { DB_VERSION, openPianissimoDb } from './schema'
import { openStorage } from './storage'
import type { PianissimoStorage } from './storage'
import { newPieceRecord } from './records'
import { attemptFor, freshName, importPiece, makePackage, makePiece, makeSource, openFresh } from './testkit'

const open: PianissimoStorage[] = []
async function storage(): Promise<PianissimoStorage> {
  const s = await openFresh()
  open.push(s)
  return s
}
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})

describe('schema', () => {
  it('creates every store and index on first open', async () => {
    const name = freshName()
    const db = await openPianissimoDb(name)
    expect(db.version).toBe(DB_VERSION)
    expect([...db.objectStoreNames].sort()).toEqual([
      'abandonEvents',
      'attempts',
      'layoutCache',
      'layoutMeta',
      'measureHistory',
      'packages',
      'pieces',
      'settings',
      'sources',
      'suggestionState',
    ])
    const tx = db.transaction(['attempts', 'pieces', 'layoutMeta'], 'readonly')
    expect([...tx.objectStore('attempts').indexNames].sort()).toEqual(['contextKey', 'pieceId'])
    expect([...tx.objectStore('pieces').indexNames].sort()).toEqual(['lastOpenedAt', 'scoreVersionId'])
    expect([...tx.objectStore('layoutMeta').indexNames].sort()).toEqual(['lastUsedAt', 'scoreVersionId'])
    await tx.done
    db.close()
  })

  it('keeps data across close and reopen', async () => {
    const name = freshName()
    const first = await openStorage(name)
    const { piece } = await importPiece(first, 'v1')
    first.close()
    const second = await openStorage(name)
    open.push(second)
    expect((await second.getPiece(piece.id))?.title).toBe(piece.title)
    expect(await second.getPackage('v1')).toBeDefined()
  })
})

describe('pieces', () => {
  it('lists the library most recently opened first', async () => {
    const s = await storage()
    await importPiece(s, 'a', { lastOpenedAt: 100 })
    await importPiece(s, 'b', { lastOpenedAt: 300 })
    await importPiece(s, 'c', { lastOpenedAt: 200 })
    expect((await s.listPieces()).map((p) => p.scoreVersionId)).toEqual(['b', 'c', 'a'])
  })

  it('keeps the per-piece state the spec asks to remember', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    expect(piece).toMatchObject({
      lastMultiplier: 1,
      lastHands: 'both',
      resume: null,
      lastPassage: null,
      repeatTarget: null,
      ladder: null,
    })
    const updated = await s.updatePiece(piece.id, {
      lastMultiplier: 0.75,
      lastHands: 'left',
      userTempo: { beatBpm: 60, beatUnit: { n: 3, d: 8 } },
      resume: { occ: 12, position: { n: 25, d: 2 }, group: 7, hands: 'left', multiplier: 0.75, savedAt: 5 },
      lastPassage: { fromOcc: 8, toOcc: 15 },
      repeatTarget: 3,
      ladder: { goal: 1, step: 0.05 },
    })
    expect(updated?.lastMultiplier).toBe(0.75)
    expect(updated?.ladder).toEqual({ goal: 1, step: 0.05 })
    expect(await s.getPiece(piece.id)).toEqual(updated)
  })

  it('applies concurrent patches without losing either', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    await Promise.all([
      s.updatePiece(piece.id, { lastMultiplier: 1.5 }),
      s.updatePiece(piece.id, { lastHands: 'right' }),
      s.updatePiece(piece.id, { repeatTarget: 5 }),
    ])
    expect(await s.getPiece(piece.id)).toMatchObject({ lastMultiplier: 1.5, lastHands: 'right', repeatTarget: 5 })
  })

  it('rejects invalid updates and leaves the record unchanged', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    await expect(s.updatePiece(piece.id, { lastMultiplier: 0 })).rejects.toThrow(/lastMultiplier/)
    await expect(s.updatePiece(piece.id, { lastHands: 'sideways' as never })).rejects.toThrow(/lastHands/)
    expect(await s.getPiece(piece.id)).toEqual(piece)
    expect(await s.updatePiece('missing', { repeatTarget: 2 })).toBeUndefined()
  })

  it('rejects an invalid record on put', async () => {
    const s = await storage()
    const pkg = makePackage('v1')
    await expect(s.putPiece({ ...makePiece(pkg), title: 3 as never })).rejects.toThrow(/title/)
  })

  it('creates piece records with defaults from a package', () => {
    const record = newPieceRecord(makePackage('v9', 'Nocturne'), { now: 42 })
    expect(record).toMatchObject({
      title: 'Nocturne',
      composer: 'Anon',
      scoreVersionId: 'v9',
      createdAt: 42,
      lastOpenedAt: 42,
    })
    expect(record.id).toMatch(/\S+/)
  })
})

describe('import commit', () => {
  it('stores source, package and piece together', async () => {
    const s = await storage()
    const { piece, pkg, source } = await importPiece(s, 'v1')
    expect(await s.getPackage('v1')).toEqual(pkg)
    expect(new Uint8Array((await s.getSource('v1'))!.bytes)).toEqual(new Uint8Array(source.bytes))
    expect((await s.getSource('v1'))?.fileName).toBe(source.fileName)
    expect(await s.listPieces()).toEqual([piece])
  })

  it('a failed import leaves existing pieces intact and writes nothing', async () => {
    const s = await storage()
    const existing = await importPiece(s, 'old')
    const pkg = makePackage('new')
    const poisoned = { ...pkg, renderXml: () => 'not cloneable' } as unknown as ScorePackage
    await expect(s.commitImport({ source: makeSource('new'), pkg: poisoned, piece: makePiece(pkg) })).rejects.toThrow()
    expect(await s.getPiece('piece-new')).toBeUndefined()
    expect(await s.getPackage('new')).toBeUndefined()
    expect(await s.getSource('new')).toBeUndefined()
    expect(await s.listPieces()).toEqual([existing.piece])
    expect(await s.getPackage('old')).toEqual(existing.pkg)
  })

  it('refuses a piece that points at a different version than its package', async () => {
    const s = await storage()
    const pkg = makePackage('a')
    await expect(s.commitImport({ source: makeSource('a'), pkg, piece: makePiece(makePackage('b')) })).rejects.toThrow(
      /disagree/,
    )
    expect(await s.listPieces()).toEqual([])
  })

  it('refuses a package of an unsupported format', async () => {
    const s = await storage()
    const pkg = makePackage('a')
    const future = { ...pkg, model: { ...pkg.model, format: 2 } } as unknown as ScorePackage
    await expect(s.commitImport({ source: makeSource('a'), pkg: future, piece: makePiece(pkg) })).rejects.toThrow(
      /format/,
    )
    expect(await s.getPackage('a')).toBeUndefined()
  })

  it('replacing the source of a piece drops the old version but keeps its history apart', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    await s.addAttempts([attemptFor(piece.id, [[1, 'clean']])])
    await s.putLayout('layout-v1', 'v1', { x: 1 }, 10)

    const pkg2 = makePackage('v2', 'Etude')
    await s.commitImport({ source: makeSource('v2'), pkg: pkg2, piece: { ...piece, scoreVersionId: 'v2' } })

    expect(await s.getPackage('v1')).toBeUndefined()
    expect(await s.getSource('v1')).toBeUndefined()
    expect(await s.getLayout('layout-v1')).toBeUndefined()
    expect(await s.getPackage('v2')).toBeDefined()
    expect((await s.listPieces()).map((p) => p.scoreVersionId)).toEqual(['v2'])
    // Old attempts stay under their own context (score version v1); v2 starts with none.
    expect((await s.listAttempts({ pieceId: piece.id })).map((a) => a.context.scoreVersionId)).toEqual(['v1'])
  })

  it('putPackage replaces the stored package of a version (confirmed hands, tempo)', async () => {
    const s = await storage()
    await importPiece(s, 'v1')
    const updated = makePackage('v1', 'Piece v1', { confirmed: true, tempo: true })
    await s.putPackage(updated)
    expect((await s.getPackage('v1'))?.model.hands.confirmed).toBe(true)
    expect((await s.getPackage('v1'))?.model.tempo.segments).toHaveLength(1)
  })
})

describe('shared score versions', () => {
  const unit = { n: 1, d: 4 }
  function tempoPackage(version: string, bpm: number, hands: Record<string, 'L' | 'R'> = {}): ScorePackage {
    const pkg = makePackage(version, 'Etude', { confirmed: true, tempo: true })
    const [segment] = pkg.model.tempo.segments
    return {
      ...pkg,
      model: {
        ...pkg.model,
        hands: { ...pkg.model.hands, byVoice: hands },
        tempo: { segments: [{ ...segment!, beatBpm: bpm, quarterBpm: bpm }] },
      },
    }
  }

  it('commitImport does not overwrite a package shared with another piece', async () => {
    const s = await storage()
    const pkg1 = makePackage('vSame', 'Etude', { confirmed: true, tempo: true })
    await s.commitImport({ source: makeSource('vSame'), pkg: pkg1, piece: newPieceRecord(pkg1, { id: 'p1', now: 1 }) })
    await s.putLayout('layout-key', 'vSame', { hands: 'as in pkg1' }, 100)
    const pkg2 = makePackage('vSame', 'Etude', { confirmed: true, tempo: false })
    await s.commitImport({ source: makeSource('vSame'), pkg: pkg2, piece: newPieceRecord(pkg2, { id: 'p2', now: 2 }) })
    expect((await s.getPackage('vSame'))?.model.tempo.segments.length).toBe(1)
    expect(await s.getLayout('layout-key')).toEqual({ hands: 'as in pkg1' })
    expect((await s.listPieces()).map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  })

  it('a second copy takes the practice tempo of the score it shares', async () => {
    const s = await storage()
    const p80 = tempoPackage('vT', 80)
    await s.commitImport({
      source: makeSource('vT'),
      pkg: p80,
      piece: makePiece(p80, { id: 'a', userTempo: { beatBpm: 80, beatUnit: unit } }),
    })
    const p100 = tempoPackage('vT', 100)
    await s.commitImport({
      source: makeSource('vT'),
      pkg: p100,
      piece: makePiece(p100, { id: 'b', userTempo: { beatBpm: 100, beatUnit: unit } }),
    })
    expect((await s.getPackage('vT'))?.model.tempo.segments[0]?.beatBpm).toBe(80)
    expect((await s.getPiece('b'))?.userTempo?.beatBpm).toBe(80)
  })

  it('replacing a score with a file another piece uses keeps that piece’s package', async () => {
    const s = await storage()
    const shared = tempoPackage('vShared', 80, { 'P1/1': 'R' })
    await s.commitImport({
      source: makeSource('vShared'),
      pkg: shared,
      piece: makePiece(shared, { id: 'owner', userTempo: { beatBpm: 80, beatUnit: unit } }),
    })
    await importPiece(s, 'vOld', { id: 'moving' })
    const incoming = tempoPackage('vShared', 120, { 'P1/1': 'L' })
    const moving = (await s.getPiece('moving'))!
    await s.commitImport({
      source: makeSource('vShared'),
      pkg: incoming,
      piece: { ...moving, scoreVersionId: 'vShared', userTempo: { beatBpm: 120, beatUnit: unit } },
    })
    expect(await s.getPackage('vShared')).toEqual(shared)
    expect((await s.getPiece('moving'))?.userTempo?.beatBpm).toBe(80)
    expect(await s.getPackage('vOld')).toBeUndefined()
  })

  it('a same-version write of the piece’s own score replaces the package and drops stale layouts', async () => {
    const s = await storage()
    const before = tempoPackage('vOwn', 80, { 'P1/1': 'R' })
    const piece = makePiece(before, { id: 'own' })
    await s.commitImport({ source: makeSource('vOwn'), pkg: before, piece })
    await s.putLayout('own-layout', 'vOwn', { hands: 'R' }, 100)
    const tempoOnly = tempoPackage('vOwn', 90, { 'P1/1': 'R' })
    await s.commitImport({ source: makeSource('vOwn'), pkg: tempoOnly, piece })
    expect((await s.getPackage('vOwn'))?.model.tempo.segments[0]?.beatBpm).toBe(90)
    expect(await s.getLayout('own-layout')).toEqual({ hands: 'R' }) // same hands: layouts still valid
    const rehanded = tempoPackage('vOwn', 90, { 'P1/1': 'L' })
    await s.commitImport({ source: makeSource('vOwn'), pkg: rehanded, piece })
    expect((await s.getPackage('vOwn'))?.model.hands.byVoice).toEqual({ 'P1/1': 'L' })
    expect(await s.getLayout('own-layout')).toBeUndefined()
  })

  it('replaceSharedPackage (Review) writes the shared package and aligns the other pieces’ tempo', async () => {
    const s = await storage()
    const p80 = tempoPackage('vR', 80)
    const a = makePiece(p80, { id: 'a', userTempo: { beatBpm: 80, beatUnit: unit } })
    await s.commitImport({ source: makeSource('vR'), pkg: p80, piece: a })
    await s.commitImport({ source: makeSource('vR'), pkg: p80, piece: { ...a, id: 'b' } })
    const p96 = tempoPackage('vR', 96)
    await s.commitImport({
      source: makeSource('vR'),
      pkg: p96,
      piece: { ...a, userTempo: { beatBpm: 96, beatUnit: unit } },
      replaceSharedPackage: true,
    })
    expect((await s.getPackage('vR'))?.model.tempo.segments[0]?.beatBpm).toBe(96)
    expect((await s.getPiece('a'))?.userTempo?.beatBpm).toBe(96)
    expect((await s.getPiece('b'))?.userTempo?.beatBpm).toBe(96)
  })
})

describe('deleting a piece', () => {
  it('cascades to attempts, histories, suggestion state, abandon events, source, package and layouts', async () => {
    const s = await storage()
    const keep = await importPiece(s, 'keep')
    const gone = await importPiece(s, 'gone')
    for (const p of [keep.piece, gone.piece]) {
      for (let i = 0; i < 3; i += 1) s.history.queueAttempt(attemptFor(p.id, [[5, 'error']]))
      for (let i = 0; i < 3; i += 1) {
        s.history.queueAbandon({
          pieceId: p.id,
          measureContextKey: 'v1|both|tm1|1.0000|roll-v1|free|match-v1',
          occ: 9,
          at: 1_000 + i,
          reason: 'user-restart',
        })
      }
    }
    await s.history.flush()
    await s.putLayout('gone-layout', 'gone', 'g', 10)
    await s.putLayout('keep-layout', 'keep', 'k', 10)
    expect((await s.loadPieceHistory(gone.piece.id)).suggestions.length).toBeGreaterThan(0)

    expect(await s.deletePiece(gone.piece.id)).toBe(true)

    expect(await s.getPiece(gone.piece.id)).toBeUndefined()
    expect(await s.getPackage('gone')).toBeUndefined()
    expect(await s.getSource('gone')).toBeUndefined()
    expect(await s.getLayout('gone-layout')).toBeUndefined()
    expect(await s.listAttempts({ pieceId: gone.piece.id })).toEqual([])
    const history = await s.loadPieceHistory(gone.piece.id)
    expect(history).toMatchObject({ bars: {}, suggestions: [], abandons: {} })

    // The other piece is untouched.
    expect(await s.getPiece(keep.piece.id)).toBeDefined()
    expect(await s.getPackage('keep')).toBeDefined()
    expect(await s.getLayout('keep-layout')).toBe('k')
    expect((await s.listAttempts({ pieceId: keep.piece.id })).length).toBe(3)
    expect(Object.keys((await s.loadPieceHistory(keep.piece.id)).bars)).toHaveLength(1)
    expect(await s.deletePiece(gone.piece.id)).toBe(false)
  })

  it('keeps the shared package while another piece uses the same score version', async () => {
    const s = await storage()
    const first = await importPiece(s, 'shared')
    const pkg = makePackage('shared')
    const twin = makePiece(pkg, { id: 'twin', title: 'Copy' })
    await s.commitImport({ source: makeSource('shared'), pkg, piece: twin })

    await s.deletePiece(first.piece.id)
    expect(await s.getPackage('shared')).toBeDefined()
    expect(await s.getSource('shared')).toBeDefined()

    await s.deletePiece('twin')
    expect(await s.getPackage('shared')).toBeUndefined()
    expect(await s.getSource('shared')).toBeUndefined()
  })

  it('does not resurrect a deleted piece from queued history records', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    s.history.queueAttempt(attemptFor(piece.id, [[2, 'error']]))
    await s.deletePiece(piece.id)
    await s.history.flush()
    expect(await s.listAttempts({ pieceId: piece.id })).toEqual([])
    expect((await s.loadPieceHistory(piece.id)).bars).toEqual({})
  })
})

describe('settings', () => {
  it('returns the defaults before anything was saved', async () => {
    const s = await storage()
    expect(await s.loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips saved settings, including per-clef label rules', async () => {
    const s = await storage()
    const settings = {
      ...DEFAULT_SETTINGS,
      naming: { ...DEFAULT_SETTINGS.naming, system: 'fixed-do' as const, simplifyEnharmonics: true },
      labels: {
        mode: 'conditional' as const,
        rules: {
          G2: {
            below: { enabled: true, threshold: { step: 'C' as const, alter: 0, octave: 4 } },
            above: { enabled: false, threshold: null },
          },
          F4: {
            below: { enabled: true, threshold: { step: 'B' as const, alter: -1, octave: 2 } },
            above: { enabled: true, threshold: { step: 'E' as const, alter: 0, octave: 4 } },
          },
          C3: { below: { enabled: false, threshold: null }, above: { enabled: false, threshold: null } },
        },
        tiedContinuations: true,
      },
      suggestions: { enabled: false },
    }
    await s.saveSettings(settings)
    expect(await s.loadSettings()).toEqual(settings)
  })

  it('survives a reload', async () => {
    const name = freshName()
    const a = await openStorage(name)
    await a.saveSettings({ ...DEFAULT_SETTINGS, labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' } })
    a.close()
    const b = await openStorage(name)
    open.push(b)
    expect((await b.loadSettings()).labels.mode).toBe('all')
  })

  it('gives fields added in later versions their defaults', async () => {
    const name = freshName()
    const db = await openPianissimoDb(name)
    // An older app version stored settings without `metronome`, `suggestions` or rules for F4.
    await db.put(
      'settings',
      {
        version: 1,
        naming: {
          system: 'fixed-do',
          seventh: 'ti',
          showOctave: false,
          alwaysShowEffectiveAccidentals: true,
          simplifyEnharmonics: false,
        },
        labels: {
          mode: 'all',
          rules: {
            G2: { below: { enabled: true, threshold: null }, above: DEFAULT_SETTINGS.labels.rules['G2']!.above },
          },
        },
      } as never,
      'app',
    )
    db.close()
    const s = await openStorage(name)
    open.push(s)
    const loaded = await s.loadSettings()
    expect(loaded.naming).toMatchObject({ system: 'fixed-do', seventh: 'ti', showOctave: false })
    expect(loaded.labels.mode).toBe('all')
    expect(loaded.labels.rules['G2']?.below).toEqual({ enabled: true, threshold: null })
    expect(loaded.labels.rules['F4']).toEqual(DEFAULT_SETTINGS.labels.rules['F4'])
    expect(loaded.metronome).toEqual(DEFAULT_SETTINGS.metronome)
    expect(loaded.suggestions).toEqual(DEFAULT_SETTINGS.suggestions)
  })
})

describe('attempts', () => {
  it('lists by piece or by comparison context, oldest first', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    const other = await importPiece(s, 'v2')
    const a = attemptFor(piece.id, [[1, 'clean']], { createdAt: 300 })
    const b = attemptFor(piece.id, [[1, 'clean']], { createdAt: 100 })
    const c = attemptFor(piece.id, [[1, 'clean']], {
      createdAt: 200,
      context: { ...a.context, multiplier: 0.5 },
      contextKey: 'slow',
    })
    const d = attemptFor(other.piece.id, [[1, 'clean']], { createdAt: 50 })
    await s.addAttempts([a, b, c, d])

    expect((await s.listAttempts({ pieceId: piece.id })).map((x) => x.createdAt)).toEqual([100, 200, 300])
    expect((await s.listAttempts({ contextKey: a.contextKey })).map((x) => x.id)).toEqual([d.id, b.id, a.id])
    expect((await s.listAttempts({ pieceId: piece.id, contextKey: a.contextKey })).map((x) => x.id)).toEqual([
      b.id,
      a.id,
    ])
    expect((await s.listAttempts({ contextKey: 'slow' })).map((x) => x.id)).toEqual([c.id])
    expect(await s.getAttempt(a.id)).toEqual(a)
  })

  it('is idempotent per attempt id', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    const a = attemptFor(piece.id, [[1, 'clean']])
    await s.addAttempts([a])
    await s.addAttempts([a, a])
    expect(await s.listAttempts({ pieceId: piece.id })).toHaveLength(1)
    await s.addAttempts([])
  })

  it('stores interrupted and abandoned attempts with their diagnostics', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    const paused = attemptRecord({ pieceId: piece.id, completion: 'interrupted', interruptReason: 'pause' })
    await s.addAttempts([paused])
    expect((await s.listAttempts({ pieceId: piece.id }))[0]).toMatchObject({
      completion: 'interrupted',
      interruptReason: 'pause',
    })
  })
})
