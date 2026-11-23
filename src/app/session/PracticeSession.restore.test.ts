/**
 * A reload restores what was on screen (DECISIONS U98): the session saves the mode, the hands, the
 * speed, the loop and whether Repeat is open, in every mode, and a session opened from the stored
 * piece the way `PracticeScreen` does finds them, paused at the loop start. A piano that is away
 * changes none of it.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import type { PassageRange, PracticeMode } from '../../core/model/practice'
import type { HandSelection, ScoreModel } from '../../core/model/score'
import { rat } from '../../core/music/rational'
import type { LadderSettings, ResumePosition } from '../../core/storage/records'
import { learnerHands, openingMode, type OpeningEnv } from './openingMode'
import { harness, type Harness } from './testkit'
import type { PiecePatch } from './types'

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
  mode?: PracticeMode
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

const PIANO: OpeningEnv = { pianoConnected: true, pianoRemembered: true, midiSupported: true }

/** A session opened from `record` the way `PracticeScreen` does without a preset. */
function reopen(record: Stored, env = PIANO): Harness {
  const repeat = record.repeatOpen === true && record.lastPassage !== null
  const resume = !repeat ? record.resume : null
  return harness(
    melody as ScoreModel,
    { hands: learnerHands(record.lastHands), range: record.lastPassage, multiplier: record.lastMultiplier },
    {
      options: {
        mode: openingMode(record, env),
        startPosition: resume?.position ?? null,
        repeatTarget: record.repeatTarget,
        ladder: record.ladder ?? null,
        repeat,
      },
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

  it('the Repeat target, speed ladder, and its starting speed are written at once', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true })
    h.session.setRepeatTarget(4)
    expect(h.saves.at(-1)).toEqual({ patch: { repeatTarget: 4 }, immediate: true })
    h.session.setLadder({ goal: 1, step: 0.1 })
    expect(h.saves.slice(-2)).toMatchObject([
      { patch: { ladder: { goal: 1, step: 0.1 } }, immediate: true },
      { patch: { lastMultiplier: 0.75 }, immediate: true },
    ])
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
    expect(ui(h)).toMatchObject({ multiplier: 0.8, ladder: { goal: 1, step: 0.05 } })
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

describe('PracticeSession: the mode is the piece’s (U98)', () => {
  it('is saved at once when the learner changes it, and only then', () => {
    const h = reopen(FRESH)
    expect(ui(h).mode).toBe('wait')
    h.session.setInputAvailable(false)
    h.session.setInputAvailable(true)
    h.session.setSelection({ hands: 'right', multiplier: 0.8 })
    h.session.setRepeatMode(true, 1)
    expect(h.saves.some((s) => s.patch.mode !== undefined)).toBe(false)
    h.session.setMode('wait')
    expect(h.saves.some((s) => s.patch.mode !== undefined)).toBe(false)
    h.session.setMode('time')
    expect(h.saves.at(-1)).toEqual({ patch: { mode: 'time', lastHands: 'right' }, immediate: true })
  })

  it.each(['listen', 'wait', 'time', 'follow'] as const)(
    '%s: mode, hands, speed, loop and Repeat reopen as they were, and none of it is saved by opening',
    (mode) => {
      const first = reopen({ ...FRESH, mode: mode === 'wait' ? 'listen' : 'wait' })
      first.session.setMode(mode)
      first.session.setSelection({ hands: 'left' })
      first.session.setSelection({ multiplier: 0.7 })
      if (mode !== 'follow') first.session.setRepeatMode(true, 1)
      const record = stored(first.saves)
      expect(record).toMatchObject({ mode, lastHands: 'left', lastMultiplier: 0.7 })
      const h = reopen(record)
      expect(ui(h)).toMatchObject({
        mode,
        hands: 'left',
        multiplier: 0.7,
        playing: false,
        repeat: mode !== 'follow',
      })
      expect(h.session.loop).toEqual(mode === 'follow' ? null : BAR_2)
      expect(h.saves).toEqual([])
    },
  )

  it('Follow keeps Repeat open on the piece: a reload there, then another mode, has it back', () => {
    const first = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true })
    first.session.setMode('follow')
    const record = stored(first.saves, { ...FRESH, lastPassage: BAR_2, repeatOpen: true })
    expect(record).toMatchObject({ mode: 'follow', repeatOpen: true, lastPassage: BAR_2 })
    const h = reopen(record)
    expect(ui(h)).toMatchObject({ mode: 'follow', repeat: false })
    h.session.setMode('wait')
    expect(ui(h)).toMatchObject({ mode: 'wait', repeat: true, range: BAR_2 })
  })

  it('an older record opens in its mode and hands, and a first change writes the new ones', () => {
    const listened = reopen({ ...FRESH, lastHands: 'none' })
    expect(ui(listened)).toMatchObject({ mode: 'listen', hands: 'both' })
    listened.session.setMode('wait')
    expect(stored(listened.saves, { ...FRESH, lastHands: 'none' })).toMatchObject({ mode: 'wait', lastHands: 'both' })
    const kept = reopen({ ...FRESH, rhythm: true })
    expect(ui(kept).mode).toBe('time')
    expect(kept.saves).toEqual([])
  })
})

describe('PracticeSession: the piano away changes nothing on the piece', () => {
  it.each(['wait', 'time'] as const)('%s at open: blocked, with Repeat, loop and hands as they were', (mode) => {
    const h = reopen({ ...FRESH, mode, lastHands: 'right', lastPassage: BAR_2, repeatOpen: true })
    h.session.setInputAvailable(false)
    expect(ui(h)).toMatchObject({ mode, hands: 'right', repeat: true, range: BAR_2, startEnabled: false })
    expect(h.saves).toEqual([])
    h.session.setInputAvailable(true)
    expect(ui(h)).toMatchObject({ mode, hands: 'right', repeat: true, range: BAR_2, startEnabled: true })
    expect(ui(h).playing).toBe(false)
    expect(h.session.engine.state.position).toEqual(rat(1))
    expect(h.saves).toEqual([])
  })

  it('the learner can change the loop, the hands and Repeat meanwhile', () => {
    const h = reopen({ ...FRESH, lastPassage: BAR_2, repeatOpen: true })
    h.session.setInputAvailable(false)
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 1 } })
    h.frames.flush()
    expect(ui(h)).toMatchObject({ repeat: true, range: { fromOcc: 0, toOcc: 1 } })
    h.session.setSelection({ range: null })
    expect(h.saves.at(-1)).toMatchObject({ patch: { lastPassage: null, repeatOpen: false } })
    h.session.repeatFrom(2)
    h.frames.flush()
    expect(ui(h)).toMatchObject({ repeat: true, range: { fromOcc: 2, toOcc: 2 } })
    h.session.setInputAvailable(true)
    expect(ui(h)).toMatchObject({ repeat: true, range: { fromOcc: 2, toOcc: 2 } })
  })
})
