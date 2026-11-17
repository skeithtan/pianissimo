/**
 * Wrong keys in the loop report (DECISIONS P24): a key pressed with a pass's final chord is
 * counted, and the same wrong key at the same place pass after pass reaches the result summary
 * as `repeatedMistakes`.
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { repeatedMistakeLine } from './mistakes'
import { harness, type Harness } from './testkit'

// Bar 1: C D E, then the C–E chord; bar 2: G.
const score = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
    { at: 2, midi: 64 },
    { at: 3, midi: 60 },
    { at: 3, midi: 64 },
    { at: 4, midi: 67 },
  ],
  bars: 2,
})
const loop = { fromOcc: 0, toOcc: 0 }

/** One pass over bar 1 from Ready: C, then `wrong` (300 ms later, before D), D, E, the chord. */
function pass(h: Harness, wrong: number | null): void {
  for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  h.play(60)
  if (wrong !== null) {
    h.step(300)
    h.tap(wrong)
  }
  h.play(62, 64, 60, 64)
  h.step(200)
}

describe('repeated mistakes in the result summary (P24)', () => {
  it('the same wrong key at the same note three passes running is named in lastResult', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    pass(h, 61)
    pass(h, 61)
    expect(h.attempts.map((a) => a.wrongAttacks)).toEqual([1, 1])
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toBeUndefined()
    pass(h, 61)
    const result = h.session.ui.get().lastResult!
    expect(result.wrongAttacks).toBe(1)
    expect(result.repeatedMistakes).toMatchObject([
      { group: 1, occ: 0, bar: '1', expectedPitch: 62, wrongPitch: 61, passes: 3 },
    ])
    expect(repeatedMistakeLine(result.repeatedMistakes![0]!, score, DEFAULT_SETTINGS.naming)).toBe(
      'D♭ instead of D♮ in bar 1, three passes running',
    )
    // A clean pass at that note: nothing repeated any more.
    pass(h, null)
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toBeUndefined()
  })

  it('a new speed starts a new run (another comparison context)', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    pass(h, 61)
    pass(h, 61)
    h.session.setSelection({ multiplier: 0.8 })
    await h.session.start()
    pass(h, 61)
    expect(h.attempts).toHaveLength(3)
    expect(h.session.ui.get().lastResult?.repeatedMistakes).toBeUndefined()
  })
})

describe('a key pressed with the final chord (P24)', () => {
  it('is counted: the pass fails and its last group carries the wrong key', async () => {
    const h = harness(score, { range: loop }, { deps: { finalSlipMs: CHORD_SLIP_MS } })
    await h.session.start()
    h.play(60, 62, 64, 60, 64)
    // The chord's last right key is in; an extra F arrives 20 ms later.
    expect(h.attempts).toHaveLength(0)
    h.step(20)
    h.tap(65)
    h.step(200)
    expect(h.attempts).toHaveLength(1)
    const r = h.attempts[0]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false })
    expect(r.groups!.at(-1)).toMatchObject({ group: 3, wrongPitches: [65] })
    expect(h.session.ui.get().lastResult).toMatchObject({ passed: false, wrongAttacks: 1, streak: 0 })
  })

  it('a clean final chord still passes, just after the hold', async () => {
    const h = harness(score, { range: loop }, { deps: { finalSlipMs: CHORD_SLIP_MS } })
    await h.session.start()
    h.play(60, 62, 64, 60, 64)
    h.step(CHORD_SLIP_MS + 20)
    expect(h.attempts.map((a) => [a.completion, a.passed])).toEqual([['completed', true]])
  })
})
