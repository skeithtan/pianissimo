/**
 * Quiet pencil reminders in PracticeSession (U167): off by default, never shown during a
 * review, handed over as the review ends (first correct note, Keep time count-in, dismiss),
 * levels (`faint` vs `firm`), removed after a clean visit, capped at 24 (`firm` first then score
 * order), never shown in Follow or Listen, never computed inside a MIDI key event, and
 * never counted as assistance.
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { isAssistedAttempt } from '../../core/history'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { harness, testSettings, type Harness } from './testkit'

// Two bars: C D E F | G A B C (8 right-hand quarter notes, quarter = 60 → 1000 ms/beat).
const score = buildScore({
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
const PITCHES = [60, 62, 64, 65, 67, 69, 71, 72] as const
const loop = { fromOcc: 0, toOcc: 1 }

function ready(h: Harness): void {
  for (let k = 0; k < 500 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
  expect(h.session.engine.state.phase).toBe('ready')
}

function playPass(h: Harness, wrong: Partial<Record<number, number[]>> = {}): void {
  ready(h)
  for (let i = 0; i < PITCHES.length; i++) {
    const bad = wrong[i]
    if (bad) {
      h.step(300)
      for (const p of bad) h.tap(p)
      h.step(CHORD_SLIP_MS)
    }
    h.play(PITCHES[i]!)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(PITCHES[i]!)
    }
    h.step(CHORD_SLIP_MS)
  }
  h.step(200)
}

const withReminders = () => testSettings({ hints: { ...DEFAULT_SETTINGS.hints, reminders: true } })

describe('PracticeSession pencil reminders', () => {
  it('stays off by default even after mistakes and review hand-over', async () => {
    const h = harness(score, { range: loop })
    await h.session.start()
    playPass(h, { 2: [63] })
    ready(h)
    // First correct note ends the review (U101).
    h.play(PITCHES[0]!)
    h.step(50)
    expect(h.session.ui.get().reviewing).toBe(false)
    expect(h.strip.reminders).toEqual([])
  })

  it('hides during the review and hands over to faint and firm carets on the first correct note or dismiss', async () => {
    const h = harness(score, { range: loop }, { settings: withReminders() })
    await h.session.start()

    // Pass 1: wrong at group 2 (E4) and group 5 (A4).
    playPass(h, { 2: [63], 5: [68] })
    expect(h.session.ui.get().reviewing).toBe(true)
    expect(h.strip.corrections.length).toBeGreaterThan(0)
    expect(h.strip.reminders).toEqual([])

    // Ready for pass 2: review still shows, carets still hidden.
    ready(h)
    expect(h.session.ui.get().reviewing).toBe(true)
    expect(h.strip.reminders).toEqual([])

    // First correct note of pass 2 ends the review: red marks go and faint carets appear.
    const callsBeforeMidi = h.strip.reminderCalls
    h.midi.on(PITCHES[0]!, h.clock.now)
    h.midi.off(PITCHES[0]!, h.clock.now + 20)
    // Never called inside a MIDI key event.
    expect(h.strip.reminderCalls).toBe(callsBeforeMidi)
    h.frames.flush()
    expect(h.strip.corrections).toEqual([])
    expect(h.strip.reminders).toEqual([
      { notes: [2], level: 'faint' },
      { notes: [5], level: 'faint' },
    ])

    // Mid-pass: playing later notes does not recompute or move the carets.
    const callsMidPass = h.strip.reminderCalls
    h.step(CHORD_SLIP_MS)
    h.play(PITCHES[1]!)
    h.step(CHORD_SLIP_MS)
    expect(h.strip.reminderCalls).toBe(callsMidPass)

    // Finish pass 2: wrong again at group 5 (now firm), clean at group 2 (fixed).
    h.play(PITCHES[2]!)
    h.step(CHORD_SLIP_MS)
    h.play(PITCHES[3]!)
    h.step(CHORD_SLIP_MS)
    h.play(PITCHES[4]!)
    h.step(300)
    h.tap(68)
    h.step(CHORD_SLIP_MS)
    h.play(PITCHES[5]!)
    if (h.session.engine.state.onceMore) {
      h.step(CHORD_SLIP_MS)
      h.play(PITCHES[5]!)
    }
    h.step(CHORD_SLIP_MS)
    h.play(PITCHES[6]!)
    h.step(CHORD_SLIP_MS)
    h.play(PITCHES[7]!)
    h.step(200)

    // Review shows again → carets cleared.
    expect(h.session.ui.get().reviewing).toBe(true)
    expect(h.strip.reminders).toEqual([])

    // Dismissing the result hands over immediately: group 2 is gone, group 5 is firm.
    ready(h)
    h.session.dismissResult()
    h.frames.flush()
    expect(h.strip.reminders).toEqual([{ notes: [5], level: 'firm' }])

    // Pass 3: clean everywhere → reminders do not count as assistance, and group 5 is gone next pass.
    for (let i = 0; i < PITCHES.length; i++) {
      h.play(PITCHES[i]!)
      h.step(CHORD_SLIP_MS)
    }
    h.step(200)
    const clean = h.attempts.at(-1)!
    expect(clean.passed).toBe(true)
    expect(isAssistedAttempt(clean)).toBe(false)

    ready(h)
    h.session.dismissResult()
    h.frames.flush()
    expect(h.strip.reminders).toEqual([])
  })

  it('hands over at the Keep time downbeat after the count-in clears corrections', async () => {
    const h = harness(
      score,
      { range: { fromOcc: 0, toOcc: 0 } },
      { settings: withReminders(), options: { mode: 'time' } },
    )
    await h.session.start()

    // Count-in is 4 beats (4000 ms). Play group 0 on beat 1, miss the rest (wrong/missed).
    h.step(4000)
    h.play(60)
    h.step(4500)
    expect(h.attempts).toHaveLength(1)
    expect(h.strip.corrections.length).toBeGreaterThan(0)
    expect(h.strip.reminders).toEqual([])

    // Repeat starts next count-in; red marks stay until downbeat, so carets wait until downbeat.
    while (h.session.ui.get().countIn === null) h.step(50)
    expect(h.strip.reminders).toEqual([])
    while (h.session.ui.get().countIn !== null) h.step(50)
    h.frames.flush()
    expect(h.strip.corrections).toEqual([])
    expect(h.strip.reminders.length).toBeGreaterThan(0)
    expect(h.strip.reminders.every((m) => m.level === 'faint')).toBe(true)
  })

  it('caps at 24 marks with firm spots first, then score order', async () => {
    // 30 quarter notes across 8 bars (1–30).
    const notes = Array.from({ length: 30 }, (_, i) => ({ at: i, midi: 60 + (i % 12) }))
    const longScore = buildScore({ notes, bars: 8, tempo: { bpm: 120 } })
    const h = harness(longScore, { range: { fromOcc: 0, toOcc: 7 } }, { settings: withReminders() })
    await h.session.start()

    const runLong = (wrongGroups: ReadonlySet<number>) => {
      ready(h)
      for (let i = 0; i < 30; i++) {
        const expected = notes[i]!.midi
        if (wrongGroups.has(i)) {
          h.step(300)
          h.tap(expected === 60 ? 61 : 60)
          h.step(CHORD_SLIP_MS)
        }
        h.play(expected)
        if (h.session.engine.state.onceMore) {
          h.step(CHORD_SLIP_MS)
          h.play(expected)
        }
        h.step(CHORD_SLIP_MS)
      }
      h.step(200)
    }

    // Pass 1: wrong at groups 25, 27, 29.
    runLong(new Set([25, 27, 29]))
    // Pass 2: wrong at groups 1..29 (group 0 starts the pass from Ready) -> 25, 27, 29 are firm; 1..24, 26, 28 are faint (29 total).
    runLong(new Set(Array.from({ length: 29 }, (_, i) => i + 1)))
    ready(h)
    h.session.dismissResult()
    h.frames.flush()

    expect(h.strip.reminders).toHaveLength(24)
    expect(h.strip.reminders.slice(0, 3)).toEqual([
      { notes: [25], level: 'firm' },
      { notes: [27], level: 'firm' },
      { notes: [29], level: 'firm' },
    ])
    // Remaining 21 slots are faint in score order: 1..21.
    expect(h.strip.reminders.slice(3)).toEqual(
      Array.from({ length: 21 }, (_, i) => ({ notes: [i + 1], level: 'faint' as const })),
    )
  })

  it('clears reminders in Listen and Follow and responds to live settings toggles', async () => {
    const h = harness(score, { range: loop }, { settings: withReminders() })
    await h.session.start()
    playPass(h, { 2: [63] })
    ready(h)
    h.session.dismissResult()
    h.frames.flush()
    expect(h.strip.reminders).toEqual([{ notes: [2], level: 'faint' }])

    // Toggling the setting off clears immediately on the next frame; turning it back on restores them.
    h.session.updateSettings(testSettings({ hints: { ...DEFAULT_SETTINGS.hints, reminders: false } }))
    h.frames.flush()
    expect(h.strip.reminders).toEqual([])
    h.session.updateSettings(withReminders())
    h.frames.flush()
    expect(h.strip.reminders).toEqual([{ notes: [2], level: 'faint' }])

    // Listen clears reminders.
    h.session.setMode('listen')
    h.frames.flush()
    expect(h.strip.reminders).toEqual([])

    // Back to Wait in Repeat, then Follow clears reminders.
    h.session.setMode('wait')
    await h.session.start()
    h.frames.flush()
    expect(h.strip.reminders).toEqual([{ notes: [2], level: 'faint' }])

    h.session.setMode('follow')
    h.frames.flush()
    expect(h.strip.reminders).toEqual([])
  })
})
