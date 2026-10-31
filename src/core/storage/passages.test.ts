/**
 * Note-level passages in storage (DECISIONS U21): `PassageRange.start` / `end` are optional exact
 * rationals. Records stored before them (whole bars only) stay valid; new records round-trip
 * through IndexedDB and a backup unchanged.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { attemptRecord, comparisonContext } from '../history/testkit'
import { contextKey } from '../model/practice'
import { rat } from '../music/rational'
import type { PianissimoStorage } from './storage'
import { attemptFor, importPiece, makePackage, makePiece, openFresh } from './testkit'
import { attemptProblem, pieceProblem } from './validate'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const open: PianissimoStorage[] = []
async function fresh(): Promise<PianissimoStorage> {
  const s = await openFresh()
  open.push(s)
  return s
}
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})

const SUB = { fromOcc: 10, toOcc: 12, start: rat(41, 4), end: rat(25, 2) }

describe('passage validation', () => {
  it('accepts whole-bar records written before note-level loops', () => {
    const old = clone(makePiece(makePackage('v1'), { lastPassage: { fromOcc: 2, toOcc: 4 } }))
    expect(pieceProblem(old)).toBeNull()
    expect(attemptProblem(clone(attemptRecord()))).toBeNull()
  })

  it('accepts exact edges and rejects malformed ones', () => {
    const piece = makePiece(makePackage('v1'), { lastPassage: SUB })
    expect(pieceProblem(clone(piece))).toBeNull()
    const context = comparisonContext({ passage: SUB })
    expect(attemptProblem(clone(attemptRecord({ context, contextKey: contextKey(context) })))).toBeNull()
    expect(pieceProblem({ ...clone(piece), lastPassage: { fromOcc: 1, toOcc: 2, start: 3 } })).toBe(
      'lastPassage is missing or invalid',
    )
    expect(pieceProblem({ ...clone(piece), lastPassage: { fromOcc: 1, toOcc: 2, end: { n: 1, d: 0 } } })).toBe(
      'lastPassage is missing or invalid',
    )
    const bad = { ...clone(attemptRecord()), context: { ...clone(context), passage: { ...SUB, start: 'x' } } }
    expect(attemptProblem(bad)).toBe('context.passage is missing or invalid')
  })
})

describe('passage round trip', () => {
  it('stores and restores a note-level last passage and attempt', async () => {
    const s = await fresh()
    const { piece } = await importPiece(s, 'v1')
    await s.updatePiece(piece.id, { lastPassage: SUB })
    const context = comparisonContext({ passage: SUB })
    s.history.queueAttempt(attemptFor(piece.id, [[10, 'partial']], { context, contextKey: contextKey(context) }))
    await s.history.flush()
    expect((await s.getPiece(piece.id))?.lastPassage).toEqual(SUB)
    const [stored] = await s.listAttempts({ pieceId: piece.id })
    expect(stored?.context.passage).toEqual(SUB)
    expect(stored?.contextKey).toContain('|10-12@41/4..25/2|')

    const target = await fresh()
    const report = await target.restore(await s.exportAll())
    expect(report.warnings).toEqual([])
    expect((await target.getPiece(piece.id))?.lastPassage).toEqual(SUB)
    expect((await target.listAttempts({ pieceId: piece.id }))[0]?.context.passage).toEqual(SUB)
  })
})
