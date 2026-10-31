import { describe, expect, it } from 'vitest'
import { attemptRecord, comparisonContext, noAssistance, occurrences } from '../../core/history/testkit'
import { contextKey } from '../../core/model/practice'
import type { AttemptRecord, ComparisonContext } from '../../core/model/practice'
import { deriveResults, earlyAttackCount, passReason, passageText } from './model'

const SCORE = occurrences(40)
const A = comparisonContext() // both hands, 1×, bars 11–17
const B = comparisonContext({ hands: 'right', transport: 'accompaniment', multiplier: 0.75 })

let n = 0
function attempt(context: ComparisonContext, at: number, over: Partial<AttemptRecord> = {}): AttemptRecord {
  n += 1
  return attemptRecord({ id: `m${n}`, createdAt: at, context, contextKey: contextKey(context), ...over })
}
const names = { ...noAssistance(), level: 'names' as const, persistentLabelNotes: [1, 2], persistentLabelGroups: [0] }

describe('deriveResults: context separation', () => {
  const attempts = [
    attempt(A, 100, { completionTimeSec: 7, expectedTimeSec: 8 }), // clean, 1.0 s fast
    attempt(A, 200, { completionTimeSec: 8.2, expectedTimeSec: 8 }), // clean, 0.2 s slow: best
    attempt(A, 300, { wrongAttacks: 2, passed: false, groupsFirstPass: 6 }),
    attempt(A, 400, { assistance: names, passed: false, completionTimeSec: 8, expectedTimeSec: 8 }),
    attempt(A, 500, { completion: 'interrupted', interruptReason: 'pause' }),
    attempt(B, 600, { completionTimeSec: 9, expectedTimeSec: 10.6 }),
  ]

  it('shows the latest attempt and compares only inside its own context', () => {
    const model = deriveResults({ attempts, occurrences: SCORE })
    expect(model.attempt?.context.hands).toBe('right')
    expect(model.isLatest).toBe(true)
    expect(model.history?.contextKey).toBe(contextKey(B))
    expect(model.historyCount).toBe(1)
    expect(model.history?.cleanRanking.map((a) => a.id)).toEqual([attempts[5]?.id])
    // Context A is offered separately, never merged.
    expect(model.others).toHaveLength(1)
    expect(model.others[0]?.results.contextKey).toBe(contextKey(A))
    expect(model.others[0]?.count).toBe(5)
    expect(model.others[0]?.latest.id).toBe(attempts[4]?.id)
  })

  it('keeps best clean unassisted apart from assisted practice and outside incomplete attempts', () => {
    const model = deriveResults({ attempts, occurrences: SCORE, attemptId: attempts[1]?.id })
    expect(model.isLatest).toBe(false)
    const h = model.history
    expect(h?.bestClean?.id).toBe(attempts[1]?.id) // closest to expected, not fastest
    expect(h?.cleanRanking.map((a) => a.id)).toEqual([attempts[1]?.id, attempts[0]?.id])
    expect(h?.assisted.map((a) => a.id)).toEqual([attempts[3]?.id])
    expect(h?.unassistedWithErrors.map((a) => a.id)).toEqual([attempts[2]?.id])
    expect(h?.incomplete.map((a) => a.id)).toEqual([attempts[4]?.id])
    const ranked = new Set(h?.cleanRanking.map((a) => a.id))
    expect(ranked.has(attempts[3]?.id ?? '')).toBe(false)
    expect(ranked.has(attempts[4]?.id ?? '')).toBe(false)
    // Context B's attempt never appears here.
    const all = [
      ...(h?.cleanRanking ?? []),
      ...(h?.assisted ?? []),
      ...(h?.incomplete ?? []),
      ...(h?.unassistedWithErrors ?? []),
    ]
    expect(all.some((a) => a.contextKey === contextKey(B))).toBe(false)
  })

  it('computes the streak as of the shown attempt', () => {
    const run = [attempt(A, 10), attempt(A, 20), attempt(A, 30, { wrongAttacks: 1, passed: false }), attempt(A, 40)]
    const old = deriveResults({ attempts: run, occurrences: SCORE, attemptId: run[1]?.id })
    expect(old.streak).toEqual({ current: 2, best: 2 })
    const latest = deriveResults({ attempts: run, occurrences: SCORE })
    expect(latest.streak).toEqual({ current: 1, best: 2 })
    expect(latest.scorecard?.rows.find((r) => r.id === 'streak')?.value).toBe('1')
  })

  it('falls back to the latest when the requested attempt is missing', () => {
    const model = deriveResults({ attempts, occurrences: SCORE, attemptId: 'nope' })
    expect(model.requestedMissing).toBe(true)
    expect(model.attempt?.id).toBe(attempts[5]?.id)
  })

  it('has an empty model without attempts', () => {
    const model = deriveResults({ attempts: [], occurrences: SCORE })
    expect(model.attempt).toBeNull()
    expect(model.scorecard).toBeNull()
    expect(model.others).toEqual([])
  })
})

