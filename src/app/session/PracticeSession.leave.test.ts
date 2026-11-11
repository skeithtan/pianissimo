/**
 * A reading pass is recorded however it ends (DECISIONS ST2): leaving while it runs, leaving
 * while it is paused or under an overlay, and switching play-through on and off.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { harness, type Harness } from './testkit'

const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
})

/** Reading: two correct notes, then a wrong one in the first bar. */
async function readSome(): Promise<Harness> {
  const h = harness(melody)
  await h.session.start()
  h.play(60, 62)
  h.tap(61)
  h.step(200)
  return h
}

function expectOneReading(h: Harness, completion: 'abandoned' | 'interrupted'): void {
  expect(h.attempts).toHaveLength(1)
  const a = h.attempts[0]!
  expect(a.kind).toBe('reading')
  expect(a.completion).toBe(completion)
  expect(a.wrongAttacks).toBe(1)
  expect(a.measures.length).toBeGreaterThan(0)
}

describe('PracticeSession: leaving records the reading pass', () => {
  it('leaving while reading runs records the pass as abandoned', async () => {
    const h = await readSome()
    h.session.dispose()
    expectOneReading(h, 'abandoned')
  })

  it('leaving a paused pass records it as interrupted, with no abandon event', async () => {
    const h = await readSome()
    h.session.pause()
    h.frames.flush()
    expect(h.attempts).toHaveLength(0)
    const resumes = h.saves.filter((s) => s.patch.resume).length
    h.session.dispose()
    expectOneReading(h, 'interrupted')
    expect(h.abandons).toHaveLength(0)
    // The resume position is saved as before, at the paused note.
    const saved = h.saves.map((s) => s.patch.resume).filter((r) => r)
    expect(saved.length).toBe(resumes + 1)
    expect(saved.at(-1)?.group).toBe(2)
  })

  it('leaving under an overlay (input held) records the pass', async () => {
    const h = await readSome()
    h.session.holdInput(true)
    h.session.dispose()
    expectOneReading(h, 'interrupted')
    expect(h.abandons).toHaveLength(0)
  })

  it('a pass with no press at all records nothing', async () => {
    const h = harness(melody)
    await h.session.start()
    h.step(200)
    h.session.pause()
    h.session.dispose()
    expect(h.attempts).toHaveLength(0)
    const idle = harness(melody)
    idle.session.dispose()
    expect(idle.attempts).toHaveLength(0)
  })

  it('a pass discarded by browsing stays unrecorded when leaving (U41)', async () => {
    const h = await readSome()
    h.session.browseStarted()
    h.session.dispose()
    expect(h.attempts).toHaveLength(0)
  })
})

describe('PracticeSession: play-through keeps the reading before it', () => {
  it('switching play-through on and off records the reading pass once', async () => {
    const h = await readSome()
    h.session.setPlayThrough(true)
    h.session.setPlayThrough(false)
    h.frames.flush()
    expectOneReading(h, 'interrupted')
    h.session.dispose()
    expect(h.attempts).toHaveLength(1)
    expect(h.abandons).toHaveLength(0)
  })

  it('reading, then play-through played: the reading is recorded once and nothing of the play-through', async () => {
    const h = await readSome()
    h.session.setPlayThrough(true)
    await h.session.start()
    h.frames.flush()
    h.tap(64)
    h.step(1000)
    h.tap(66)
    h.step(1000)
    h.session.setPlayThrough(false)
    h.frames.flush()
    h.session.dispose()
    expectOneReading(h, 'interrupted')
    expect(h.abandons).toHaveLength(0)
  })
})
