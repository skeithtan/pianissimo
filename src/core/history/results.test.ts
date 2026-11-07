import { describe, expect, it } from 'vitest'
import { contextKey } from '../model/practice'
import type { AssistanceRecord, AttemptRecord, ComparisonContext, GroupOutcome } from '../model/practice'
import {
  compareCleanRuns,
  isAssistedAttempt,
  isCleanUnassistedCompletion,
  practiceStreak,
  summarizeByContext,
  summarizeContext,
  timeDifferenceSec,
  timingAccuracy,
} from './results'
import { attemptRecord, comparisonContext, noAssistance } from './testkit'

let clock = 100_000
/** A scored attempt with a monotonic timestamp. */
function attempt(over: Partial<AttemptRecord> & { context?: ComparisonContext } = {}): AttemptRecord {
  clock += 10
  const context = over.context ?? comparisonContext()
  return attemptRecord({ createdAt: clock, context, contextKey: contextKey(context), ...over })
}

const assistedWith = (over: Partial<AssistanceRecord>): AssistanceRecord => ({ ...noAssistance(), ...over })

describe('assistance classification', () => {
  it('treats every assistance field as assisted, even when level says none', () => {
    expect(isAssistedAttempt(attempt())).toBe(false)
    const cases: Partial<AssistanceRecord>[] = [
      { level: 'names' },
      { level: 'keyboard' },
      { persistentLabelNotes: [3] },
      { persistentLabelGroups: [1] },
      { hintRequests: 1 },
      { autoHints: 1 },
      { hintGroups: [2] },
      { keyboardShown: true },
    ]
    for (const over of cases) {
      expect(isAssistedAttempt(attempt({ assistance: assistedWith(over) }))).toBe(true)
    }
  })

  it('a clean unassisted completion needs a completed scored attempt with no wrong attacks', () => {
    expect(isCleanUnassistedCompletion(attempt())).toBe(true)
    expect(isCleanUnassistedCompletion(attempt({ wrongAttacks: 1 }))).toBe(false)
    expect(isCleanUnassistedCompletion(attempt({ completion: 'interrupted' }))).toBe(false)
    expect(isCleanUnassistedCompletion(attempt({ kind: 'reading' }))).toBe(false)
    expect(isCleanUnassistedCompletion(attempt({ assistance: assistedWith({ persistentLabelNotes: [1] }) }))).toBe(
      false,
    )
  })
})

describe('time difference', () => {
  it('is actual minus expected', () => {
    expect(timeDifferenceSec(attempt({ completionTimeSec: 9.5, expectedTimeSec: 8 }))).toBeCloseTo(1.5)
    expect(timeDifferenceSec(attempt({ completionTimeSec: 7, expectedTimeSec: 8 }))).toBeCloseTo(-1)
  })

  it('is absent without a reference span, a completion time or when timing is unscored', () => {
    expect(timeDifferenceSec(attempt({ expectedTimeSec: null }))).toBeNull()
    const { completionTimeSec: _omit, ...withoutTime } = attempt()
    expect(timeDifferenceSec(withoutTime)).toBeNull()
    expect(timeDifferenceSec(attempt({ timingUnscoredReason: 'fermata' }))).toBeNull()
  })
})

describe('best clean unassisted performance', () => {
  it('prefers the smallest absolute difference, not the fastest time', () => {
    const rushed = attempt({ completionTimeSec: 5, expectedTimeSec: 8 }) // -3 s
    const steady = attempt({ completionTimeSec: 8.4, expectedTimeSec: 8 }) // +0.4 s
    const slow = attempt({ completionTimeSec: 12, expectedTimeSec: 8 })
    expect([rushed, slow, steady].sort(compareCleanRuns)).toEqual([steady, rushed, slow])
  })

  it('breaks ties by the more recent attempt and ranks untimed runs after timed ones', () => {
    const older = attempt({ completionTimeSec: 9, expectedTimeSec: 8 })
    const newer = attempt({ completionTimeSec: 7, expectedTimeSec: 8 })
    const untimedNew = attempt({ expectedTimeSec: null })
    const untimedOld = attempt({ expectedTimeSec: null, createdAt: 1 })
    expect([untimedOld, older, untimedNew, newer].sort(compareCleanRuns)).toEqual([
      newer,
      older,
      untimedNew,
      untimedOld,
    ])
  })
})

