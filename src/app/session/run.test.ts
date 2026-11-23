import { describe, expect, it } from 'vitest'
import type { AttemptRecord, GroupOutcome } from '../../core/model/practice'
import { addTraversal, runRecord, type ReadingRun, type RunRecord } from './run'

interface Played {
  readonly wrong?: readonly number[]
  readonly early?: number
  /** Reached, but not completed. */
  readonly open?: boolean
}

let n = 0

/** A reading traversal from `from` on: one outcome per entry, all completed unless `open`. */
function traversal(from: number, played: readonly Played[], patch: Partial<AttemptRecord> = {}): AttemptRecord {
  const groups: GroupOutcome[] = played.map((p, i) => ({
    group: from + i,
    wrongAttacks: (p.wrong?.length ?? 0) + (p.early ?? 0),
    earlyAttacks: p.early ?? 0,
    lateMs: 0,
    wrongPitches: p.wrong ?? [],
    spreadMs: 0,
    tieEndPresses: 0,
  }))
  return {
    id: `t${++n}`,
    kind: 'reading',
    contextKey: 'context',
    context: { hands: 'both' } as AttemptRecord['context'],
    completion: 'interrupted',
    onsets: played.flatMap((p, i) => (p.open ? [] : [{ group: from + i, t: i }])),
    measures: [],
    groups,
    assistance: { level: 'none', persistentLabelNotes: [] } as unknown as AttemptRecord['assistance'],
    ...patch,
  } as AttemptRecord
}

const ok: Played = {}
const open: Played = { open: true }

function run(...parts: (readonly [visit: number, record: AttemptRecord])[]): RunRecord {
  let r: ReadingRun | null = null
  for (const [visit, record] of parts) r = addTraversal(r, record, visit)
  return runRecord(r!)
}

const counts = (r: RunRecord) => [r.wrongAttacks, r.groupsFirstPass, r.groupsTotal]
const groups = (r: RunRecord) => r.groups.map((g) => g.group)

describe('a Wait run’s merge (U142)', () => {
  it('one traversal: every group, its wrong notes, the places right the first time', () => {
    const r = run([0, traversal(0, [ok, { wrong: [61, 61] }, ok])])
    expect(counts(r)).toEqual([2, 2, 3])
    expect(r).toMatchObject({ kind: 'run', passed: false, startGroup: 0 })
    expect(r.groups[1]!.wrongPitches).toEqual([61, 61])
    expect(run([0, traversal(0, [ok, ok])])).toMatchObject({ passed: true, wrongAttacks: 0 })
  })

  it('jumping back and playing on reports the last time through', () => {
    const r = run([0, traversal(0, [ok, { wrong: [61] }, ok, open])], [1, traversal(0, [ok, ok, ok, { wrong: [62] }])])
    expect(counts(r)).toEqual([1, 3, 4])
    expect(r.groups[1]!.wrongAttacks).toBe(0)
    expect([...r.visits]).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ])
  })

  it('jumping ahead keeps the earlier bars; what was never played is not counted', () => {
    const r = run([0, traversal(0, [ok, { wrong: [61] }, open])], [1, traversal(6, [ok, ok])])
    expect(groups(r)).toEqual([0, 1, 6, 7])
    expect(counts(r)).toEqual([1, 3, 4])
    expect(r.startGroup).toBe(0)
  })

  it('a group only reached, or left without a wrong key, keeps what it had', () => {
    const r = run([0, traversal(0, [ok, { wrong: [61] }, ok])], [1, traversal(1, [open])], [2, traversal(2, [ok])])
    expect(r.groups[1]!.wrongAttacks).toBe(1)
    expect(r.visits.get(1)).toBe(0)
    expect(counts(r)).toEqual([1, 2, 3])
  })

  it('a group tried with a wrong key and left counts, as its latest time', () => {
    const gaveUp = run([0, traversal(0, [ok, { wrong: [61, 63], open: true }])], [1, traversal(4, [ok])])
    expect(groups(gaveUp)).toEqual([0, 1, 4])
    expect(counts(gaveUp)).toEqual([2, 2, 3])
    const tried = run([0, traversal(0, [ok, ok, ok])], [1, traversal(1, [{ wrong: [61], open: true }])])
    expect(counts(tried)).toEqual([1, 2, 3])
  })

  it('a speed change continues the group it was at: its two parts are one', () => {
    const r = run(
      [0, traversal(0, [ok, { wrong: [61], open: true }], { interruptReason: 'tempo-change' })],
      [0, traversal(1, [{ wrong: [63] }, ok])],
    )
    expect(counts(r)).toEqual([2, 2, 3])
    expect(r.groups[1]).toMatchObject({ wrongAttacks: 2, wrongPitches: [61, 63] })
    // The wrong key before the split still keeps the place from being right the first time.
    const before = run([0, traversal(0, [{ wrong: [61], open: true }])], [0, traversal(0, [ok])])
    expect(counts(before)).toEqual([1, 0, 1])
  })

  it('a split group never adds up with an earlier time it was played', () => {
    const r = run(
      [0, traversal(0, [ok, { wrong: [61] }])],
      [1, traversal(1, [open], { interruptReason: 'tempo-change' })],
      [1, traversal(1, [ok])],
    )
    expect(counts(r)).toEqual([0, 2, 2])
  })

  it('begins where its first traversal did, under an id of its own', () => {
    const r = run([0, traversal(5, [ok, ok])], [1, traversal(0, [ok])])
    expect(r.startGroup).toBe(5)
    expect(r.id).toBe(`t${n}-run`)
  })

  it('folding a traversal leaves the run before it as it was', () => {
    const first = addTraversal(null, traversal(0, [{ wrong: [61] }]), 0)
    addTraversal(first, traversal(0, [ok]), 1)
    expect(runRecord(first).wrongAttacks).toBe(1)
  })
})
