import { describe, expect, it } from 'vitest'
import { MAX_CORE_BARS } from '../../core/history'
import type { GroupOutcome } from '../../core/model/practice'
import { roughPassage } from './rough'

const PIECE = 30
/** Two groups per bar. */
const timeline = { groups: Array.from({ length: PIECE * 2 }, (_, i) => ({ occ: i >> 1 })) } as unknown as Parameters<
  typeof roughPassage
>[1]

const outcome = (group: number, patch: Partial<GroupOutcome> = {}): GroupOutcome => ({
  group,
  wrongAttacks: 0,
  earlyAttacks: 0,
  lateMs: 0,
  ...patch,
})

/** A run over bars `from`–`to` with the given wrong attacks per bar (in its second group). */
function run(
  wrong: Record<number, number>,
  from = 0,
  to = PIECE - 1,
  patch: Record<number, Partial<GroupOutcome>> = {},
) {
  const out: GroupOutcome[] = []
  for (let g = from * 2; g <= to * 2 + 1; g++)
    out.push(outcome(g, { wrongAttacks: g % 2 === 1 ? (wrong[g >> 1] ?? 0) : 0, ...patch[g] }))
  return out
}
const rough = (outcomes: readonly GroupOutcome[], strict = false) => roughPassage(outcomes, timeline, PIECE, strict)

describe('roughPassage (U142)', () => {
  it('is the heaviest run of adjacent rough bars, with a context bar on each side', () => {
    expect(rough(run({ 4: 1, 10: 2, 11: 1, 20: 2 }))).toEqual({ fromOcc: 9, toOcc: 12 })
  })

  it('the earlier of two equally rough runs', () => {
    expect(rough(run({ 20: 2, 5: 2 }))).toEqual({ fromOcc: 4, toOcc: 6 })
  })

  it('a missed group weighs like a wrong attack', () => {
    const outcomes = run({ 4: 1 }, 0, PIECE - 1, { 24: { missed: true }, 25: { missed: true } })
    expect(rough(outcomes, true)).toEqual({ fromOcc: 11, toOcc: 13 })
  })

  it('timing alone makes none: late or early completions, and in Keep time a right key too early', () => {
    const late = run({}, 0, PIECE - 1, { 8: { lateMs: 900, offsetMs: 400 }, 9: { offsetMs: -300, spreadMs: 400 } })
    expect(rough(late, true)).toBeNull()
    const early = run({}, 0, PIECE - 1, { 8: { wrongAttacks: 2, earlyAttacks: 2 } })
    expect(rough(early, true)).toBeNull()
    // In Wait it is one of the run's wrong notes.
    expect(rough(early)).toEqual({ fromOcc: 3, toOcc: 5 })
  })

  it('a long run is cut to its heaviest bars, the earlier on a tie', () => {
    const wrong: Record<number, number> = {}
    for (let occ = 5; occ <= 16; occ++) wrong[occ] = 1
    expect(MAX_CORE_BARS).toBe(6)
    expect(rough(run(wrong))).toEqual({ fromOcc: 4, toOcc: 11 })
    expect(rough(run({ ...wrong, 14: 3 }))).toEqual({ fromOcc: 8, toOcc: 15 })
  })

  it('context bars stop at the ends of the piece', () => {
    expect(rough(run({ 0: 1 }))).toEqual({ fromOcc: 0, toOcc: 1 })
    expect(rough(run({ [PIECE - 1]: 1 }))).toEqual({ fromOcc: PIECE - 2, toOcc: PIECE - 1 })
  })

  it('a run that began later in the piece counts its own bars only', () => {
    expect(rough(run({ 25: 1 }, 20))).toEqual({ fromOcc: 24, toOcc: 26 })
  })

  it('is null for a clean run, and when it would cover the whole run', () => {
    expect(rough(run({}))).toBeNull()
    expect(rough([])).toBeNull()
    expect(rough(run({ 21: 1 }, 20, 22))).toBeNull()
    expect(rough(run({ 21: 1 }, 20, 23))).toEqual({ fromOcc: 20, toOcc: 22 })
  })

  it('a group outside the timeline weighs nothing', () => {
    expect(rough([...run({}), outcome(999, { wrongAttacks: 5 })])).toBeNull()
  })
})
