/**
 * Mistake memory in the session's review (P38): recurring correction marks (`repeat`),
 * `resultDetails().marks` carrying the same `repeat`, and `resultDetails().fixed` listing
 * groups that went wrong on the prior visit and were played clean this pass.
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { LATE_MARK_MS } from './corrections'
import { harness, type Harness } from './testkit'

// Bar 1: C D E F♯ (all right hand, quarter notes).
const score = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
    { at: 2, midi: 64 },
    { at: 3, midi: 66 },
  ],
  bars: 1,
})
const loop = { fromOcc: 0, toOcc: 0 }

function ready(h: Harness): void {
  for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  expect(h.session.engine.state.phase).toBe('ready')
}

/** Play bar 1 with optional wrong keys at group indices and optional pause (ms) before group 2. */
function pass(
  h: Harness,
  opts: { readonly wrong?: Partial<Record<number, number[]>>; readonly pauseAt2Ms?: number } = {},
): void {
  ready(h)
  const pitches = [60, 62, 64, 66]
  for (let i = 0; i < pitches.length; i++) {
    if (i === 2 && opts.pauseAt2Ms) h.step(opts.pauseAt2Ms)
    const bad = opts.wrong?.[i]
    if (bad) {
      h.step(300)
      for (const p of bad) h.tap(p)
      h.step(CHORD_SLIP_MS)
    }
    h.play(pitches[i]!)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(pitches[i]!)
    }
    h.step(CHORD_SLIP_MS)
  }
  h.step(200)
}

describe('recurring correction marks and fixed groups in PracticeSession', () => {
  it('sets repeat: 2 after two passes and 3 after three on the same wrong key, none on timing marks, and mirrors it in resultDetails().marks', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()

    // Pass 1: wrong key D♭ (61) at D (group 1) + late pause at E (group 2).
    pass(h, { wrong: { 1: [61] }, pauseAt2Ms: LATE_MARK_MS + 400 })
    const pass1Marks = h.strip.corrections
    expect(pass1Marks.find((m) => m.kind === 'accidental')?.repeat).toBeUndefined()
    expect(pass1Marks.find((m) => m.kind === 'late')?.repeat).toBeUndefined()
    expect(h.session.resultDetails()?.marks.get(1)?.repeat).toBeUndefined()

    // Pass 2: same wrong key at D + late pause at E again.
    pass(h, { wrong: { 1: [61] }, pauseAt2Ms: LATE_MARK_MS + 400 })
    const pass2Marks = h.strip.corrections
    expect(pass2Marks.find((m) => m.kind === 'accidental')?.repeat).toBe(2)
    expect(pass2Marks.find((m) => m.kind === 'late')?.repeat).toBeUndefined()
    expect(h.session.resultDetails()?.marks.get(1)?.repeat).toBe(2)
    expect(h.session.resultDetails()?.marks.get(2)?.repeat).toBeUndefined()

    // Pass 3: same wrong key at D again.
    pass(h, { wrong: { 1: [61] } })
    expect(h.strip.corrections.find((m) => m.kind === 'accidental')?.repeat).toBe(3)
    expect(h.session.resultDetails()?.marks.get(1)?.repeat).toBe(3)
  })

  it('gives no repeat when a different wrong key is pressed each pass', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()

    pass(h, { wrong: { 1: [61] } })
    pass(h, { wrong: { 1: [63] } })
    const mark = h.strip.corrections.find((m) => m.kind === 'accidental')
    expect(mark).toBeDefined()
    expect(mark?.repeat).toBeUndefined()
    expect(h.session.resultDetails()?.marks.get(1)?.repeat).toBeUndefined()
  })

  it('lists fixed groups in resultDetails().fixed only when the previous visit went wrong and this pass is clean', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()

    // Pass 1: clean everywhere -> nothing was wrong before, so fixed is empty.
    pass(h)
    expect(h.session.resultDetails()?.fixed).toEqual([])

    // Pass 2: wrong at group 1 (D) and group 3 (F♯).
    pass(h, { wrong: { 1: [61], 3: [65] } })
    expect(h.session.resultDetails()?.fixed).toEqual([])

    // Pass 3: group 1 fixed (clean), group 3 still wrong.
    pass(h, { wrong: { 3: [65] } })
    expect(h.session.resultDetails()?.fixed).toEqual([1])

    // Pass 4: clean everywhere -> group 3 is now fixed, group 1 was already clean so not listed again.
    pass(h)
    expect(h.session.resultDetails()?.fixed).toEqual([3])
  })
})