describe('deriveResults: special attempts', () => {
  it('single-group passages have no tempo ratio (ungraded time to solve)', () => {
    const one = attempt(A, 5, { groupsTotal: 1, groupsFirstPass: 1, completionTimeSec: 2.1, expectedTimeSec: null })
    const model = deriveResults({ attempts: [one], occurrences: SCORE })
    expect(model.scorecard?.timing).toBe('ungraded')
    const ids = model.scorecard?.rows.map((r) => r.id) ?? []
    expect(ids).toContain('completion-time')
    expect(ids).not.toContain('expected-time')
    expect(ids).not.toContain('time-difference')
    expect(model.scorecard?.timeDifferencePercent).toBeNull()
    expect(model.scorecard?.rows.find((r) => r.id === 'completion-time')?.label).toBe('Time to solve')
  })

  it('ordinary reading is shown but never compared', () => {
    const reading = attempt(A, 50, { kind: 'reading' })
    const scored = attempt(A, 40)
    const model = deriveResults({ attempts: [scored, reading], occurrences: SCORE })
    expect(model.attempt?.kind).toBe('reading')
    expect(model.history).toBeNull()
    expect(model.streak).toBeNull()
    expect(model.others.map((o) => o.results.contextKey)).toEqual([contextKey(A)])
  })

  it('describes the early-press share only when the record carries it', () => {
    const plain = attempt(A, 1, { wrongAttacks: 3 })
    expect(earlyAttackCount(plain)).toBeNull()
    const withEarly = { ...plain, earlyAttacks: 2 } as AttemptRecord
    expect(earlyAttackCount(withEarly)).toBe(2)
    expect(earlyAttackCount({ ...plain, earlyAttacks: 9 } as AttemptRecord)).toBe(3) // never above the total
    expect(earlyAttackCount({ ...plain, earlyAttacks: 'x' } as unknown as AttemptRecord)).toBeNull()
  })

  it('explains why an attempt was not a pass', () => {
    expect(passReason(attempt(A, 1), false)).toBe('passed')
    expect(passReason(attempt(A, 1, { passed: false, wrongAttacks: 1 }), false)).toBe('wrong-notes')
    expect(passReason(attempt(A, 1, { passed: false }), true)).toBe('assistance')
    expect(passReason(attempt(A, 1, { passed: false }), false)).toBe('timing')
    expect(passReason(attempt(A, 1, { completion: 'abandoned' }), false)).toBe('incomplete')
  })

  it('labels the passage with printed bar numbers and repeat passes', () => {
    const labeler = deriveResults({ attempts: [], occurrences: SCORE }).labeler
    expect(passageText(labeler, A)).toBe('Bars 11–17')
    expect(passageText(labeler, comparisonContext({ passage: { fromOcc: 3, toOcc: 3 } }))).toBe('Bar 4')
  })
})
