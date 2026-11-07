import { describe, expect, it } from 'vitest'
import { attemptRecord } from '../history/testkit'
import {
  abandonProblem,
  attemptProblem,
  barProblem,
  packageProblem,
  pieceProblem,
  sourceMetaProblem,
  suggestionStateProblem,
} from './validate'
import { makePackage, makePiece } from './testkit'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const set = (base: object, patch: Record<string, unknown>): unknown => ({ ...base, ...patch })

const piece = makePiece(makePackage('v1'))
const bar = {
  pieceId: 'p',
  measureContextKey: 'k',
  occ: 3,
  recent: [{ at: 1, attemptId: 'a', errorBearing: false, assisted: false }],
  cleanStreak: 1,
  lastAttemptId: 'a',
  updatedAt: 1,
}
const suggestion = {
  id: 's',
  kind: 'traversal',
  status: 'active',
  measureContextKey: 'k',
  context: {
    scoreVersionId: 'v1',
    hands: 'both',
    handsId: 'h',
    tempoMapId: 't',
    multiplier: 1,
    rollPolicy: 'r',
    transport: 'free',
    matchingRules: 'm',
  },
  coreFrom: 1,
  coreTo: 2,
  createdAt: 1,
  updatedAt: 2,
}

describe('record validators', () => {
  it('accept well-formed records', () => {
    expect(pieceProblem(clone(piece))).toBeNull()
    expect(attemptProblem(clone(attemptRecord()))).toBeNull()
    expect(barProblem(bar)).toBeNull()
    expect(suggestionStateProblem({ pieceId: 'p', disabled: false, suggestions: [suggestion] })).toBeNull()
    expect(
      abandonProblem({
        pieceId: 'p',
        measureContextKey: 'k',
        occ: 1,
        events: [{ pieceId: 'p', measureContextKey: 'k', occ: 1, at: 1, reason: 'user-stop' }],
      }),
    ).toBeNull()
    expect(packageProblem(clone(makePackage('v1')))).toBeNull()
    expect(
      sourceMetaProblem({ scoreVersionId: 'v', fileName: 'a', packaging: 'mxl', sha256: 's', file: 'f', size: 1 }),
    ).toBeNull()
  })

  it('accept optional fields when present', () => {
    expect(
      pieceProblem(
        set(piece, {
          userTempo: { beatBpm: 60, beatUnit: { n: 1, d: 4 } },
          resume: { occ: 1, position: { n: 1, d: 1 }, group: 3, hands: 'left', multiplier: 1, savedAt: 1 },
          lastPassage: { fromOcc: 1, toOcc: 4 },
          repeatTarget: 3,
        }),
      ),
    ).toBeNull()
    expect(attemptProblem(set(attemptRecord(), { interruptReason: 'pause', completion: 'interrupted' }))).toBeNull()
  })

  it('ignores the savedPassages key of records written before the feature was dropped', () => {
    const legacy = { ...piece, savedPassages: [{ id: 'x', name: 'Bridge', fromOcc: 1, toOcc: 2, createdAt: 1 }] }
    expect(pieceProblem(legacy)).toBeNull()
  })

  it('accept a speed ladder, null or none (records written before the ladder)', () => {
    expect(piece.ladder).toBeNull()
    expect(pieceProblem(set(piece, { ladder: { goal: 1, step: 0.05 } }))).toBeNull()
    expect(pieceProblem(set(piece, { ladder: { goal: 0.05, step: 1 } }))).toBeNull()
    expect(pieceProblem(set(piece, { ladder: { goal: 10, step: 0.5 } }))).toBeNull()
    expect(pieceProblem(set(piece, { ladder: null }))).toBeNull()
    const legacy = Object.fromEntries(Object.entries(clone(piece)).filter(([k]) => k !== 'ladder'))
    expect(pieceProblem(legacy)).toBeNull()
  })

  it('reject a malformed speed ladder', () => {
    for (const ladder of [
      { goal: 1 },
      { step: 0.05 },
      { goal: 0.04, step: 0.05 },
      { goal: 10.5, step: 0.05 },
      { goal: 1, step: 0 },
      { goal: 1, step: 1.5 },
      { goal: Number.NaN, step: 0.05 },
      { goal: 1, step: Number.POSITIVE_INFINITY },
      { goal: '1', step: 0.05 },
      [1, 0.05],
      1,
    ]) {
      expect(pieceProblem(set(piece, { ladder }))).toBe('ladder is missing or invalid')
    }
  })

  it('accept Keep time on, off or absent (older records), and reject anything else', () => {
    expect(pieceProblem(set(piece, { rhythm: true }))).toBeNull()
    expect(pieceProblem(set(piece, { rhythm: false }))).toBeNull()
    expect(pieceProblem(clone(piece))).toBeNull()
    for (const rhythm of ['on', 1, null, {}]) {
      expect(pieceProblem(set(piece, { rhythm }))).toBe('rhythm is missing or invalid')
    }
  })

  it('accept a strict (Keep time) attempt and reject an unknown transport', () => {
    const base = attemptRecord()
    const strict = set(base, {
      context: { ...base.context, transport: 'strict', matchingRules: 'strict-v1-tol-150ms' },
      rhythm: { toleranceMs: 150 },
      missedGroups: 1,
    })
    expect(attemptProblem(clone(strict))).toBeNull()
    expect(attemptProblem(set(base, { context: { ...base.context, transport: 'rubato' } }))).toBe(
      'context.transport is missing or invalid',
    )
  })

  it('name the first bad piece field', () => {
    for (const [field, value] of [
      ['id', ''],
      ['title', 5],
      ['scoreVersionId', ''],
      ['createdAt', 'yesterday'],
      ['lastMultiplier', 0],
      ['lastMultiplier', Number.NaN],
      ['lastHands', 'both-ish'],
      ['userTempo', { beatBpm: -1, beatUnit: { n: 1, d: 4 } }],
      ['userTempo', { beatBpm: 60, beatUnit: { n: 1, d: 0 } }],
      ['resume', { occ: 1 }],
      ['lastPassage', { fromOcc: 3, toOcc: 1 }],
      ['repeatTarget', 0],
    ] as const) {
      expect(pieceProblem(set(piece, { [field]: value }))).toBe(`${field} is missing or invalid`)
    }
    expect(pieceProblem(null)).toBe('is not an object')
    expect(pieceProblem([])).toBe('is not an object')
  })

  it('reject malformed attempts', () => {
    const base = attemptRecord()
    for (const [field, value] of [
      ['kind', 'practice'],
      ['completion', 'done'],
      ['interruptReason', 'bored'],
      ['wrongAttacks', '3'],
      ['passed', 1],
      ['onsets', [{ group: 'a', t: 1 }]],
      ['measures', [{ occ: 1 }]],
      ['assistance', { level: 'none' }],
      ['expectedTimeSec', undefined],
    ] as const) {
      expect(attemptProblem(set(base, { [field]: value }))).toBe(`${field} is missing or invalid`)
    }
    expect(attemptProblem(set(base, { context: { ...base.context, hands: 'x' } }))).toBe(
      'context.hands is missing or invalid',
    )
    expect(attemptProblem(set(base, { context: 4 }))).toBe('context is not an object')
  })

  it('reject malformed bar, suggestion and abandon records', () => {
    expect(barProblem(set(bar, { cleanStreak: -1 }))).toBe('cleanStreak is missing or invalid')
    expect(barProblem(set(bar, { recent: Array(6).fill(bar.recent[0]) }))).toBe('recent is missing or invalid')
    expect(
      suggestionStateProblem({
        pieceId: 'p',
        disabled: false,
        suggestions: [set(suggestion, { coreFrom: 5, coreTo: 2 })],
      }),
    ).toBe('suggestions is missing or invalid')
    expect(suggestionStateProblem({ pieceId: 'p', disabled: 'no', suggestions: [] })).toBe(
      'disabled is missing or invalid',
    )
    expect(abandonProblem({ pieceId: 'p', measureContextKey: 'k', occ: 1, events: [{ reason: 'user-stop' }] })).toBe(
      'events is missing or invalid',
    )
  })

  it('reject packages of another format or without their parts', () => {
    const pkg = clone(makePackage('v1')) as unknown as { model: Record<string, unknown> }
    expect(packageProblem(set(pkg, { model: { ...pkg.model, format: 2 } }))).toMatch(/format 2 is not supported/)
    expect(packageProblem(set(pkg, { model: { ...pkg.model, notes: 'many' } }))).toBe(
      'model.notes is missing or invalid',
    )
    expect(packageProblem(set(pkg, { renderXml: 1 }))).toBe('renderXml is missing or invalid')
    expect(packageProblem({ renderXml: '' })).toBe('model is missing')
  })

  it('reject malformed source index entries', () => {
    const entry = { scoreVersionId: 'v', fileName: 'a', packaging: 'mxl', sha256: 's', file: 'f', size: 1 }
    expect(sourceMetaProblem(set(entry, { packaging: 'pdf' }))).toBe('packaging is missing or invalid')
    expect(sourceMetaProblem(set(entry, { size: -1 }))).toBe('size is missing or invalid')
    expect(sourceMetaProblem(set(entry, { bytesSha256: 5 }))).toBe('bytesSha256 is missing or invalid')
  })
})
