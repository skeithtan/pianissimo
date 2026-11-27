import { describe, expect, it } from 'vitest'
import { EngineDriver, buildScore, quarters } from '../engine/testkit'
import { buildTimeline } from '../engine/timeline'
import { type AttemptRecord, type GroupOutcome, handAssignmentId } from '../model/practice'
import { rat } from '../music/rational'
import {
  PAUSE_FLOOR_MS,
  SPOT_LIMIT,
  SPOT_VISITS,
  SpotMemory,
  type SpotScope,
  type SpotTimeline,
  wasAttempted,
} from './spots'
import { attemptRecord, comparisonContext } from './testkit'

const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const Fs4 = 66
const G4 = 67

const SCOPE: SpotScope = { scoreVersionId: 'v1', handsId: 'h1', hands: 'both' }

function makeTimeline(count: number, offset = 0, syntheticIdx?: number): SpotTimeline {
  return {
    groups: Array.from({ length: count }, (_, i) => ({
      position: rat(i + offset, 4),
      pitches: [C4 + ((i + offset) % 12)],
      synthetic: i === syntheticIdx,
    })),
  }
}

function outcome(group: number, over: Partial<GroupOutcome> = {}): GroupOutcome {
  return { group, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, ...over }
}

function scoredRecord(
  groupsTotal: number,
  groups: readonly GroupOutcome[],
  completedGroups: readonly number[],
  over: Partial<AttemptRecord> = {},
): AttemptRecord {
  return attemptRecord({
    kind: 'scored',
    groupsTotal,
    groups,
    onsets: completedGroups.map((group, idx) => ({ group, t: idx })),
    context: comparisonContext({
      scoreVersionId: SCOPE.scoreVersionId,
      handsId: SCOPE.handsId,
      hands: SCOPE.hands,
    }),
    ...over,
  })
}

describe('wasAttempted', () => {
  it('distinguishes attempted groups from an untouched stopping-point group', () => {
    const rec = scoredRecord(
      4,
      [
        outcome(0),
        outcome(1, { wrongAttacks: 1, wrongPitches: [F4] }),
        outcome(2, { tieEndPresses: 1 }),
        outcome(3, { missed: true }),
      ],
      [0],
    )
    expect(wasAttempted(rec, rec.groups![0]!)).toBe(true) // completed (in onsets)
    expect(wasAttempted(rec, rec.groups![1]!)).toBe(true) // wrongAttacks > 0
    expect(wasAttempted(rec, rec.groups![2]!)).toBe(true) // tieEndPresses > 0
    expect(wasAttempted(rec, rec.groups![3]!)).toBe(true) // missed === true

    const untouched = outcome(1)
    const stopped = scoredRecord(3, [outcome(0), untouched], [0], { completion: 'abandoned' })
    expect(wasAttempted(stopped, untouched)).toBe(false)
  })
})

