import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionDismissals } from '../history/controls'
import { noAssistance } from '../history/testkit'
import { DEFAULT_SETTINGS } from '../model/settings'
import { isIndexedDbAvailable, isQuotaError } from './persist'
import type { PianissimoStorage } from './storage'
import { attemptFor, importPiece, makePackage, makePiece, makeSource, openFresh } from './testkit'

const open: PianissimoStorage[] = []
async function storage(): Promise<PianissimoStorage> {
  const s = await openFresh()
  open.push(s)
  return s
}
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})

const bars = (occ: number, outcome: 'error' | 'clean' | 'label') => [[occ, outcome]] as const

describe('suggestions for the views', () => {
  it("offers up to three suggestions for the piece's current version, with bar labels from its package", async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    for (let i = 0; i < 3; i += 1) s.history.queueAttempt(attemptFor(piece.id, bars(2, 'error')))
    const shown = await s.loadSuggestions(piece.id)
    expect(shown.disabled).toBe(false)
    expect(shown.active).toHaveLength(1)
    expect(shown.active[0]).toMatchObject({
      prompt: 'Practice bars 2–4?',
      contextLabel: 'Both hands at 1×',
      passage: { fromOcc: 1, toOcc: 3 },
    })
    expect(shown.active[0]?.evidence).toBe('Mistakes in bar 3 on 3 of your last 3 comparable passes.')
  })

  it('honors session dismissals, the per-piece switch and the global setting', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    for (let i = 0; i < 3; i += 1) s.history.queueAttempt(attemptFor(piece.id, bars(2, 'error')))
    const dismissed = new SessionDismissals()
    dismissed.dismiss((await s.loadSuggestions(piece.id)).active[0]!.id)
    expect((await s.loadSuggestions(piece.id, dismissed)).active).toHaveLength(0)
    expect((await s.loadSuggestions(piece.id)).active).toHaveLength(1)

    await s.setSuggestionsDisabled(piece.id, true)
    expect((await s.loadSuggestions(piece.id)).disabled).toBe(true)
    await s.setSuggestionsDisabled(piece.id, false)

    await s.saveSettings({ ...DEFAULT_SETTINGS, suggestions: { enabled: false } })
    expect(await s.loadSuggestions(piece.id)).toEqual({ active: [], improved: [], disabled: true })
  })

  it('ignores history recorded for an earlier version of the source', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    for (let i = 0; i < 3; i += 1) s.history.queueAttempt(attemptFor(piece.id, bars(2, 'error')))
    await s.history.flush()
    const next = makePackage('v2')
    await s.commitImport({ source: makeSource('v2'), pkg: next, piece: { ...piece, scoreVersionId: 'v2' } })
    expect((await s.loadSuggestions(piece.id)).active).toHaveLength(0)
    expect((await s.listAttempts({ pieceId: piece.id })).length).toBe(3)
    expect(await s.listAttempts({ pieceId: piece.id, scoreVersionId: 'v2' })).toEqual([])
    expect(await s.loadResults(piece.id)).toEqual([])
  })

  it('returns nothing for unknown pieces', async () => {
    const s = await storage()
    expect(await s.loadSuggestions('missing')).toEqual({ active: [], improved: [], disabled: false })
    expect(await s.loadResults('missing')).toEqual([])
  })
})

describe('results for the views', () => {
  it('groups attempts by comparison context and separates best clean from assisted runs', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    const clean = attemptFor(piece.id, bars(1, 'clean'), { completionTimeSec: 8.2, expectedTimeSec: 8 })
    const assisted = attemptFor(piece.id, bars(1, 'label'), {
      completionTimeSec: 8,
      expectedTimeSec: 8,
      assistance: { ...noAssistance(), level: 'names', persistentLabelNotes: [1], persistentLabelGroups: [0] },
    })
    s.history.queueAttempt(clean)
    s.history.queueAttempt(assisted)
    const [only] = await s.loadResults(piece.id)
    expect(only?.bestClean?.id).toBe(clean.id)
    expect(only?.assisted.map((a) => a.id)).toEqual([assisted.id])
    expect(only?.streak).toEqual({ current: 2, best: 2 })
  })
})

describe('piece updates', () => {
  it('removes the tempo and composer when patched with undefined', async () => {
    const s = await storage()
    const { piece } = await importPiece(s, 'v1')
    await s.updatePiece(piece.id, { userTempo: { beatBpm: 60, beatUnit: { n: 1, d: 4 } } })
    expect((await s.getPiece(piece.id))?.userTempo?.beatBpm).toBe(60)
    const cleared = await s.updatePiece(piece.id, { userTempo: undefined, composer: undefined })
    expect(cleared).not.toHaveProperty('userTempo')
    expect(cleared).not.toHaveProperty('composer')
    expect(await s.getPiece(piece.id)).toEqual(cleared)
  })

  it('refuses an empty or detached source before writing anything', async () => {
    const s = await storage()
    const pkg = makePackage('v1')
    const empty = { ...makeSource('v1'), bytes: new ArrayBuffer(0) }
    await expect(s.commitImport({ source: empty, pkg, piece: makePiece(pkg) })).rejects.toThrow(/empty/)
    expect(await s.listPieces()).toEqual([])
  })
})

describe('environment helpers', () => {
  it('detect IndexedDB and quota failures', () => {
    expect(isIndexedDbAvailable()).toBe(true)
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true)
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true)
    expect(isQuotaError({ code: 22 })).toBe(true)
    expect(isQuotaError(new Error('other'))).toBe(false)
    expect(isQuotaError(null)).toBe(false)
    expect(isQuotaError('QuotaExceededError')).toBe(false)
  })
})
