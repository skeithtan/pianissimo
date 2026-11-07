import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import type { LadderSettings } from '../../core/storage/records'
import { harness, type Harness } from './testkit'

/** One bar of quarters (C D E F) and a second bar, quarter = 60. */
const melody = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
    { at: 2, midi: 64 },
    { at: 3, midi: 65 },
    { at: 4, midi: 67 },
    { at: 5, midi: 69 },
    { at: 6, midi: 71 },
    { at: 7, midi: 72 },
  ],
  bars: 2,
})

const LADDER: LadderSettings = { goal: 1, step: 0.05 }
const LOOP = { fromOcc: 0, toOcc: 0 }

async function open(multiplier: number, ladder: LadderSettings | null = LADDER, repeatTarget: number | null = null) {
  const h = harness(melody, { range: LOOP, multiplier }, { options: { ladder, repeatTarget } })
  await h.session.start()
  h.frames.flush()
  return h
}

/** Let the music finish the passage and the next pass get ready (or stop at a reached target). */
function settle(h: Harness): void {
  for (let t = 0; t < 20000 && h.session.engine.state.phase !== 'ready'; t += 100) {
    if (h.session.engine.state.phase === 'completed' && h.session.ui.get().lastResult?.targetReached) return
    h.step(100)
  }
}

function pass(h: Harness): void {
  h.play(60, 62, 64, 65)
  settle(h)
}

function fail(h: Harness): void {
  h.play(60)
  h.tap(61)
  h.play(62, 64, 65)
  settle(h)
}

const ui = (h: Harness) => h.session.ui.get()