describe('SpotMemory across speeds and shifted loops (real engine records)', () => {
  const model = buildScore({
    notes: [
      { at: 0, midi: C4 },
      { at: 1, midi: D4 },
      { at: 2, midi: Fs4 },
      { at: 3, midi: G4 },
    ],
  })
  const scope: SpotScope = {
    scoreVersionId: model.scoreVersionId,
    handsId: handAssignmentId(model.hands),
    hands: 'right',
  }

  function runPass(
    opts: { startQuarter?: number; multiplier: number; wrongAtTarget?: number; stopBeforeTarget?: boolean },
    createdAt: number,
  ) {
    const timeline = buildTimeline(model, {
      hands: 'right',
      range: {
        fromOcc: 0,
        toOcc: 0,
        ...(opts.startQuarter !== undefined ? { start: quarters(opts.startQuarter) } : {}),
      },
      multiplier: opts.multiplier,
    })
    const driver = new EngineDriver(
      timeline,
      { mode: 'scored', pieceId: 'p1', prepared: true, transport: 'free' },
      createdAt,
    )
    const startIdx = opts.startQuarter ?? 0
    const pitches = [C4, D4, Fs4, G4].slice(startIdx)
    for (let i = 0; i < pitches.length; i++) {
      const p = pitches[i]!
      if (p === Fs4 && opts.stopBeforeTarget) {
        driver.engine.interrupt('user-stop', driver.now)
        break
      }
      if (p === Fs4 && opts.wrongAtTarget !== undefined) {
        driver.tap(opts.wrongAtTarget).wait(50)
      }
      driver.tap(p).wait(100)
    }
    const record = driver.records()[0]!
    return { timeline, record: { ...record, createdAt } }
  }

  it('tracks streak = 3 for the same wrong key at the same place across different speeds and shifted loops', () => {
    const mem = new SpotMemory(scope)
    const p1 = runPass({ multiplier: 1.0, wrongAtTarget: F4 }, 1000)
    const p2 = runPass({ multiplier: 0.8, startQuarter: 1, wrongAtTarget: F4 }, 2000)
    const p3 = runPass({ multiplier: 0.6, startQuarter: 1, wrongAtTarget: F4 }, 3000)

    // Sanity check: group index shifted from 2 to 1 in the narrower loop.
    expect(p1.timeline.groups[2]!.position).toEqual(quarters(2))
    expect(p2.timeline.groups[1]!.position).toEqual(quarters(2))

    expect(mem.fold(p1.record, p1.timeline, true)).toBe(true)
    expect(mem.fold(p2.record, p2.timeline, true)).toBe(true)
    expect(mem.fold(p3.record, p3.timeline, true)).toBe(true)

    expect(mem.streak(quarters(2), F4)).toBe(3)
    expect(mem.history(quarters(2)).map((v) => v.multiplier)).toEqual([1.0, 0.8, 0.6])
  })

  it('abandoned pass stopped at the place with nothing pressed neither counts nor breaks streak; a different wrong key breaks it', () => {
    const mem = new SpotMemory(scope)
    const p1 = runPass({ multiplier: 1.0, wrongAtTarget: F4 }, 1000)
    const p2 = runPass({ multiplier: 1.0, wrongAtTarget: F4 }, 2000)
    const stopped = runPass({ multiplier: 1.0, stopBeforeTarget: true }, 3000)
    const otherWrong = runPass({ multiplier: 1.0, wrongAtTarget: E4 }, 4000)

    mem.fold(p1.record, p1.timeline, true)
    mem.fold(p2.record, p2.timeline, true)
    expect(mem.streak(quarters(2), F4)).toBe(2)

    // Stopped right on Fs4 with nothing pressed: outcome exists for group 2, not attempted.
    expect(stopped.record.completion).toBe('abandoned')
    expect(stopped.record.groups!.some((g) => g.group === 2)).toBe(true)
    mem.fold(stopped.record, stopped.timeline, true)
    expect(mem.streak(quarters(2), F4)).toBe(2)
    expect(mem.history(quarters(2))).toHaveLength(2)

    // Pressing a different wrong key breaks the F4 streak.
    mem.fold(otherWrong.record, otherWrong.timeline, true)
    expect(mem.streak(quarters(2), F4)).toBe(0)
    expect(mem.streak(quarters(2), E4)).toBe(1)
  })
})

