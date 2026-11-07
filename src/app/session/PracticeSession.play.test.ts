/**
 * Play-through mode (DECISIONS P12): the cursor follows the music and the learner's playing,
 * wrong notes never block, nothing is graded or recorded.
 */
import { describe, expect, it } from 'vitest'
import { PATIENCE_LAST_MS, patienceMs } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { harness, testSettings, type Harness } from './testkit'

// Quarter = 60: one quarter (a quarter of a whole note) per second.
const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
})

const twoHands = buildScore({
  notes: [
    ...[60, 62, 64, 65].map((midi, at) => ({ at, midi })),
    ...[48, 50, 52, 53].map((midi, at) => ({ at, midi, hand: 'L' as const })),
  ],
  bars: 1,
})

async function playThrough(h: Harness): Promise<void> {
  h.session.setPlayThrough(true)
  await h.session.start()
  h.frames.flush()
}

describe('Play-through mode', () => {
  it('toggling it on closes Repeat (the loop stays remembered) and hides the cursor action', () => {
    const h = harness(melody, { range: { fromOcc: 1, toOcc: 1 } })
    expect(h.session.ui.get().repeat).toBe(true)
    h.session.setPlayThrough(true)
    h.frames.flush()
    const ui = h.session.ui.get()
    expect(ui.playThrough).toBe(true)
    expect(ui.activity).toBe('playing')
    expect(ui.repeat).toBe(false)
    expect(ui.range).toBeNull()
    expect(ui.startAction).toBe('play')
    expect(ui.startEnabled).toBe(true)
    expect(ui.canHint).toBe(false)
    expect(h.session.loop).toEqual({ fromOcc: 1, toOcc: 1 })
    expect(h.strip.cursorAction).toBe(false)
    expect(h.strip.loopEditable).toBe(false)
    h.session.setPlayThrough(false)
    h.frames.flush()
    expect(h.session.ui.get().playThrough).toBe(false)
    expect(h.strip.cursorAction).toBe(true)
  })

  it('is not available while the hands are off (Listen)', () => {
    const h = harness(melody, { hands: 'none' })
    h.session.setPlayThrough(true)
    expect(h.session.ui.get().playThrough).toBe(false)
  })

  it('turning the hands off or opening Repeat leaves play-through', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.session.setRepeatMode(true)
    h.frames.flush()
    expect(h.session.ui.get().playThrough).toBe(false)
    expect(h.session.ui.get().repeat).toBe(true)
    h.session.setRepeatMode(false)
    await playThrough(h)
    h.session.setSelection({ hands: 'none' })
    expect(h.session.ui.get().playThrough).toBe(false)
  })

  it('Start runs a gated transport: the cursor waits at the first onset, then follows the music', async () => {
    const h = harness(melody)
    await playThrough(h)
    expect(h.session.ui.get().playing).toBe(true)
    expect(h.session.ui.get().phase).toBe('running')
    expect(h.strip.targets).toEqual([0])
    h.step(3000)
    // Waiting for the learner at the first onset indefinitely.
    expect(h.strip.cursor).toBe(0)
    h.tap(60)
    expect(h.strip.accepted).toEqual([])
    expect(h.strip.targets).toEqual([1])
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    expect(h.session.progress.get().position).toBe(h.strip.cursor)
    h.step(600)
    // Holding at the next onset (bar position 1/4).
    expect(h.strip.cursor).toBeCloseTo(0.25)
  })

  it('a wrong note never blocks: gentle feedback, then the patience releases the gate', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.tap(61)
    expect(h.strip.earlyMarker).toBe(true)
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.strip.pulses).toBe(0)
    expect(h.flash.hits.at(-1)?.soft).toBe(true)
    expect(h.session.feedback.get().visible).toBe(false)
    const patience = patienceMs(h.session.timeline, 0)
    expect(patience).toBe(1000)
    h.step(patience - 10)
    expect(h.strip.cursor).toBe(0)
    h.step(20)
    expect(h.strip.targets).toEqual([1])
    expect(h.strip.earlyMarker).toBe(false)
    h.step(500)
    expect(h.strip.cursor).toBeGreaterThan(0.1)
  })

  it('a learner who stops playing is waited for (no press, no deadline)', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.tap(60)
    h.step(20000)
    expect(h.strip.cursor).toBeCloseTo(0.25)
    expect(h.strip.targets).toEqual([1])
  })

  it('moving on to a later group releases the skipped gates and continues from there', async () => {
    const h = harness(melody)
    await playThrough(h)
    // 64 is the third group: the first two are skipped.
    h.tap(64)
    expect(h.strip.targets).toEqual([3])
    expect(h.strip.cursor).toBeCloseTo(0.5)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.625)
  })

  it('pause keeps the position and the patience clock stops; Resume continues', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.tap(60)
    h.step(1000)
    h.tap(63)
    h.step(400)
    h.session.togglePlay()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.ui.get().phase).toBe('paused')
    const at = h.strip.cursor
    h.step(5000)
    expect(h.strip.cursor).toBe(at)
    expect(h.strip.targets).toEqual([1])
    h.session.togglePlay()
    await Promise.resolve()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(true)
    h.step(500)
    expect(h.strip.targets).toEqual([1])
    h.step(200)
    expect(h.strip.targets).toEqual([2])
  })

  it('browsing while playing pauses', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.session.browseStarted()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.ui.get().activity).toBe('playing')
  })

  it('a seek while playing keeps playing from the first onset at or after it', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.tap(60)
    h.step(200)
    h.session.seek(1)
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(true)
    expect(h.strip.cursor).toBe(1)
    expect(h.strip.targets).toEqual([4])
    h.tap(67)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(1.125)
  })

  it('speed changes apply live', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.tap(60)
    h.session.setSelection({ multiplier: 0.5 })
    h.step(1000)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    expect(patienceMs(h.session.timeline, 1)).toBe(2000)
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('reaches the end of the piece, then the next Start begins at the start', async () => {
    const h = harness(melody)
    await playThrough(h)
    for (const n of [60, 62, 64, 65, 67, 69, 71]) {
      h.tap(n)
      h.step(1000)
    }
    h.tap(72)
    expect(h.session.ui.get().playing).toBe(true)
    h.step(1100)
    const ui = h.session.ui.get()
    expect(ui.playing).toBe(false)
    expect(ui.phase).toBe('completed')
    expect(h.strip.cursor).toBe(2)
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(true)
    expect(h.strip.cursor).toBe(0)
    expect(h.strip.targets).toEqual([0])
  })

  it('the last group waits PATIENCE_LAST_MS after a wrong press', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.session.seek(1)
    for (const n of [67, 69, 71]) {
      h.tap(n)
      h.step(1000)
    }
    h.tap(30)
    h.step(PATIENCE_LAST_MS - 10)
    expect(h.strip.targets).toEqual([7])
    h.step(20)
    expect(h.strip.targets).toEqual([])
  })

  it('toggling off returns to reading at the same position, and nothing was recorded', async () => {
    const h = harness(melody)
    await playThrough(h)
    for (const n of [60, 62, 64]) {
      h.tap(n)
      h.step(1000)
    }
    h.tap(61)
    h.step(2000)
    h.session.setPlayThrough(false)
    h.frames.flush()
    const ui = h.session.ui.get()
    expect(ui.activity).not.toBe('playing')
    expect(ui.playing).toBe(false)
    expect(h.session.engine.state.groupIndex).toBe(4)
    expect(h.strip.cursor).toBe(1)
    expect(h.attempts).toHaveLength(0)
    expect(h.abandons).toHaveLength(0)
    // Reading continues from there.
    await h.session.start()
    h.tap(67)
    expect(h.session.engine.state.groupIndex).toBe(5)
  })

  it('a reading pass replaced by play-through ends unrecorded', async () => {
    const h = harness(melody)
    await h.session.start()
    h.play(60, 62)
    await playThrough(h)
    h.tap(64)
    h.step(500)
    h.session.setPlayThrough(false)
    h.frames.flush()
    expect(h.attempts).toHaveLength(0)
    expect(h.abandons).toHaveLength(0)
  })

  it('saves the resume position like reading', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.tap(60)
    h.step(1000)
    h.tap(62)
    h.step(100)
    h.session.pause()
    const resume = h.saves.map((s) => s.patch.resume).filter((r) => r)
    expect(resume.at(-1)?.group).toBe(2)
  })

  it('the hint pedal names both hands’ notes at the cursor', async () => {
    const pedal = {
      ...DEFAULT_SETTINGS.pedal,
      hintPedal: {
        channel: null,
        controller: 66,
        threshold: 64,
        inverted: false,
        observedMin: 0,
        observedMax: 127,
        verified: true,
      },
    }
    const h = harness(twoHands, { hands: 'right' }, { settings: testSettings({ pedal }) })
    await playThrough(h)
    expect(h.strip.opacity.size).toBe(0)
    h.midi.cc(66, 127, h.clock.now)
    h.frames.flush()
    expect([...h.strip.opacity.keys()].sort((a, b) => a - b)).toEqual([0, 1])
  })

  it('one hand plays the other hand automatically and needs an output', async () => {
    const h = harness(twoHands, { hands: 'right' })
    await playThrough(h)
    expect(h.session.ui.get().playing).toBe(true)
    h.tap(60)
    h.step(500)
    expect(h.backend.ons().map((c) => c.note)).toContain(48)

    const quiet = harness(twoHands, { hands: 'right' })
    quiet.midi.out = null
    quiet.session.setPlayThrough(true)
    quiet.frames.flush()
    const ui = quiet.session.ui.get()
    expect(ui.startAction).toBe('play')
    expect(ui.startEnabled).toBe(false)
    expect(ui.startReason).toMatch(/One-hand practice needs/)
    await quiet.session.start()
    expect(quiet.session.ui.get().playing).toBe(false)
  })

  it('new hands rebuild the transport at the same group and keep playing', async () => {
    const h = harness(twoHands)
    await playThrough(h)
    h.tap(60, 48)
    h.step(1000)
    expect([...h.strip.targets].sort()).toEqual([2, 3])
    h.session.setSelection({ hands: 'right' })
    await h.session.start()
    h.frames.flush()
    const ui = h.session.ui.get()
    expect(ui.playThrough).toBe(true)
    expect(ui.playing).toBe(true)
    // The right hand's note of the same (second) group.
    expect(h.strip.targets).toEqual([2])
    expect(h.strip.cursor).toBeCloseTo(0.25)
  })

  it('a disconnected piano pauses play-through without an interruption banner', async () => {
    const h = harness(melody)
    await playThrough(h)
    h.tap(60)
    h.midi.route({ kind: 'input-disconnected' } as never)
    h.frames.flush()
    const ui = h.session.ui.get()
    expect(ui.playing).toBe(false)
    expect(ui.interruption).toBeNull()
    expect(ui.inputDisconnected).toBe(true)
    expect(h.attempts).toHaveLength(0)
  })
})
