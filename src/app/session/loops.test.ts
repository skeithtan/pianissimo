/**
 * The draggable playhead and note-level Repeat loops in the session (DECISIONS U19, U21–U23).
 */
import { describe, expect, it } from 'vitest'
import { buildScore, quarters } from '../../core/engine/testkit'
import { harness } from './testkit'

/** Two bars of quarters: right hand C D E F | G A B C; left hand C3 half notes in bar 1. */
const piece = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
    { at: 2, midi: 64 },
    { at: 3, midi: 65 },
    { at: 4, midi: 67 },
    { at: 5, midi: 69 },
    { at: 6, midi: 71 },
    { at: 7, midi: 72 },
    { at: 0, dur: 2, midi: 48, hand: 'L' },
    { at: 2, dur: 2, midi: 43, hand: 'L' },
  ],
  bars: 2,
  tempo: { bpm: 60 },
})

describe('PracticeSession: playhead drag (U23)', () => {
  it('gives the strip the hands’ onsets to snap to, rebuilt only when the hands change', () => {
    const h = harness(piece)
    expect(h.strip.snaps).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(quarters))
    const calls = h.strip.snapCalls
    h.session.setSelection({ multiplier: 0.5 })
    h.frames.flush()
    expect(h.strip.snapCalls).toBe(calls)
    h.session.setSelection({ hands: 'left' })
    h.frames.flush()
    expect(h.strip.snaps).toEqual([quarters(0), quarters(2)])
  })

  it('is draggable while nothing plays outside Repeat mode, and continues from the dropped note', async () => {
    const h = harness(piece)
    expect(h.strip.cursorDraggable).toBe(true)
    // Dropped on beat 3 of bar 1 (E4 with the left hand's G2).
    expect(h.session.seekPosition(quarters(2))).toBe(true)
    h.frames.flush()
    expect(h.strip.cursor).toBeCloseTo(0.5)
    expect(h.saves.some((s) => s.immediate && s.patch.resume?.group === 2)).toBe(true)
    await h.session.start()
    h.frames.flush()
    expect(h.strip.cursorDraggable).toBe(false)
    expect(h.strip.targets).toEqual(h.session.timeline.groups[2]!.notes)
    h.tap(64, 43)
    expect(h.session.progress.get().position).toBeCloseTo(0.5)
    h.step(1000)
    expect(h.session.progress.get().position).toBeCloseTo(0.75)
    h.session.pause()
    h.frames.flush()
    expect(h.strip.cursorDraggable).toBe(true)
  })

  it('is not draggable in Repeat mode: every pass starts at the loop start', async () => {
    const h = harness(piece, { range: { fromOcc: 0, toOcc: 0 } })
    expect(h.strip.cursorDraggable).toBe(false)
    await h.session.start()
    h.tap(60, 48)
    h.session.pause()
    h.frames.flush()
    expect(h.strip.cursorDraggable).toBe(false)
    // A seek to the loop start in a scored attempt changes nothing (P6) and says so: the strip
    // puts the cursor back. Anywhere else it is a lead-in from there (U38).
    expect(h.session.seekPosition(quarters(0))).toBe(false)
    expect(h.session.seekPosition(quarters(2))).toBe(true)
    h.frames.flush()
    expect(h.session.ui.get().leadIn).toBe(true)
    expect(h.strip.cursorDraggable).toBe(false)
    // Closing Repeat mode makes it draggable again.
    h.session.setRepeatMode(false)
    h.frames.flush()
    expect(h.strip.cursorDraggable).toBe(true)
  })

  it('Listen continues from the dropped note', async () => {
    const h = harness(piece, { hands: 'none' })
    expect(h.strip.snaps).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(quarters))
    await h.session.start()
    h.step(500)
    h.session.pause()
    h.frames.flush()
    expect(h.strip.cursorDraggable).toBe(true)
    expect(h.session.seekPosition(quarters(5))).toBe(true)
    h.frames.flush()
    expect(h.strip.cursor).toBeCloseTo(1.25)
    await h.session.start()
    h.step(100)
    expect(h.session.progress.get().position).toBeGreaterThanOrEqual(1.25)
  })
})

