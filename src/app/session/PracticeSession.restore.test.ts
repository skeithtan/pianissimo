/**
 * Repeat mode survives a reload (DECISIONS U98): the session saves whether Repeat is open with
 * the loop, and a session opened from the stored piece the way `PracticeScreen` does finds Repeat
 * on over the same loop, paused at its start. Without a piano (P22) Repeat is held closed and
 * comes back with the piano; the piece keeps it open meanwhile.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import type { PassageRange } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { type Rational, rat } from '../../core/music/rational'
import type { LadderSettings, ResumePosition } from '../../core/storage/records'
import { harness, testSettings, type Harness } from './testkit'
import type { MicFollowerLike, PiecePatch, SessionDeps } from './types'

/** Three bars of quarters, quarter = 60: note k at k/4. */
const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79].map((midi, at) => ({ at, midi })),
  bars: 3,
})

/** The piece fields Practice opens from (the rest of `PieceRecord` plays no part here). */
interface Stored {
  lastMultiplier: number
  lastHands: HandSelection
  lastPassage: PassageRange | null
  resume: ResumePosition | null
  repeatTarget: number | null
  ladder?: LadderSettings | null
  rhythm?: boolean
  repeatOpen?: boolean
}

const FRESH: Stored = { lastMultiplier: 1, lastHands: 'both', lastPassage: null, resume: null, repeatTarget: null }

/** The stored piece after every save, in order (what IndexedDB holds once the saver has written). */
function stored(saves: readonly { patch: PiecePatch }[], base: Stored = FRESH): Stored {
  let record: Stored = { ...base }
  for (const { patch } of saves) record = { ...record, ...patch }
  return record
}

class QuietMic implements MicFollowerLike {
  async start(_position: Rational): Promise<void> {}
  reset(): void {}
  pause(): void {}
  resume(): void {}
  dispose(): void {}
}

const micDeps: Partial<SessionDeps> = {
  createMicFollower: () => new QuietMic(),
  micSupported: () => true,
}

/** A session opened from `record` the way `PracticeScreen` does without a preset. */
function reopen(record: Stored, deps: Partial<SessionDeps> = {}): Harness {
  const repeat = record.repeatOpen === true && record.lastPassage !== null
  const resume = !repeat ? record.resume : null
  return harness(
    melody as ScoreModel,
    { hands: record.lastHands, range: record.lastPassage, multiplier: record.lastMultiplier },
    {
      settings: testSettings(deps.createMicFollower ? { mic: { follow: false } } : {}),
      options: {
        startPosition: resume?.position ?? null,
        repeatTarget: record.repeatTarget,
        ladder: record.ladder ?? null,
        rhythm: record.rhythm === true,
        repeat,
      },
      deps,
    },
  )
}

const ui = (h: Harness) => h.session.ui.get()

/** Let the music finish the pass and the next one get ready. */
function settle(h: Harness): void {
  for (let t = 0; t < 20000 && h.session.engine.state.phase !== 'ready'; t += 100) h.step(100)
}

const BAR_2: PassageRange = { fromOcc: 1, toOcc: 1 }
const NOTE_LEVEL: PassageRange = { fromOcc: 1, toOcc: 2, start: rat(5, 4), end: rat(5, 2) }