describe('PracticeSession: speed ladder', () => {
  it('starts at the opening speed and shows in the UI', async () => {
    const h = await open(0.6)
    expect(ui(h).ladder).toEqual({ goal: 1, step: 0.05, start: 0.6, failures: 0, done: false })
    expect(harness(melody).session.ui.get().ladder).toBeNull()
  })

  it('does not climb before the target (default three clean passes)', async () => {
    const h = await open(0.6)
    pass(h)
    pass(h)
    expect(h.attempts.map((a) => a.passed)).toEqual([true, true])
    expect(ui(h).multiplier).toBe(0.6)
    expect(ui(h).lastResult?.ladder).toBeUndefined()
    expect(ui(h).lastResult?.streak).toBe(2)
  })

  it('climbs one step after the target and prepares a fresh attempt at the new speed', async () => {
    const h = await open(0.6)
    pass(h)
    pass(h)
    const wraps = h.strip.wraps
    h.play(60, 62, 64, 65)
    // The result says what comes next while the music finishes at the old speed.
    expect(ui(h).lastResult).toMatchObject({ streak: 3, targetReached: false, ladder: { climbedTo: 0.65 } })
    expect(ui(h).multiplier).toBe(0.6)
    settle(h)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h).multiplier).toBe(0.65)
    expect(ui(h).repeat).toBe(true)
    // The card stays through Ready, as after any Repeat pass, and the strip wraps to the loop start.
    expect(ui(h).lastResult?.ladder).toEqual({ climbedTo: 0.65 })
    expect(h.strip.wraps).toBe(wraps + 1)
    expect(h.saves.some((s) => s.patch.lastMultiplier === 0.65)).toBe(true)
    // The next attempt runs at the new speed, in its own comparison context, and the streak starts over.
    pass(h)
    expect(h.attempts).toHaveLength(4)
    expect(h.attempts[3]!.context.multiplier).toBe(0.65)
    expect(h.attempts[3]!.contextKey).not.toBe(h.attempts[2]!.contextKey)
    expect(ui(h).lastResult?.streak).toBe(1)
    expect(ui(h).lastResult?.ladder).toBeUndefined()
  })

  it('uses the Repeat target when there is one', async () => {
    const h = await open(0.6, LADDER, 2)
    pass(h)
    expect(ui(h).multiplier).toBe(0.6)
    pass(h)
    expect(ui(h).multiplier).toBe(0.65)
    // Climbing, the target does not stop Repeat.
    expect(ui(h).lastResult?.targetReached).toBe(false)
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('drops one step after two failures in a row, never below the start', async () => {
    const h = await open(0.6, LADDER, 1)
    pass(h)
    expect(ui(h).multiplier).toBe(0.65)
    fail(h)
    expect(ui(h).ladder?.failures).toBe(1)
    expect(ui(h).multiplier).toBe(0.65)
    fail(h)
    expect(h.attempts.map((a) => a.passed)).toEqual([true, false, false])
    expect(h.attempts[2]!.context.multiplier).toBe(0.65)
    expect(ui(h).lastResult?.ladder).toEqual({ droppedTo: 0.6 })
    expect(ui(h).multiplier).toBe(0.6)
    expect(ui(h).ladder?.failures).toBe(0)
    expect(h.session.engine.state.phase).toBe('ready')
    // At the floor a drop is a no-op.
    fail(h)
    fail(h)
    expect(ui(h).multiplier).toBe(0.6)
    expect(ui(h).lastResult?.ladder).toBeUndefined()
    expect(ui(h).ladder?.failures).toBe(0)
  })

  it('a pass resets the failure count', async () => {
    const h = await open(0.6, LADDER, 3)
    fail(h)
    expect(ui(h).ladder?.failures).toBe(1)
    pass(h)
    expect(ui(h).ladder?.failures).toBe(0)
  })

  it('ends at the goal: the target met there is "Goal reached"', async () => {
    const h = await open(0.65, { goal: 0.7, step: 0.05 }, 1)
    pass(h)
    expect(ui(h).multiplier).toBe(0.7)
    pass(h)
    expect(ui(h).lastResult).toMatchObject({ targetReached: true, ladder: { done: true } })
    expect(ui(h).ladder?.done).toBe(true)
    expect(ui(h).multiplier).toBe(0.7)
    expect(h.session.engine.state.phase).toBe('completed')
  })

  it('without a Repeat target the goal reached keeps repeating at the goal', async () => {
    const h = await open(0.7, { goal: 0.7, step: 0.05 })
    expect(ui(h).ladder?.done).toBe(true)
    pass(h)
    pass(h)
    pass(h)
    expect(ui(h).multiplier).toBe(0.7)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h).lastResult?.ladder).toBeUndefined()
  })

  it('manual speed changes reset failures, lower the floor and set done at the goal', async () => {
    const h = await open(0.6, LADDER, 3)
    fail(h)
    expect(ui(h).ladder?.failures).toBe(1)
    h.session.setSelection({ multiplier: 0.5 })
    expect(ui(h).ladder).toMatchObject({ start: 0.5, failures: 0, done: false })
    h.session.setSelection({ multiplier: 0.8 })
    expect(ui(h).ladder).toMatchObject({ start: 0.5, done: false })
    h.session.setSelection({ multiplier: 1 })
    expect(ui(h).ladder?.done).toBe(true)
  })

  it('a speed change while the climb waits for the music cancels the climb', async () => {
    const h = await open(0.6, LADDER, 1)
    h.play(60, 62, 64, 65)
    expect(ui(h).lastResult?.ladder).toEqual({ climbedTo: 0.65 })
    h.session.setSelection({ multiplier: 0.55 })
    h.step(5000)
    expect(ui(h).multiplier).toBe(0.55)
  })

  it('acts only while Repeat mode is open; closing Repeat keeps the setting', async () => {
    const h = await open(0.6, LADDER, 1)
    h.session.setRepeatMode(false)
    h.frames.flush()
    expect(ui(h).repeat).toBe(false)
    expect(ui(h).ladder).toMatchObject({ goal: 1 })
    h.session.setRepeatMode(true)
    h.frames.flush()
    expect(ui(h).ladder).toMatchObject({ goal: 1, start: 0.6 })
  })

  it('setLadder persists the setting, starts at the current speed and turns off', async () => {
    const h = await open(0.75, null)
    expect(ui(h).ladder).toBeNull()
    h.session.setLadder({ goal: 1, step: 0.05 })
    expect(ui(h).ladder).toEqual({ goal: 1, step: 0.05, start: 0.75, failures: 0, done: false })
    expect(h.saves.filter((s) => 'ladder' in s.patch).map((s) => s.patch.ladder)).toEqual([{ goal: 1, step: 0.05 }])
    // The same settings again change nothing.
    h.session.setLadder({ goal: 1, step: 0.05 })
    expect(h.saves.filter((s) => 'ladder' in s.patch)).toHaveLength(1)
    // A new goal keeps the start.
    h.session.setSelection({ multiplier: 0.8 })
    h.session.setLadder({ goal: 1.25, step: 0.05 })
    expect(ui(h).ladder).toMatchObject({ goal: 1.25, start: 0.75 })
    h.session.setLadder(null)
    expect(ui(h).ladder).toBeNull()
    expect(h.saves.at(-1)?.patch).toEqual({ ladder: null })
  })
})