describe('folding order, deduplication, and filtering', () => {
  it('keeps visits in at order when records are folded out of order and ignores duplicate attempt ids', () => {
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(2)

    const r3 = scoredRecord(2, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], {
      id: 'r3',
      createdAt: 3000,
    })
    const r1 = scoredRecord(2, [outcome(0, { wrongAttacks: 1, wrongPitches: [E4] })], [0], {
      id: 'r1',
      createdAt: 1000,
    })
    const r2 = scoredRecord(2, [outcome(0, { wrongAttacks: 1, wrongPitches: [D4] })], [0], {
      id: 'r2',
      createdAt: 2000,
    })

    expect(mem.fold(r3, tl, true)).toBe(true)
    expect(mem.fold(r1, tl, false)).toBe(true)
    expect(mem.fold(r2, tl, false)).toBe(true)
    // Duplicate fold adds nothing.
    expect(mem.fold(r2, tl, false)).toBe(false)

    expect(mem.history(rat(0, 4)).map((v) => v.attemptId)).toEqual(['r1', 'r2', 'r3'])
    expect(mem.history(rat(0, 4)).map((v) => v.at)).toEqual([1000, 2000, 3000])
  })

  it('ignores mismatched scope, reading records, missing groups, wrong groupsTotal, and synthetic groups', () => {
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(2)

    const wrongVersion = scoredRecord(2, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], {
      context: comparisonContext({ scoreVersionId: 'v2', handsId: 'h1', hands: 'both' }),
    })
    const wrongHandsId = scoredRecord(2, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], {
      context: comparisonContext({ scoreVersionId: 'v1', handsId: 'h2', hands: 'both' }),
    })
    const wrongHands = scoredRecord(2, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], {
      context: comparisonContext({ scoreVersionId: 'v1', handsId: 'h1', hands: 'left' }),
    })
    const reading = scoredRecord(2, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], {
      kind: 'reading',
    })
    const noGroups = attemptRecord({
      kind: 'scored',
      groupsTotal: 2,
      context: comparisonContext({ scoreVersionId: 'v1', handsId: 'h1', hands: 'both' }),
    })
    const wrongTotal = scoredRecord(3, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0])

    expect(mem.fold(wrongVersion, tl, true)).toBe(false)
    expect(mem.fold(wrongHandsId, tl, true)).toBe(false)
    expect(mem.fold(wrongHands, tl, true)).toBe(false)
    expect(mem.fold(reading, tl, true)).toBe(false)
    expect(mem.fold(noGroups, tl, true)).toBe(false)
    expect(mem.fold(wrongTotal, tl, true)).toBe(false)
    expect(mem.history(rat(0, 4))).toEqual([])

    // Synthetic group is skipped while real group in the same record folds.
    const synthTl = makeTimeline(2, 0, 0)
    const rec = scoredRecord(
      2,
      [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] }), outcome(1, { wrongAttacks: 1, wrongPitches: [E4] })],
      [0, 1],
    )
    expect(mem.fold(rec, synthTl, true)).toBe(true)
    expect(mem.history(rat(0, 4))).toEqual([])
    expect(mem.history(rat(1, 4))).toHaveLength(1)
  })

  it('normalizes SpotVisit fields (distinct ascending wrong pitches, pauseMs 0 in strict, clean flag)', () => {
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(3)
    const rec = scoredRecord(
      3,
      [
        outcome(0, { wrongAttacks: 3, wrongPitches: [G4, E4, G4] }),
        outcome(1, { wrongAttacks: 1, earlyAttacks: 1, lateMs: 300 }),
        outcome(2, { wrongAttacks: 0, missed: true, lateMs: 400 }),
      ],
      [0, 1],
      {
        context: comparisonContext({
          scoreVersionId: 'v1',
          handsId: 'h1',
          hands: 'both',
          transport: 'strict',
        }),
      },
    )
    mem.fold(rec, tl, true)

    const v0 = mem.history(rat(0, 4))[0]!
    expect(v0.wrong).toEqual([E4, G4])
    expect(v0.strict).toBe(true)
    expect(v0.clean).toBe(false)

    const v1 = mem.history(rat(1, 4))[0]!
    expect(v1.pauseMs).toBe(0) // strict transport
    expect(v1.clean).toBe(false) // earlyAttacks counts as wrongAttacks

    const v2 = mem.history(rat(2, 4))[0]!
    expect(v2.missed).toBe(true)
    expect(v2.pauseMs).toBe(0)
    expect(v2.clean).toBe(false)
  })
})

describe('guardFor', () => {
  it('guards only places with a live visit, mapped to the queried timeline indices, and clears after a live clean visit', () => {
    const mem = new SpotMemory(SCOPE)
    const fullTl = makeTimeline(4, 0) // positions 0/4, 1/4, 2/4, 3/4
    const shiftedTl = makeTimeline(3, 1) // positions 1/4 (idx 0), 2/4 (idx 1), 3/4 (idx 2)

    // Stored (non-live) mistake at 1/4: must NOT arm guard.
    const stored = scoredRecord(4, [outcome(1, { wrongAttacks: 1, wrongPitches: [F4] })], [1], { createdAt: 1000 })
    mem.fold(stored, fullTl, false)
    expect(mem.guardFor(shiftedTl).size).toBe(0)

    // Live mistake at 2/4 (idx 2 in fullTl -> idx 1 in shiftedTl).
    const liveErr = scoredRecord(4, [outcome(2, { wrongAttacks: 2, wrongPitches: [G4, E4] })], [2], { createdAt: 2000 })
    mem.fold(liveErr, fullTl, true)
    const guard = mem.guardFor(shiftedTl)
    expect([...guard.keys()]).toEqual([1])
    expect(guard.get(1)).toEqual(new Set([E4, G4]))

    // Live clean visit at 2/4 clears the guard.
    const liveClean = scoredRecord(3, [outcome(1)], [1], { createdAt: 3000 })
    mem.fold(liveClean, shiftedTl, true)
    expect(mem.guardFor(shiftedTl).size).toBe(0)
  })
})

