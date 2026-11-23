/**
 * Follow (DECISIONS P12): the cursor follows the music and the learner's playing,
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

async function follow(h: Harness): Promise<void> {
  h.session.setMode('follow')
  await h.session.start()
  h.frames.flush()
}

describe('Follow', () => {
  it('covers the whole piece with Repeat put away, and leaving brings Repeat back as it was', async () => {
    const h = harness(melody, { range: { fromOcc: 1, toOcc: 1 } })
    expect(h.session.ui.get().repeat).toBe(true)
    h.session.setMode('follow')
    h.frames.flush()
    const ui = h.session.ui.get()
    expect(ui).toMatchObject({
      mode: 'follow',
      activity: 'playing',
      repeat: false,
      range: null,
      startAction: 'play',
      startEnabled: true,
      canHint: false,
      canRestartLoop: false,
    })
    expect(h.session.loop).toEqual({ fromOcc: 1, toOcc: 1 })
    expect(h.strip.loop).toBeNull()
    expect(h.strip.cursorAction).toBe(false)
    expect(h.strip.loopEditable).toBe(false)
    // It plays past the loop's end... and before its start.
    await h.session.start()
    h.session.seek(0)
    h.frames.flush()
    expect(h.strip.targets).toEqual([0])
    h.session.setMode('wait')
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ mode: 'wait', repeat: true, range: { fromOcc: 1, toOcc: 1 } })
    expect(h.strip.loop).toEqual({ fromOcc: 1, toOcc: 1 })
    // The piece keeps Repeat open throughout.
    expect(h.saves.some((s) => 'repeatOpen' in s.patch || 'lastPassage' in s.patch)).toBe(false)
  })

  it('leaving brings back nothing when Repeat was closed', () => {
    const h = harness(melody, { range: { fromOcc: 1, toOcc: 1 } }, { options: { repeat: false } })
    h.session.setMode('follow')
    h.session.setMode('listen')
    expect(h.session.ui.get()).toMatchObject({ repeat: false, range: null })
    expect(h.session.loop).toEqual({ fromOcc: 1, toOcc: 1 })
  })

  it('opened in Follow with Repeat open on the piece, Repeat waits for another mode', () => {
    const range = { fromOcc: 1, toOcc: 1 }
    const h = harness(melody, { range }, { options: { mode: 'follow', repeat: true } })
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', repeat: false, range: null })
    h.session.setMode('time')
    expect(h.session.ui.get()).toMatchObject({ mode: 'time', repeat: true, range })
  })

  it('opens no Repeat: nothing pauses and nothing is saved; a loop cleared meanwhile stays cleared', async () => {
    const h = harness(melody, { range: { fromOcc: 1, toOcc: 1 } }, { options: { mode: 'follow', repeat: true } })
    await h.session.start()
    h.session.setRepeatMode(true)
    h.session.repeatFrom(0)
    h.session.repeatAtCursor()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', repeat: false, playing: true })
    expect(h.saves).toEqual([])
    h.session.setSelection({ range: null })
    expect(h.saves.at(-1)).toMatchObject({ patch: { lastPassage: null, repeatOpen: false }, immediate: true })
    h.session.setMode('wait')
    expect(h.session.ui.get()).toMatchObject({ repeat: false, range: null })
  })

  it('Start runs a gated transport: the cursor waits at the first onset, then follows the music', async () => {
    const h = harness(melody)
    await follow(h)
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

  it.each([
    { direction: 'rushing', gap: 400 },
    { direction: 'dragging', gap: 1600 },
  ])('shows $direction for a large deviation from the written pace', async ({ direction, gap }) => {
    const h = harness(melody)
    await follow(h)
    h.step(2000)
    h.tap(60)
    expect(h.strip.timingCue).toBeNull()
    h.step(gap)
    h.tap(62)
    expect(h.strip.timingCue).toBe(direction)
    expect(h.strip.targets).toEqual([2])
    h.step(1000)
    h.tap(64)
    expect(h.strip.timingCue).toBe(direction)
    h.step(1000)
    h.tap(65)
    expect(h.strip.timingCue).toBeNull()
    expect(h.attempts).toEqual([])
  })

  it('changes the live timing display while continuing to follow the piano', async () => {
    const h = harness(melody)
    await follow(h)
    h.tap(60)
    h.step(400)
    h.tap(62)
    expect(h.strip.timingCue).toBe('rushing')
    h.session.updateSettings(testSettings({ hints: { ...DEFAULT_SETTINGS.hints, showTimingCues: false } }))
    h.frames.flush()
    expect(h.strip.timingCue).toBeNull()
    expect(h.session.ui.get().playing).toBe(true)
    h.session.updateSettings(testSettings())
    h.frames.flush()
    expect(h.strip.timingCue).toBe('rushing')
  })

  it('clears the cue while held at a gate and starts a fresh comparison after a speed change', async () => {
    const h = harness(melody)
    await follow(h)
    h.tap(60)
    h.step(100)
    h.tap(62)
    expect(h.strip.timingCue).toBe('rushing')
    h.step(1201)
    expect(h.strip.targets).toEqual([2])
    expect(h.strip.timingCue).toBeNull()
    h.session.setSelection({ multiplier: 0.5 })
    h.tap(64)
    h.step(2000)
    h.tap(65)
    expect(h.strip.timingCue).toBeNull()
    h.step(1800)
    h.tap(67)
    expect(h.strip.timingCue).toBeNull()
    h.step(1800)
    h.tap(69)
    expect(h.strip.timingCue).toBe('rushing')
    h.session.pause()
    h.frames.flush()
    expect(h.strip.timingCue).toBeNull()
  })

  it('a wrong note never blocks: gentle feedback, then the patience releases the gate', async () => {
    const h = harness(melody)
    await follow(h)
    h.tap(61)
    expect(h.strip.timingCue).toBeNull()
    expect(h.flash.hits.at(-1)?.soft).toBe(true)
    expect(h.session.feedback.get().visible).toBe(false)
    const patience = patienceMs(h.session.timeline, 0)
    expect(patience).toBe(1000)
    h.step(patience - 10)
    expect(h.strip.cursor).toBe(0)
    h.step(20)
    expect(h.strip.targets).toEqual([1])
    h.step(500)
    expect(h.strip.cursor).toBeGreaterThan(0.1)
  })

  it('a learner who stops playing is waited for (no press, no deadline)', async () => {
    const h = harness(melody)
    await follow(h)
    h.tap(60)
    h.step(20000)
    expect(h.strip.cursor).toBeCloseTo(0.25)
    expect(h.strip.targets).toEqual([1])
  })

  it('moving on to a later group releases the skipped gates and continues from there', async () => {
    const h = harness(melody)
    await follow(h)
    // 64 is the third group: the first two are skipped.
    h.tap(64)
    expect(h.strip.targets).toEqual([3])
    expect(h.strip.cursor).toBeCloseTo(0.5)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.625)
  })

  it('pause keeps the position and the patience clock stops; Resume continues', async () => {
    const h = harness(melody)
    await follow(h)
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

  it('browsing while playing holds until the release (U95)', async () => {
    const h = harness(melody)
    await follow(h)
    h.session.browseStarted()
    h.frames.flush()
    // Sound holds, the main button still reads Pause.
    expect(h.session.ui.get()).toMatchObject({ playing: true, phase: 'paused', activity: 'playing' })
    await h.session.browseReleased()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ playing: true, phase: 'running' })
  })

  it('a seek while playing keeps playing from the first onset at or after it', async () => {
    const h = harness(melody)
    await follow(h)
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
    await follow(h)
    h.tap(60)
    h.session.setSelection({ multiplier: 0.5 })
    h.step(1000)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    expect(patienceMs(h.session.timeline, 1)).toBe(2000)
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('rewinds when following reaches the end and waits for Start', async () => {
    const h = harness(melody)
    await follow(h)
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
    expect(h.strip.wrappedTo).toBe(0)
    expect(h.strip.cursor).toBe(0)
    expect(h.session.progress.get().position).toBe(0)
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(true)
    expect(h.strip.cursor).toBe(0)
    expect(h.strip.targets).toEqual([0])
  })

  it('the last group waits PATIENCE_LAST_MS after a wrong press', async () => {
    const h = harness(melody)
    await follow(h)
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

  it('leaving for Wait keeps the position, and nothing was recorded', async () => {
    const h = harness(melody)
    await follow(h)
    for (const n of [60, 62, 64]) {
      h.tap(n)
      h.step(1000)
    }
    h.tap(61)
    h.step(2000)
    h.session.setMode('wait')
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

  it('a reading pass before Follow is recorded once; Follow records nothing', async () => {
    const h = harness(melody)
    await h.session.start()
    h.play(60, 62)
    await follow(h)
    h.tap(64)
    h.step(500)
    h.session.setMode('wait')
    h.frames.flush()
    expect(h.attempts.map((a) => [a.kind, a.completion])).toEqual([['reading', 'interrupted']])
    expect(h.attempts[0]!.measures.length).toBeGreaterThan(0)
    expect(h.abandons).toHaveLength(0)
  })

  it('never moves the saved position (U72)', async () => {
    const h = harness(melody, {}, { options: { mode: 'follow' } })
    await h.session.start()
    for (const n of [60, 62, 64]) {
      h.tap(n)
      h.step(1000)
    }
    h.step(6000)
    h.session.seek(1)
    h.session.suspend()
    h.session.pause()
    h.session.seek(0)
    for (const n of [60, 62, 64, 65, 67, 69, 71, 72]) {
      await h.session.start()
      h.tap(n)
      h.step(1100)
    }
    expect(h.session.ui.get().phase).toBe('completed')
    h.session.dispose()
    expect(h.saves).toEqual([])
    expect(h.attempts).toEqual([])
    expect(h.abandons).toEqual([])
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
    await follow(h)
    expect(h.strip.opacity.size).toBe(0)
    h.midi.cc(66, 127, h.clock.now)
    h.frames.flush()
    expect([...h.strip.opacity.keys()].sort((a, b) => a - b)).toEqual([0, 1])
  })

  it('one hand plays the other hand automatically and needs an output', async () => {
    const h = harness(twoHands, { hands: 'right' })
    await follow(h)
    expect(h.session.ui.get().playing).toBe(true)
    h.tap(60)
    h.step(500)
    expect(h.backend.ons().map((c) => c.note)).toContain(48)

    const quiet = harness(twoHands, { hands: 'right' }, { options: { mode: 'follow' } })
    quiet.midi.out = null
    quiet.session.updateSettings(testSettings())
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
    await follow(h)
    h.tap(60, 48)
    h.step(1000)
    expect([...h.strip.targets].sort()).toEqual([2, 3])
    h.session.setSelection({ hands: 'right' })
    await h.session.start()
    h.frames.flush()
    const ui = h.session.ui.get()
    expect(ui.mode).toBe('follow')
    expect(ui.playing).toBe(true)
    // The right hand's note of the same (second) group.
    expect(h.strip.targets).toEqual([2])
    expect(h.strip.cursor).toBeCloseTo(0.25)
  })

  it('a disconnected piano pauses it without an interruption banner', async () => {
    const h = harness(melody)
    await follow(h)
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
