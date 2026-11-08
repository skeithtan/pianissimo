/**
 * Study mode (DECISIONS U72): names revealed at the cursor on request, outside any attempt,
 * and a session without the cursor's repeat button.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { REVEAL_FALLBACK_S } from './PracticeSession'
import { harness, testSettings } from './testkit'

const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
})

const chords = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 0, midi: 64 },
    { at: 0, midi: 48, hand: 'L' },
    { at: 1, midi: 62 },
  ],
  bars: 1,
})

const FADE = DEFAULT_SETTINGS.hints.fadeMs

describe('revealAtCursor (Study mode)', () => {
  it('names every note of the group at the cursor, in Listen, with no attempt running', () => {
    const h = harness(chords, { hands: 'none' })
    expect(h.session.ui.get().activity).toBe('idle')
    expect(h.strip.opacity.size).toBe(0)
    expect(h.session.revealAtCursor()).toBe(true)
    expect([...h.strip.opacity.keys()].sort()).toEqual([0, 1, 2])
    for (const v of h.strip.opacity.values()) expect(v).toBe(1)
    expect(h.strip.texts.get(0)).toBe('C4')
    expect(h.strip.texts.get(2)).toBe('C3')
    expect(h.session.ui.get().activity).toBe('idle')
  })

  it('keeps the names for the hint lifetime, then fades them out over fadeMs', () => {
    const settings = testSettings({ hints: { ...DEFAULT_SETTINGS.hints, lifetime: 2 } })
    const h = harness(melody, { hands: 'none' }, { settings })
    h.session.revealAtCursor()
    expect(h.strip.opacity.get(0)).toBe(1)
    h.step(1900)
    expect(h.strip.opacity.get(0)).toBe(1)
    // The session wakes itself at the fade start: no frame has to be requested from outside.
    h.clock.advance(FADE / 2)
    h.frames.flush()
    const mid = h.strip.opacity.get(0) ?? 0
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    h.step(FADE)
    expect(h.strip.opacity.size).toBe(0)
  })

  it('uses a short fixed time when hints are set to last until the correct note', () => {
    const settings = testSettings({ hints: { ...DEFAULT_SETTINGS.hints, lifetime: 'until-correct' } })
    const h = harness(melody, { hands: 'none' }, { settings })
    h.session.revealAtCursor()
    h.step(REVEAL_FALLBACK_S * 1000 - 10)
    expect(h.strip.opacity.get(0)).toBe(1)
    h.step(FADE + 20)
    expect(h.strip.opacity.size).toBe(0)
  })

  it('names the notes under the cursor after a seek, and merges with persistent labels', () => {
    const settings = testSettings({ labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' } })
    const h = harness(melody, { hands: 'none' }, { settings })
    h.session.seek(1)
    h.frames.flush()
    expect(h.session.revealAtCursor()).toBe(true)
    // Every note is labeled persistently; revealing the bar-2 note changes nothing visible.
    expect(h.strip.opacity.size).toBe(8)
    expect(h.strip.opacity.get(4)).toBe(1)
  })

  it('returns false with no note at the cursor', () => {
    const h = harness(buildScore({ notes: [], bars: 1 }), { hands: 'none' })
    expect(h.session.revealAtCursor()).toBe(false)
    expect(h.strip.opacity.size).toBe(0)
  })

  it('a second request restarts the time from the new cursor group', () => {
    const settings = testSettings({ hints: { ...DEFAULT_SETTINGS.hints, lifetime: 1 } })
    const h = harness(melody, { hands: 'none' }, { settings })
    h.session.revealAtCursor()
    h.step(800)
    h.session.seek(1)
    h.session.revealAtCursor()
    expect([...h.strip.opacity.keys()]).toEqual([4])
    h.step(900)
    expect(h.strip.opacity.get(4)).toBe(1)
  })
})

describe('cursorAction option', () => {
  it('never shows the cursor repeat button when false', () => {
    const h = harness(melody, { hands: 'none' }, { options: { cursorAction: false } })
    expect(h.strip.cursorAction).toBe(false)
    h.session.setChromeRevealed(false)
    h.session.setChromeRevealed(true)
    expect(h.strip.cursorAction).toBe(false)
  })

  it('shows it by default outside Repeat mode', () => {
    const h = harness(melody, { hands: 'none' })
    expect(h.strip.cursorAction).toBe(true)
  })
})