describe('hotSpots and fixedBy', () => {
  it('classifies hotSpots as faint or firm in ascending group order and omits clean latest visits', () => {
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(3)

    // Group 0: 1 error -> faint
    // Group 1: 2 errors out of latest 3 (err, clean, err) -> firm
    // Group 2: error then clean -> not a hot spot
    mem.fold(
      scoredRecord(
        3,
        [outcome(1, { wrongAttacks: 1, wrongPitches: [F4] }), outcome(2, { wrongAttacks: 1, wrongPitches: [F4] })],
        [1, 2],
        { createdAt: 1000 },
      ),
      tl,
      true,
    )
    mem.fold(scoredRecord(3, [outcome(1), outcome(2)], [1, 2], { createdAt: 2000 }), tl, true)
    mem.fold(
      scoredRecord(
        3,
        [outcome(0, { wrongAttacks: 1, wrongPitches: [E4] }), outcome(1, { wrongAttacks: 1, wrongPitches: [F4] })],
        [0, 1],
        { createdAt: 3000 },
      ),
      tl,
      true,
    )

    expect(mem.hotSpots(tl)).toEqual([
      { group: 0, level: 'faint' },
      { group: 1, level: 'firm' },
    ])
  })

  it('fixedBy returns the same groups before and after folding the clean record', () => {
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(4)

    // Prior pass: group 0 clean (untracked), group 1 error, group 2 error, group 3 error
    mem.fold(
      scoredRecord(
        4,
        [
          outcome(0),
          outcome(1, { wrongAttacks: 1, wrongPitches: [F4] }),
          outcome(2, { wrongAttacks: 1, wrongPitches: [E4] }),
          outcome(3, { wrongAttacks: 1, wrongPitches: [D4] }),
        ],
        [0, 1, 2, 3],
        { createdAt: 1000 },
      ),
      tl,
      true,
    )

    // New record: group 0 clean (was never bad), group 1 clean (fixed!), group 2 still wrong, group 3 unattempted
    const next = scoredRecord(
      4,
      [outcome(0), outcome(1), outcome(2, { wrongAttacks: 1, wrongPitches: [E4] }), outcome(3)],
      [0, 1, 2],
      { createdAt: 2000 },
    )

    expect(mem.fixedBy(next, tl)).toEqual([1])
    mem.fold(next, tl, true)
    expect(mem.fixedBy(next, tl)).toEqual([1])
  })
})