describe('PracticeSession: note-level Repeat loops (U21)', () => {
  it.each(['pause', 'browse'] as const)('restores loop editing after Listen stops through %s', async (action) => {
    const range = { fromOcc: 0, toOcc: 1 }
    const h = harness(piece, { range, hands: 'none' })
    await h.session.start()
    h.step(500)
    expect(h.strip.loopEditable).toBe(false)
    if (action === 'browse') h.session.browseStarted()
    else h.session.pause()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.strip.loop).toEqual(range)
    expect(h.strip.loopEditable).toBe(true)

    await h.session.start()
    h.frames.flush()
    expect(h.strip.loopEditable).toBe(false)
    h.session.pause()
    h.session.setSelection({ range: null })
    h.frames.flush()
    expect(h.strip.loop).toBeNull()
    expect(h.session.ui.get().repeat).toBe(false)
  })

  it('scores a loop inside one bar and repeats it', async () => {
    const loop = { fromOcc: 0, toOcc: 0, start: quarters(1), end: quarters(3) }
    const h = harness(piece, { range: loop })
    expect(h.session.ui.get()).toMatchObject({ repeat: true, range: loop, startAction: 'scored' })
    expect(h.strip.loop).toEqual(loop)
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    // The loop starts on D4 while the left hand's C3 still sounds: a boundary reattack (both hands).
    expect(h.strip.cursor).toBeCloseTo(0.25)
    h.tap(62, 48)
    h.step(1000)
    h.tap(64, 43)
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ completion: 'completed', groupsTotal: 2, passed: true })
    expect(h.attempts[0]!.context.passage).toEqual(loop)
    expect(h.attempts[0]!.contextKey).toContain('|0-0@1/4..3/4|')
    expect(h.attempts[0]!.measures).toEqual([expect.objectContaining({ occ: 0, complete: false })])
    // Repeat waits for the loop's notated tail before returning to its start.
    h.step(1000)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.cursor).toBeCloseTo(0.25)
    h.tap(62, 48)
    h.step(1000)
    h.tap(64, 43)
    expect(h.attempts).toHaveLength(2)
    expect(h.attempts[1]!.contextKey).toBe(h.attempts[0]!.contextKey)
    expect(h.session.ui.get().lastResult?.streak).toBe(2)
  })

  it('a one-hand note-level loop plays the other hand only inside the loop', async () => {
    const loop = { fromOcc: 0, toOcc: 1, start: quarters(2), end: quarters(5) }
    const h = harness(piece, { hands: 'right', range: loop })
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    h.clock.advance(20)
    // G2 begins exactly at the loop start, with the learner's first press; C3 (before it) is never played.
    expect(h.backend.ons()).toEqual([])
    h.tap(64)
    expect(h.backend.ons().map((c) => c.note)).toEqual([43])
    h.step(1000)
    h.tap(65)
    h.step(1000)
    h.tap(67)
    h.step(1000)
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'completed', groupsTotal: 3 })
    expect(h.attempts[0]!.context.passage).toEqual(loop)
  })

  it('remembers a note-level loop and normalizes edges on barlines to whole bars', () => {
    const h = harness(piece, { range: { fromOcc: 0, toOcc: 0 } })
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 1, start: quarters(1) } })
    h.frames.flush()
    expect(h.saves.at(-1)?.patch.lastPassage).toEqual({ fromOcc: 0, toOcc: 1, start: quarters(1) })
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 1, start: quarters(0), end: quarters(8) } })
    h.frames.flush()
    expect(h.session.ui.get().range).toEqual({ fromOcc: 0, toOcc: 1 })
    // The same loop again changes nothing (exact edges compare by value).
    const saves = h.saves.length
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 1 } })
    expect(h.saves).toHaveLength(saves)
  })
})