describe('PracticeSession: Repeat mode is saved (U98)', () => {
  it('opening Repeat saves it open at once; closing saves it closed', () => {
    const h = reopen(FRESH)
    h.session.setRepeatMode(true, 1)
    expect(h.saves.at(-1)).toEqual({
      patch: { lastHands: 'both', lastPassage: BAR_2, lastMultiplier: 1, repeatOpen: true },
      immediate: true,
    })
    h.session.setRepeatMode(false)
    expect(h.saves.at(-1)).toMatchObject({ patch: { repeatOpen: false, lastPassage: BAR_2 }, immediate: true })
    // The cursor's repeat button opens it too.
    h.session.repeatFrom(2)
    expect(h.saves.at(-1)).toMatchObject({ patch: { repeatOpen: true, lastPassage: { fromOcc: 2, toOcc: 2 } } })
    expect(h.saves.at(-1)?.immediate).toBe(true)
  })

  it('✕ (the loop cleared) saves no loop and Repeat closed, at once', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true })
    h.session.setSelection({ range: null })
    expect(h.saves.at(-1)).toMatchObject({ patch: { lastPassage: null, repeatOpen: false }, immediate: true })
    // With Repeat already closed, clearing a remembered loop does the same.
    const closed = reopen({ ...FRESH, lastPassage: BAR_2 })
    closed.session.setSelection({ range: null })
    expect(closed.saves.at(-1)).toMatchObject({ patch: { lastPassage: null, repeatOpen: false }, immediate: true })
  })

  it('a loop, hands or speed edit by the learner is written at once', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true })
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    expect(h.saves.at(-1)).toMatchObject({ patch: { lastPassage: { fromOcc: 1, toOcc: 2 } }, immediate: true })
    expect(h.saves.at(-1)?.patch.repeatOpen).toBeUndefined()
    h.session.setSelection({ hands: 'right' })
    expect(h.saves.at(-1)).toEqual({
      patch: { lastHands: 'right', lastPassage: { fromOcc: 1, toOcc: 2 }, lastMultiplier: 1 },
      immediate: true,
    })
    h.session.setSelection({ multiplier: 0.7 })
    expect(h.saves.at(-1)).toMatchObject({ patch: { lastMultiplier: 0.7 }, immediate: true })
  })

  it('the Repeat target and the speed ladder are written at once', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true })
    h.session.setRepeatTarget(4)
    expect(h.saves.at(-1)).toEqual({ patch: { repeatTarget: 4 }, immediate: true })
    h.session.setLadder({ goal: 1, step: 0.1 })
    expect(h.saves.at(-1)).toEqual({ patch: { ladder: { goal: 1, step: 0.1 } }, immediate: true })
  })
})

describe('PracticeSession: a reload keeps Repeat mode (U98)', () => {
  it('reopens Repeat over the same loop, hands, speed, target and ladder, paused at the loop start, without the last result', async () => {
    const first = reopen({ ...FRESH, resume: null })
    first.session.setSelection({ hands: 'right', multiplier: 0.8 })
    first.session.setRepeatMode(true, 1)
    first.session.setRepeatTarget(5)
    first.session.setLadder({ goal: 1, step: 0.05 })
    await first.session.start()
    first.frames.flush()
    first.play(67, 69, 71, 72)
    settle(first)
    expect(first.attempts).toHaveLength(1)
    expect(ui(first).lastResult).not.toBeNull()

    const record = stored(first.saves)
    expect(record).toMatchObject({ repeatOpen: true, lastPassage: BAR_2, lastHands: 'right', lastMultiplier: 0.8 })
    const h = reopen(record)
    expect(ui(h)).toMatchObject({
      repeat: true,
      hands: 'right',
      multiplier: 0.8,
      repeatTarget: 5,
      playing: false,
      lastResult: null,
    })
    expect(ui(h).ladder).toMatchObject({ goal: 1, step: 0.05, start: 0.8, failures: 0 })
    expect(h.session.loop).toEqual(BAR_2)
    expect(h.session.selection.range).toEqual(BAR_2)
    expect(h.session.engine.state.position).toEqual(rat(1))
    expect(h.attempts).toHaveLength(0)
  })

  it('keeps a note-level loop and ignores the stored resume position', () => {
    const first = reopen(FRESH)
    first.session.setRepeatMode(true, 1)
    first.session.setSelection({ range: NOTE_LEVEL })
    const resume: ResumePosition = { occ: 0, position: rat(1, 2), hands: 'both', multiplier: 1, savedAt: 1 }
    const record = { ...stored(first.saves), resume }
    expect(record.lastPassage).toEqual(NOTE_LEVEL)
    const h = reopen(record)
    expect(ui(h).repeat).toBe(true)
    expect(h.session.loop).toEqual(NOTE_LEVEL)
    expect(h.session.engine.state.position).toEqual(rat(5, 4))
    // The resume position is left alone for when Repeat is closed.
    expect(h.saves.some((s) => 'resume' in s.patch)).toBe(false)
  })

  it('a stored loop outside the score is clamped into it', () => {
    const h = reopen({ ...FRESH, lastPassage: { fromOcc: 7, toOcc: 9 }, repeatOpen: true })
    expect(ui(h).repeat).toBe(true)
    const loop = h.session.loop!
    expect(loop.fromOcc).toBeLessThanOrEqual(2)
    expect(loop.toOcc).toBeLessThanOrEqual(2)
  })

  it('Repeat open without a loop, or absent, opens closed from the resume position', () => {
    const resume: ResumePosition = { occ: 1, position: rat(3, 2), hands: 'both', multiplier: 1, savedAt: 1 }
    for (const record of [
      { ...FRESH, repeatOpen: true, resume },
      { ...FRESH, lastPassage: BAR_2, resume },
    ]) {
      const h = reopen(record)
      expect(ui(h).repeat).toBe(false)
      expect(h.session.engine.state.position).toEqual(rat(3, 2))
    }
  })
})