describe('quiet threshold, recovery forgetting, and capacity bounds', () => {
  it('opens a place on a pause >= PAUSE_FLOOR_MS, keeps clean visits, and forgets after 3 quiet visits', () => {
    expect(PAUSE_FLOOR_MS).toBe(250)
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(2)

    // Clean with 249ms pause is quiet: no entry created.
    expect(mem.fold(scoredRecord(2, [outcome(0, { lateMs: 249 })], [0], { createdAt: 1000 }), tl, true)).toBe(false)
    expect(mem.history(rat(0, 4))).toEqual([])

    // Clean with 250ms pause is not quiet: opens entry.
    expect(mem.fold(scoredRecord(2, [outcome(0, { lateMs: 250 })], [0], { createdAt: 2000 }), tl, true)).toBe(true)
    expect(mem.history(rat(0, 4))).toHaveLength(1)
    expect(mem.history(rat(0, 4))[0]!.pauseMs).toBe(250)
    expect(mem.history(rat(0, 4))[0]!.clean).toBe(true)

    // Two quiet visits are kept; a third quiet visit forgets the place.
    mem.fold(scoredRecord(2, [outcome(0)], [0], { createdAt: 3000 }), tl, true)
    mem.fold(scoredRecord(2, [outcome(0)], [0], { createdAt: 4000 }), tl, true)
    expect(mem.history(rat(0, 4))).toHaveLength(3)

    mem.fold(scoredRecord(2, [outcome(0)], [0], { createdAt: 5000 }), tl, true)
    expect(mem.history(rat(0, 4))).toEqual([])
  })

  it('does not revive a stale hot spot when async seeding folds older mistakes after quiet live passes', () => {
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(1)
    // Three live quiet passes arrive before async seeding drains.
    mem.fold(scoredRecord(1, [outcome(0)], [0], { id: 'live-1', createdAt: 2000 }), tl, true)
    mem.fold(scoredRecord(1, [outcome(0)], [0], { id: 'live-2', createdAt: 2001 }), tl, true)
    mem.fold(scoredRecord(1, [outcome(0)], [0], { id: 'live-3', createdAt: 2002 }), tl, true)
    // Multiple older seeded mistakes arrive oldest-first: both recover against the pending live passes.
    mem.fold(
      scoredRecord(1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], { id: 'seed-1', createdAt: 900 }),
      tl,
      false,
    )
    mem.fold(
      scoredRecord(1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], { id: 'seed-2', createdAt: 1000 }),
      tl,
      false,
    )
    expect(mem.hotSpots(tl)).toEqual([])
    expect(mem.history(rat(0, 4))).toEqual([])

    // Also when a place opens and recovers between async seed batches: an older seed cannot revive it.
    const mem2 = new SpotMemory(SCOPE)
    mem2.fold(
      scoredRecord(1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], { id: 'b1', createdAt: 900 }),
      tl,
      false,
    )
    mem2.fold(scoredRecord(1, [outcome(0)], [0], { id: 'q1', createdAt: 2001 }), tl, true)
    mem2.fold(scoredRecord(1, [outcome(0)], [0], { id: 'q2', createdAt: 2002 }), tl, true)
    mem2.fold(scoredRecord(1, [outcome(0)], [0], { id: 'q3', createdAt: 2003 }), tl, true)
    mem2.fold(
      scoredRecord(1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], { id: 'b2', createdAt: 1000 }),
      tl,
      false,
    )
    expect(mem2.hotSpots(tl)).toEqual([])
    expect(mem2.history(rat(0, 4))).toEqual([])

    // Quiet live pass followed by a live mistake, then an older seeded mistake: streak stays 1.
    const mem3 = new SpotMemory(SCOPE)
    mem3.fold(scoredRecord(1, [outcome(0)], [0], { id: 'l1', createdAt: 2000 }), tl, true)
    mem3.fold(
      scoredRecord(1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], { id: 'w1', createdAt: 3000 }),
      tl,
      true,
    )
    mem3.fold(
      scoredRecord(1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], { id: 's0', createdAt: 900 }),
      tl,
      false,
    )
    expect(mem3.history(rat(0, 4)).map((v) => v.attemptId)).toEqual(['s0', 'l1', 'w1'])
    expect(mem3.streak(rat(0, 4), F4)).toBe(1)
  })

  it('caps visits per place at SPOT_VISITS (8), dropping the oldest', () => {
    expect(SPOT_VISITS).toBe(8)
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(1)

    for (let i = 1; i <= 10; i++) {
      mem.fold(
        scoredRecord(1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], {
          id: `v${i}`,
          createdAt: i * 1000,
        }),
        tl,
        true,
      )
    }

    const hist = mem.history(rat(0, 4))
    expect(hist).toHaveLength(8)
    expect(hist.map((v) => v.attemptId)).toEqual(['v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10'])
  })

  it('caps tracked places at SPOT_LIMIT (256), evicting the place visited longest ago', () => {
    expect(SPOT_LIMIT).toBe(256)
    const mem = new SpotMemory(SCOPE)
    const tl = makeTimeline(SPOT_LIMIT + 1)

    // Create 256 places at timestamps 1000..256000, then revisit place 0 at 300000
    // so place 1 (at 2000) becomes the one visited longest ago.
    for (let i = 0; i < SPOT_LIMIT; i++) {
      mem.fold(
        scoredRecord(SPOT_LIMIT + 1, [outcome(i, { wrongAttacks: 1, wrongPitches: [F4] })], [i], {
          createdAt: (i + 1) * 1000,
        }),
        tl,
        true,
      )
    }
    mem.fold(
      scoredRecord(SPOT_LIMIT + 1, [outcome(0, { wrongAttacks: 1, wrongPitches: [F4] })], [0], {
        createdAt: 300_000,
      }),
      tl,
      true,
    )

    // Adding place 256 at 400000 must evict place 1 (visited longest ago), keeping place 0 and place 256.
    mem.fold(
      scoredRecord(SPOT_LIMIT + 1, [outcome(SPOT_LIMIT, { wrongAttacks: 1, wrongPitches: [F4] })], [SPOT_LIMIT], {
        createdAt: 400_000,
      }),
      tl,
      true,
    )

    expect(mem.history(rat(0, 4))).toHaveLength(2)
    expect(mem.history(rat(1, 4))).toEqual([])
    expect(mem.history(rat(2, 4))).toHaveLength(1)
    expect(mem.history(rat(SPOT_LIMIT, 4))).toHaveLength(1)
  })
})