describe('context results', () => {
  it('separates the best clean unassisted run from assisted practice and incomplete attempts', () => {
    const clean = attempt({ completionTimeSec: 8.1 })
    const lessClean = attempt({ completionTimeSec: 10 })
    const withErrors = attempt({ wrongAttacks: 2, passed: false })
    const assisted = attempt({ assistance: assistedWith({ level: 'names', hintRequests: 1 }), completionTimeSec: 8 })
    const keyboard = attempt({ assistance: assistedWith({ level: 'keyboard', keyboardShown: true }) })
    const paused = attempt({ completion: 'interrupted', interruptReason: 'pause', passed: false })
    const all = [clean, lessClean, withErrors, assisted, keyboard, paused]

    const r = summarizeContext(all, contextKey(comparisonContext()))
    expect(r?.bestClean).toBe(clean)
    expect(r?.cleanRanking).toEqual([clean, lessClean])
    expect(r?.unassistedWithErrors).toEqual([withErrors])
    expect(r?.assisted).toEqual([keyboard, assisted])
    expect(r?.incomplete).toEqual([paused])
  })

  it('an assisted run never becomes the best clean run, even when it is exact', () => {
    const exact = attempt({ completionTimeSec: 8, assistance: assistedWith({ persistentLabelNotes: [4] }) })
    const sloppy = attempt({ completionTimeSec: 14 })
    const r = summarizeContext([exact, sloppy], contextKey(comparisonContext()))
    expect(r?.bestClean).toBe(sloppy)
    expect(r?.assisted).toEqual([exact])
  })

  it('has no best run when only assisted or incomplete attempts exist', () => {
    const r = summarizeContext(
      [attempt({ assistance: assistedWith({ hintRequests: 2 }) }), attempt({ completion: 'abandoned', passed: false })],
      contextKey(comparisonContext()),
    )
    expect(r?.bestClean).toBeNull()
  })

  it('never mixes comparison contexts', () => {
    const slow = comparisonContext({ multiplier: 0.5 })
    const left = comparisonContext({ hands: 'left' })
    const a = attempt()
    const b = attempt({ context: slow })
    const c = attempt({ context: left })
    const results = summarizeByContext([a, b, c])
    expect(results).toHaveLength(3)
    for (const r of results) expect(r.cleanRanking).toHaveLength(1)
    expect(summarizeContext([a, b, c], contextKey(slow))?.bestClean).toBe(b)
    expect(summarizeContext([a], contextKey(slow))).toBeNull()
  })

  it('excludes ordinary reading and orders contexts by latest practice', () => {
    const slow = comparisonContext({ multiplier: 0.5 })
    const first = attempt()
    const reading = attempt({ kind: 'reading', context: slow })
    const later = attempt({ context: slow })
    const results = summarizeByContext([first, reading, later])
    expect(results.map((r) => r.context.multiplier)).toEqual([0.5, 1])
    expect(results[0]?.cleanRanking).toEqual([later])
    expect(results[0]?.lastAttemptAt).toBe(later.createdAt)
  })

  it('handles very large histories without argument-count limits', () => {
    const many = Array.from({ length: 150_000 }, (_, i) =>
      attemptRecord({ id: `m${i}`, createdAt: i, completionTimeSec: 8 }),
    )
    expect(summarizeContext(many, contextKey(comparisonContext()))?.lastAttemptAt).toBe(149_999)
  })
})

