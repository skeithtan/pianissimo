import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import type { LadderSettings } from '../../core/storage/records'
import { harness, testSettings, type Harness } from './testkit'

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

async function open(
  multiplier: number,
  ladder: LadderSettings | null = LADDER,
  repeatTarget: number | null = null,
  settings = testSettings(),
) {
  const h = harness(melody, { range: LOOP, multiplier }, { settings, options: { ladder, repeatTarget } })
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
  h.play(60)
  h.step(CHORD_SLIP_MS)
  h.play(62, 64, 65)
  settle(h)
}

function fail(h: Harness): void {
  h.play(60)
  h.tap(61)
  if (h.session.engine.state.retryGroup) {
    h.step(CHORD_SLIP_MS)
    h.play(60)
    h.step(CHORD_SLIP_MS)
  }
  h.play(62, 64, 65)
  settle(h)
}

const ui = (h: Harness) => h.session.ui.get()

describe('PracticeSession: speed ladder', () => {
  it('starts at the opening speed and shows in the UI', async () => {
    const h = await open(0.6)
    expect(ui(h).ladder).toEqual({ goal: 1, step: 0.05, done: false })
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
    // The step runs from the MIDI path: debounced, never an immediate write.
    expect(h.saves.filter((s) => s.patch.lastMultiplier === 0.65).every((s) => !s.immediate)).toBe(true)
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

  describe('with note names shown and a hint asked for in every pass (U144)', () => {
    const labeled = testSettings({ labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' } })
    function helpedPass(h: Harness): void {
      h.session.onVisibleLabels([0, 1, 2, 3])
      h.session.requestHint()
      pass(h)
      expect(h.attempts.at(-1)).toMatchObject({ passed: true, assistance: { level: 'names', hintRequests: 1 } })
    }

    it('the streak climbs and the target is reached', async () => {
      const h = await open(1, null, 2, labeled)
      helpedPass(h)
      expect(ui(h).lastResult).toMatchObject({ passed: true, streak: 1, targetReached: false })
      helpedPass(h)
      expect(ui(h).lastResult).toMatchObject({ passed: true, streak: 2, targetReached: true })
    })

    it('the ladder climbs', async () => {
      const h = await open(0.6, LADDER, 2, labeled)
      helpedPass(h)
      helpedPass(h)
      expect(ui(h).lastResult?.ladder).toEqual({ climbedTo: 0.65 })
      expect(ui(h).multiplier).toBe(0.65)
    })
  })

  it('keeps the new speed after consecutive failures and restarts the clean streak', async () => {
    const h = await open(0.6, LADDER, 2)
    pass(h)
    pass(h)
    expect(ui(h).multiplier).toBe(0.65)
    pass(h)
    expect(ui(h).lastResult?.streak).toBe(1)
    for (let i = 0; i < 3; i++) {
      fail(h)
      expect(h.attempts.at(-1)).toMatchObject({ passed: false, context: { multiplier: 0.65 } })
      expect(ui(h)).toMatchObject({ multiplier: 0.65, lastResult: { streak: 0 } })
      expect(ui(h).lastResult?.ladder).toBeUndefined()
      expect(h.session.engine.state.phase).toBe('ready')
    }
    pass(h)
    expect(ui(h).multiplier).toBe(0.65)
    pass(h)
    expect(ui(h).multiplier).toBe(0.7)
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

  it('manual speed changes update whether the ladder is at its goal', async () => {
    const h = await open(0.6, LADDER, 3)
    h.session.setSelection({ multiplier: 1 })
    expect(ui(h).ladder?.done).toBe(true)
    h.session.setSelection({ multiplier: 0.8 })
    h.frames.flush()
    expect(ui(h)).toMatchObject({ multiplier: 0.8, ladder: { done: false } })
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
    expect(ui(h)).toMatchObject({ multiplier: 0.6, ladder: { goal: 1 } })
  })

  it('setLadder persists the setting, starts at the current speed and turns off', async () => {
    const h = await open(0.75, null)
    expect(ui(h).ladder).toBeNull()
    h.session.setLadder({ goal: 1, step: 0.05 })
    expect(ui(h)).toMatchObject({ multiplier: 0.75, ladder: { goal: 1, step: 0.05, done: false } })
    expect(h.saves.filter((s) => 'ladder' in s.patch).map((s) => s.patch.ladder)).toEqual([{ goal: 1, step: 0.05 }])
    // The same settings again change nothing.
    h.session.setLadder({ goal: 1, step: 0.05 })
    expect(h.saves.filter((s) => 'ladder' in s.patch)).toHaveLength(1)
    // Changing to a higher goal keeps the selected speed.
    h.session.setSelection({ multiplier: 0.8 })
    h.session.setLadder({ goal: 1.25, step: 0.05 })
    expect(ui(h)).toMatchObject({ multiplier: 0.8, ladder: { goal: 1.25 } })
    h.session.setLadder(null)
    expect(ui(h).ladder).toBeNull()
    expect(h.saves.at(-1)?.patch).toEqual({ ladder: null })
  })

  it('switching from a faster ladder to 100% starts a fresh climb at 75%', async () => {
    const h = await open(0.6, { goal: 1.5, step: 0.05 }, 1)
    h.session.setSelection({ multiplier: 1.25 })
    h.session.setLadder(LADDER)
    expect(ui(h)).toMatchObject({
      multiplier: 0.75,
      ladder: { goal: 1, done: false },
    })
    for (const speed of [0.75, 0.8, 0.85, 0.9, 0.95, 1]) {
      expect(ui(h).multiplier).toBe(speed)
      pass(h)
      expect(h.attempts.at(-1)?.context.multiplier).toBe(speed)
    }
    expect(ui(h).lastResult).toMatchObject({ targetReached: true, ladder: { done: true } })
  })

  it('Start during the tail of the climbing pass begins the next pass at the climbed speed', async () => {
    const h = await open(0.6)
    pass(h)
    pass(h)
    h.play(60, 62, 64, 65)
    expect(ui(h).lastResult?.ladder).toEqual({ climbedTo: 0.65 })
    expect(ui(h).playing).toBe(false)
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h).multiplier).toBe(0.65)
    // A new run: the card goes and the streak starts over (P11).
    expect(ui(h).lastResult).toBeNull()
    expect(h.saves.some((s) => s.patch.lastMultiplier === 0.65)).toBe(true)
    pass(h)
    expect(h.attempts).toHaveLength(4)
    expect(h.attempts[3]!.context.multiplier).toBe(0.65)
    expect(ui(h).lastResult?.streak).toBe(1)
    expect(ui(h).multiplier).toBe(0.65)
  })

  it('Again during the tail of the climbing pass begins the next pass at the climbed speed', async () => {
    const h = await open(0.6)
    pass(h)
    pass(h)
    h.play(60, 62, 64, 65)
    expect(ui(h).lastResult?.ladder).toEqual({ climbedTo: 0.65 })
    h.session.restart()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h).multiplier).toBe(0.65)
    expect(ui(h).lastResult).toBeNull()
    pass(h)
    expect(h.attempts).toHaveLength(4)
    expect(h.attempts[3]!.context.multiplier).toBe(0.65)
    expect(ui(h).lastResult?.streak).toBe(1)
  })

  describe('a lead-in during the tail of the climbing pass', () => {
    const SECOND = { fromOcc: 1, toOcc: 1 }

    /** Three clean passes over the second bar climb; during the music's tail, a seek to bar 1 leads in. */
    async function leadInAfterClimb(): Promise<Harness> {
      const h = harness(melody, { range: SECOND, multiplier: 0.6 }, { options: { ladder: LADDER } })
      await h.session.start()
      h.frames.flush()
      for (let i = 0; i < 2; i++) {
        h.play(67, 69, 71, 72)
        settle(h)
      }
      h.play(67, 69, 71, 72)
      expect(ui(h).lastResult?.ladder).toEqual({ climbedTo: 0.65 })
      h.session.seek(0)
      h.frames.flush()
      expect(ui(h).lastResult).toBeNull()
      // The lead-in reads the first bar and hands over to the attempt over the loop.
      h.play(60, 62, 64, 65)
      // The music plays on into the loop, where the attempt waits for the first note.
      for (let t = 0; t < 5000 && h.session.engine.state.transportGate < 0; t += 20) h.step(20)
      expect(h.session.engine.mode).toBe('scored')
      expect(ui(h).multiplier).toBe(0.6)
      return h
    }

    it('Again in the run it started is a user restart at the same speed', async () => {
      const h = await leadInAfterClimb()
      const before = h.attempts.length
      h.play(67)
      h.tap(61)
      h.session.restart()
      h.frames.flush()
      expect(ui(h).multiplier).toBe(0.6)
      expect(h.attempts.slice(before)).toHaveLength(1)
      expect(h.attempts.at(-1)).toMatchObject({
        completion: 'abandoned',
        interruptReason: 'user-restart',
        context: { multiplier: 0.6 },
      })
      expect(h.abandons).toHaveLength(1)
    })

    it('Pause and Start in the run it started keep the speed', async () => {
      const h = await leadInAfterClimb()
      h.play(67)
      h.session.pause()
      await h.session.start()
      h.frames.flush()
      expect(ui(h).multiplier).toBe(0.6)
      expect(h.session.engine.state.phase).toBe('ready')
    })

    it('the climb is canceled: the attempt runs at the old speed and the ladder counts afresh', async () => {
      const h = await leadInAfterClimb()
      const before = h.attempts.length
      h.play(67, 69, 71, 72)
      settle(h)
      expect(h.attempts.slice(before).map((a) => [a.kind, a.passed, a.context.multiplier])).toEqual([
        ['scored', true, 0.6],
      ])
      // A new run: one clean pass is not yet the three the ladder needs.
      expect(ui(h).lastResult).toMatchObject({ streak: 1 })
      expect(ui(h).lastResult?.ladder).toBeUndefined()
      expect(ui(h).multiplier).toBe(0.6)
      expect(h.session.engine.state.phase).toBe('ready')
    })
  })
})