describe('PracticeSession: Repeat waits for the piano (U98, P22)', () => {
  it('no piano at open: play-through, Repeat held (still open on the piece), back with the piano and Keep time', () => {
    const h = reopen({ ...FRESH, lastHands: 'right', lastPassage: BAR_2, repeatOpen: true, rhythm: true }, micDeps)
    expect(ui(h)).toMatchObject({ repeat: true, rhythm: true })
    h.session.setInputAvailable(false)
    expect(ui(h)).toMatchObject({ repeat: false, rhythm: false, playThrough: true })
    expect(h.session.loop).toEqual(BAR_2)
    expect(h.saves.some((s) => s.patch.repeatOpen === false || s.patch.rhythm === false)).toBe(false)
    expect(stored(h.saves, { ...FRESH, repeatOpen: true }).repeatOpen).toBe(true)

    h.session.setInputAvailable(true)
    expect(ui(h)).toMatchObject({ repeat: true, rhythm: true, playThrough: false, playing: false })
    expect(h.session.loop).toEqual(BAR_2)
    expect(h.session.selection.range).toEqual(BAR_2)
    expect(stored(h.saves, { ...FRESH, repeatOpen: true }).repeatOpen).toBe(true)
  })

  it('a piano unplugged mid-session gives Repeat back when it returns', () => {
    const h = reopen({ ...FRESH, lastHands: 'both', lastPassage: BAR_2, repeatOpen: true }, micDeps)
    h.session.setInputAvailable(false)
    expect(ui(h)).toMatchObject({ repeat: false, playThrough: true })
    h.session.setInputAvailable(true)
    expect(ui(h)).toMatchObject({ repeat: true, playThrough: false, playing: false })
    expect(h.session.engine.state.position).toEqual(rat(1))
  })

  it('held, then the learner chooses play-through: it stays at the piano’s return, Repeat closed and saved so', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true }, micDeps)
    h.session.setInputAvailable(false)
    h.session.setPlayThrough(true)
    const saved = h.saves.length
    h.session.setInputAvailable(true)
    expect(ui(h)).toMatchObject({ repeat: false, playThrough: true })
    expect(h.saves.slice(saved)).toContainEqual({ patch: { repeatOpen: false }, immediate: true })
    expect(stored(h.saves, { ...FRESH, repeatOpen: true }).repeatOpen).toBe(false)
  })

  it('the learner’s own play-through with a piano closes Repeat for good', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true }, micDeps)
    h.session.setPlayThrough(true)
    expect(ui(h)).toMatchObject({ repeat: false, playThrough: true })
    expect(h.saves.find((s) => 'repeatOpen' in s.patch)).toMatchObject({
      patch: { repeatOpen: false },
      immediate: true,
    })
    expect(stored(h.saves, { ...FRESH, repeatOpen: true }).repeatOpen).toBe(false)
  })

  it('the loop cleared while held: the piano’s return reopens nothing', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true }, micDeps)
    h.session.setInputAvailable(false)
    h.session.setSelection({ range: null })
    expect(h.saves.at(-1)).toMatchObject({ patch: { lastPassage: null, repeatOpen: false } })
    h.session.setInputAvailable(true)
    expect(ui(h).repeat).toBe(false)
  })

  it('no piano and no microphone: Repeat stays open in Listen', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true }, { micSupported: () => false })
    h.session.setInputAvailable(false)
    expect(ui(h)).toMatchObject({ repeat: true, hands: 'none', playThrough: false })
    expect(h.saves.some((s) => s.patch.repeatOpen === false)).toBe(false)
    h.session.setInputAvailable(true)
    expect(ui(h)).toMatchObject({ repeat: true, hands: 'both' })
  })
})