describe('practice streak', () => {
  const passed = (over: Partial<AttemptRecord> = {}) => attempt({ passed: true, ...over })
  const failed = (over: Partial<AttemptRecord> = {}) => attempt({ passed: false, wrongAttacks: 1, ...over })

  it('counts consecutive passes and remembers the best run', () => {
    const list = [passed(), passed(), passed(), failed(), passed(), passed()]
    expect(practiceStreak(list)).toEqual({ current: 2, best: 3 })
  })

  it('orders by time, not by array order', () => {
    const a = passed()
    const b = passed()
    const c = failed()
    expect(practiceStreak([c, b, a])).toEqual({ current: 0, best: 2 })
  })

  it('is neutral across pauses, disconnects, suspension and other device interruptions', () => {
    for (const reason of ['pause', 'disconnect', 'suspend', 'seek', 'setting-change', 'tempo-change'] as const) {
      const list = [passed(), failed({ completion: 'interrupted', interruptReason: reason }), passed()]
      expect(practiceStreak(list)).toEqual({ current: 2, best: 2 })
    }
  })

  it('a user stop or restart after wrong attacks ends the run', () => {
    const list = [passed(), passed(), failed({ completion: 'abandoned', interruptReason: 'user-restart' }), passed()]
    expect(practiceStreak(list)).toEqual({ current: 1, best: 2 })
    const stopped = [passed(), failed({ completion: 'interrupted', interruptReason: 'user-stop' }), passed()]
    expect(practiceStreak(stopped)).toEqual({ current: 1, best: 1 })
  })

  it('a restart before any wrong attack is neutral', () => {
    const list = [
      passed(),
      attempt({ completion: 'abandoned', interruptReason: 'user-restart', passed: false, wrongAttacks: 0 }),
      passed(),
    ]
    expect(practiceStreak(list)).toEqual({ current: 2, best: 2 })
  })

  it('ignores ordinary reading and an empty list', () => {
    expect(practiceStreak([passed(), attempt({ kind: 'reading', passed: false, wrongAttacks: 3 }), passed()])).toEqual({
      current: 2,
      best: 2,
    })
    expect(practiceStreak([])).toEqual({ current: 0, best: 0 })
  })

  it('a clean but out-of-tolerance completion does not extend the streak', () => {
    const list = [passed(), attempt({ passed: false, completionTimeSec: 30 }), passed()]
    expect(practiceStreak(list)).toEqual({ current: 1, best: 1 })
  })
})

const STRICT = comparisonContext({ transport: 'strict', matchingRules: 'strict-v1-tol-150ms' })
const g = (group: number, extra: Partial<GroupOutcome> = {}): GroupOutcome => ({
  group,
  wrongAttacks: 0,
  earlyAttacks: 0,
  lateMs: 0,
  ...extra,
})
function strict(groups: GroupOutcome[], over: Partial<AttemptRecord> = {}): AttemptRecord {
  return attempt({ context: STRICT, rhythm: { toleranceMs: 150 }, groups, ...over })
}

describe('rhythm mode results', () => {
  it('a clean completion needs no missed groups, in any context', () => {
    expect(isCleanUnassistedCompletion(attempt())).toBe(true)
    expect(isCleanUnassistedCompletion(attempt({ missedGroups: 0 }))).toBe(true)
    expect(isCleanUnassistedCompletion(attempt({ missedGroups: 1 }))).toBe(false)
  })

  it('timingAccuracy is null for gated and free records', () => {
    expect(timingAccuracy(attempt())).toBeNull()
    expect(timingAccuracy(attempt({ context: comparisonContext({ transport: 'accompaniment' }) }))).toBeNull()
  })

  it('classifies groups against the tolerance and averages offsets', () => {
    const acc = timingAccuracy(
      strict([
        g(0, { offsetMs: 0 }),
        g(1, { offsetMs: 150 }), // exactly the tolerance is on time
        g(2, { offsetMs: -151 }),
        g(3, { offsetMs: 300 }),
        g(4, { missed: true }),
      ]),
    )
    expect(acc).toEqual({
      groups: 5,
      onTime: 2,
      early: 1,
      late: 1,
      missed: 1,
      meanOffsetMs: (0 + 150 - 151 + 300) / 4,
      meanAbsOffsetMs: (0 + 150 + 151 + 300) / 4,
    })
  })

  it('has zero means when nothing was completed', () => {
    const acc = timingAccuracy(strict([g(0, { missed: true })]))
    expect(acc).toMatchObject({ groups: 1, missed: 1, meanOffsetMs: 0, meanAbsOffsetMs: 0 })
  })

  it('ranks strict clean runs by mean absolute offset, then recency', () => {
    const rushing = strict([g(0, { offsetMs: -100 }), g(1, { offsetMs: -100 })])
    const tight = strict([g(0, { offsetMs: -20 }), g(1, { offsetMs: 40 })]) // signed mean ~10, abs 30
    const tightLater = strict([g(0, { offsetMs: 30 }), g(1, { offsetMs: -30 })])
    const ranked = [rushing, tightLater, tight].sort(compareCleanRuns)
    expect(ranked).toEqual([tightLater, tight, rushing])
  })

  it('a record with a missed group is not the best clean run', () => {
    const missed = strict([g(0, { offsetMs: 0 }), g(1, { missed: true })], { missedGroups: 1, passed: false })
    const ok = strict([g(0, { offsetMs: 100 })])
    expect(summarizeContext([missed, ok], contextKey(STRICT))?.bestClean).toBe(ok)
  })
})
