/**
 * The result after every run (DECISIONS U142): a Wait run outside Repeat that reaches the end of the
 * piece, through whatever it went; Again and the Loop button, from Wait and from Keep time; nothing in
 * Repeat, Listen or Follow.
 */
import { describe, expect, it, vi } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import type { PassageRange } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import { rat } from '../../core/music/rational'
import type { BrowserAudioModule, MetronomeModule } from '../../core/playback'
import { RecordingBackend } from '../../core/playback/testkit'
import { rankMistakes } from './ranking'
import { FakeStrip, harness as baseHarness, testSettings, type Harness } from './testkit'

const BARS = 10
const SCALE = [60, 62, 64, 65, 67, 69, 71, 72]
/** Two half notes a bar at ♩ = 60: group g is in bar g >> 1. */
const pitch = (group: number) => SCALE[group % SCALE.length]!
const LAST = BARS * 2 - 1
const piece = buildScore({
  notes: Array.from({ length: BARS * 2 }, (_, i) => ({ at: i * 2, dur: 2, midi: pitch(i) })),
  bars: BARS,
})
/** The same, with a left hand that plays on after the right hand's last note. */
const withLeft = buildScore({
  notes: [
    ...Array.from({ length: BARS * 2 - 1 }, (_, i) => ({ at: i * 2, dur: 2, midi: pitch(i) })),
    ...Array.from({ length: BARS * 2 }, (_, i) => ({ at: i * 2, dur: 2, midi: pitch(i) - 24, hand: 'L' as const })),
  ],
  bars: BARS,
})
/** A key nowhere near a written one. */
const WRONG = 30

class Strip extends FakeStrip {
  browsing = false
  at: ReturnType<typeof rat> | null = null
  override isBrowsing(): boolean {
    return this.browsing
  }
  browsedPosition(): ReturnType<typeof rat> | null {
    return this.browsing ? this.at : null
  }
  returnToCurrent(): void {
    this.browsing = false
  }
}

type RunHarness = Omit<Harness, 'strip'> & { strip: Strip }

function open(
  model: ScoreModel = piece,
  ...rest: Parameters<typeof baseHarness> extends [unknown, ...infer R] ? R : never
): RunHarness {
  const h = baseHarness(model, ...rest)
  const strip = new Strip()
  h.session.attachStrip(strip)
  return { ...h, strip }
}

async function start(h: RunHarness): Promise<void> {
  await h.session.start()
  h.frames.flush()
}

/** Plays groups `from`–`to`, with wrong keys (well after the note before) at the given groups. */
function read(h: RunHarness, from: number, to: number, wrong: Record<number, number[]> = {}): void {
  for (let g = from; g <= to; g++) {
    for (const key of wrong[g] ?? []) {
      h.step(200)
      h.tap(key)
    }
    h.play(pitch(g))
  }
}

const ui = (h: RunHarness) => h.session.ui.get()
const result = (h: RunHarness) => ui(h).lastResult
const groupNow = (h: RunHarness) => h.session.engine.state.groupIndex
/** Runs the tail out and lets the piece rewind. */
const tail = (h: RunHarness) => h.step(5000)

describe('a Wait run that reaches the end of the piece (U142)', () => {
  it('clean: the result of a clean pass, without time, streak or Loop, and nothing new stored', async () => {
    const h = open()
    await start(h)
    read(h, 0, LAST)
    expect(result(h)).toMatchObject({
      run: true,
      passed: true,
      wrongAttacks: 0,
      groupsFirstPass: BARS * 2,
      groupsTotal: BARS * 2,
      completionTimeSec: null,
      expectedTimeSec: null,
      streak: 0,
      targetReached: false,
    })
    expect(result(h)).not.toHaveProperty('rough')
    expect(result(h)).not.toHaveProperty('timing')
    expect(ui(h).corrections).toBe(0)
    // The history gets the one traversal it always did.
    expect(h.attempts).toMatchObject([{ kind: 'reading', completion: 'completed' }])
    expect(result(h)!.id).not.toBe(h.attempts[0]!.id)
    // The whole piece is not framed by a review: there is no loop.
    expect(ui(h).reviewing).toBe(false)
    expect(h.strip.reviews).not.toContain(true)
  })

  it('with mistakes: the wrong notes, the marks, the places and the rough bars', async () => {
    const h = open()
    await start(h)
    read(h, 0, LAST, { 8: [WRONG], 9: [WRONG, WRONG + 1], 16: [WRONG] })
    expect(result(h)).toMatchObject({ run: true, passed: false, wrongAttacks: 4, groupsFirstPass: 17, groupsTotal: 20 })
    // Bars 5 (groups 8 and 9) with a context bar on each side.
    expect(result(h)!.rough).toEqual({ fromOcc: 3, toOcc: 5 })
    expect(h.strip.corrections.map((m) => m.notes)).toEqual([[8], [9], [16]])
    expect(ui(h).corrections).toBe(3)
    const details = h.session.resultDetails()!
    expect(details.attemptId).toBe(result(h)!.id)
    expect(rankMistakes(details.records, details.timeline, piece, details.marks).map((m) => [m.bar, m.level])).toEqual([
      ['5', 'extra'],
      ['5', 'extra'],
      ['9', 'extra'],
    ])
  })

  it('a pause in the middle changes nothing, and is no lateness at the note it stopped at', async () => {
    const h = open()
    await start(h)
    read(h, 0, 7)
    h.step(2100) // the music has reached group 8 and waits there
    h.session.pause()
    h.frames.flush()
    h.step(60_000)
    await start(h)
    h.step(100)
    read(h, 8, LAST)
    expect(result(h)).toMatchObject({ passed: true, groupsTotal: 20 })
    expect(ui(h).corrections).toBe(0)
    expect(h.attempts).toHaveLength(1)
  })

  it('jumping back to the start and playing on reports the last time through', async () => {
    const h = open()
    await start(h)
    read(h, 0, 7, { 3: [WRONG], 5: [WRONG] })
    h.session.seek(0)
    h.frames.flush()
    read(h, 0, LAST, { 10: [WRONG] })
    expect(result(h)).toMatchObject({ wrongAttacks: 1, groupsFirstPass: 19, groupsTotal: 20 })
    expect(h.strip.corrections.map((m) => m.notes)).toEqual([[10]])
    // Both traversals reached the history, as before.
    expect(h.attempts.map((a) => a.completion)).toEqual(['interrupted', 'completed'])
  })

  it('jumping ahead keeps the earlier bars and counts only what was played', async () => {
    const h = open()
    await start(h)
    read(h, 0, 3, { 2: [WRONG] })
    h.session.seek(7)
    h.frames.flush()
    read(h, 14, LAST)
    expect(result(h)).toMatchObject({ wrongAttacks: 1, groupsFirstPass: 9, groupsTotal: 10 })
    expect(result(h)!.rough).toEqual({ fromOcc: 0, toOcc: 2 })
  })

  it('browsing in the middle keeps what was read before it, though the history drops that pass (U41)', async () => {
    const h = open()
    await start(h)
    read(h, 0, 5, { 1: [WRONG] })
    h.session.browseStarted()
    h.strip.browsing = true
    h.strip.at = rat(3)
    expect(h.attempts).toHaveLength(0)
    await h.session.browseReleased()
    h.frames.flush()
    expect(groupNow(h)).toBe(6)
    read(h, 6, LAST)
    expect(result(h)).toMatchObject({ wrongAttacks: 1, groupsTotal: 20 })
    expect(h.attempts.map((a) => a.completion)).toEqual(['completed'])
  })

  it('a speed change keeps the target and its progress: a chord half played across it', async () => {
    const chords = buildScore({
      notes: [
        { at: 0, dur: 4, midi: 60 },
        { at: 4, dur: 4, midi: 62 },
        { at: 4, dur: 4, midi: 65 },
        { at: 8, dur: 4, midi: 64 },
        { at: 12, dur: 4, midi: 67 },
      ],
      bars: 4,
    })
    const h = open(chords)
    await start(h)
    h.play(60)
    h.step(4200)
    h.tap(WRONG)
    h.tap(62) // half of bar 2's chord
    h.session.setSelection({ multiplier: 0.5 })
    h.session.setSelection({ multiplier: 0.75 }) // a traversal nothing was pressed in
    h.frames.flush()
    h.tap(WRONG + 1)
    h.tap(65)
    h.play(64, 67)
    expect(result(h)).toMatchObject({ wrongAttacks: 2, groupsFirstPass: 3, groupsTotal: 4 })
    expect(h.session.resultDetails()!.records.at(-1)!.groups![1]).toMatchObject({
      wrongAttacks: 2,
      wrongPitches: [WRONG, WRONG + 1],
    })
    expect(h.attempts.map((a) => [a.interruptReason, a.context.multiplier])).toEqual([
      ['tempo-change', 1],
      [undefined, 0.75],
    ])
  })

  it('from a resume position: only what was read, and Again starts there', async () => {
    const h = open(piece, {}, { options: { startPosition: rat(6) } })
    await start(h)
    read(h, 12, LAST, { 13: [WRONG] })
    expect(result(h)).toMatchObject({ wrongAttacks: 1, groupsTotal: 8 })
    tail(h)
    expect(h.session.progress.get().position).toBe(0)
    await h.session.again()
    h.frames.flush()
    expect(groupNow(h)).toBe(12)
    expect(h.strip.cursor).toBe(6)
    expect(result(h)).toBeNull()
    read(h, 12, LAST)
    expect(result(h)).toMatchObject({ passed: true, groupsTotal: 8 })
  })

  it('from the visible cursor', async () => {
    const h = open()
    h.strip.browsing = true
    h.strip.at = rat(8)
    await start(h)
    expect(groupNow(h)).toBe(16)
    read(h, 16, LAST)
    expect(result(h)).toMatchObject({ passed: true, groupsTotal: 4 })
  })

  it('a piano unplugged and back: the run goes on from where it stopped', async () => {
    const h = open()
    await start(h)
    read(h, 0, 7, { 2: [WRONG] })
    h.midi.route({ kind: 'input-disconnected' } as Parameters<typeof h.midi.route>[0])
    h.session.setInputAvailable(false)
    h.frames.flush()
    expect(result(h)).toBeNull()
    h.step(10_000)
    h.midi.route({ kind: 'input-reconnected' } as Parameters<typeof h.midi.route>[0])
    h.session.setInputAvailable(true)
    await start(h)
    expect(groupNow(h)).toBe(8)
    read(h, 8, LAST)
    expect(result(h)).toMatchObject({ wrongAttacks: 1, groupsTotal: 20 })
    expect(h.attempts.map((a) => a.interruptReason)).toEqual(['disconnect', undefined])
  })

  it('a label change goes on with the run', async () => {
    const h = open()
    await start(h)
    read(h, 0, 5)
    const labels = { ...testSettings().labels, mode: 'conditional' as const }
    h.session.beforeApplyLabels(labels)
    h.session.updateSettings(testSettings({ labels }))
    h.frames.flush()
    read(h, 6, LAST)
    expect(result(h)).toMatchObject({ groupsTotal: 20 })
  })

  it('help does not keep the run from being clean (U144)', async () => {
    const h = open()
    await start(h)
    read(h, 0, 3)
    h.session.requestHint()
    read(h, 4, LAST)
    expect(result(h)).toMatchObject({ passed: true, wrongAttacks: 0 })
    expect(result(h)).not.toHaveProperty('rough')
  })

  it('a key pressed with the piece’s last note is one of the run’s (P24)', async () => {
    const h = open(piece, {}, { deps: { finalSlipMs: CHORD_SLIP_MS } })
    await start(h)
    read(h, 0, LAST)
    expect(result(h)).toBeNull()
    h.step(20)
    h.tap(WRONG)
    h.step(CHORD_SLIP_MS)
    expect(result(h)).toMatchObject({ wrongAttacks: 1, groupsFirstPass: 19 })
  })

  it('a run whose last chord is still held open ends before a pause, a jump, browsing or Restart', async () => {
    const acts: Record<string, (h: RunHarness) => void> = {
      pause: (h) => h.session.pause(),
      jump: (h) => h.session.seek(2),
      speed: (h) => h.session.setSelection({ multiplier: 0.9 }),
      unplugged: (h) => h.session.setInputAvailable(false),
      restart: (h) => h.session.restart(),
      browse: (h) => {
        h.session.browseStarted()
        h.strip.browsing = true
        h.strip.at = rat(3)
      },
    }
    for (const [name, act] of Object.entries(acts)) {
      const h = open(piece, {}, { deps: { finalSlipMs: CHORD_SLIP_MS } })
      await start(h)
      read(h, 0, 9, { 2: [WRONG] })
      h.session.seek(5)
      h.frames.flush()
      read(h, 10, LAST)
      expect(result(h), name).toBeNull()
      act(h)
      h.frames.flush()
      expect(h.attempts.at(-1), name).toMatchObject({ kind: 'reading', completion: 'completed' })
      // A speed change ends any result at once; every other way it shows.
      if (name === 'speed') expect(h.session.engine.state.phase).toBe('completed')
      else expect(result(h), name).toMatchObject({ run: true, wrongAttacks: 1, groupsTotal: 20 })
      if (name === 'browse') {
        // It had ended: letting go of the score starts nothing.
        await h.session.browseReleased()
        h.frames.flush()
        expect(ui(h).playing).toBe(false)
      }
    }
  })

  it('one hand: the result shows at its last note, while the other hand plays the tail', async () => {
    const h = open(withLeft, { hands: 'right' })
    await start(h)
    read(h, 0, LAST - 1, { 4: [WRONG] })
    expect(result(h)).toMatchObject({ run: true, wrongAttacks: 1, groupsTotal: 19 })
    const before = h.backend.ons().length
    h.step(2500)
    expect(h.backend.ons().length).toBeGreaterThan(before)
    expect(h.strip.wrappedTo).toBeNull()
    tail(h)
    // The piece rewinds (U126); the pill and the marks stay, and nothing plays.
    expect(h.strip.wrappedTo).toBe(0)
    expect(h.session.progress.get()).toEqual({ position: 0, occ: 0 })
    expect(ui(h)).toMatchObject({ playing: false, phase: 'completed', corrections: 1 })
    expect(result(h)).toMatchObject({ wrongAttacks: 1 })
  })

  it('opening its details ends the tail, so its bars can be heard', async () => {
    const h = open(withLeft, { hands: 'right' })
    await start(h)
    read(h, 0, LAST - 1, { 4: [WRONG] })
    const { id } = result(h)!
    expect(h.session.snippetBlocked(id, 2, 'played')).toBe('Plays once the music stops.')
    h.session.openResultDetails(id)
    h.frames.flush()
    expect(h.strip.wrappedTo).toBe(0)
    expect(h.session.progress.get().position).toBe(0)
    expect(result(h)?.id).toBe(id)
    expect(h.session.snippetBlocked(id, 2, 'played')).toBeNull()
  })

  it('the same wrong key in three runs running is named (P24)', async () => {
    const h = open()
    for (let i = 0; i < 3; i++) {
      await start(h)
      read(h, 0, LAST, { 6: [WRONG] })
      tail(h)
    }
    expect(result(h)!.repeatedMistakes).toMatchObject([{ group: 6, bar: '4', wrongPitch: WRONG, passes: 3 }])
    expect(h.session.resultDetails()!.records.map((r) => r.kind)).toEqual(['run', 'run', 'run'])
  })
})

describe('what ends a Wait run without a result', () => {
  it('other hands drop it; reading that goes on is a run of its own', async () => {
    const h = open(withLeft, { hands: 'right' })
    await start(h)
    // Some of it already folded in, the rest still being read.
    read(h, 0, 5, { 2: [WRONG] })
    h.session.seek(3)
    h.frames.flush()
    read(h, 6, 7, { 7: [WRONG] })
    h.session.setSelection({ hands: 'both' })
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('running')
    for (let g = groupNow(h)!; g <= LAST; g++) h.play(pitch(g) - 24, ...(g < LAST ? [pitch(g)] : []))
    expect(result(h)).toMatchObject({ run: true, wrongAttacks: 0, groupsTotal: 12 })
  })

  it('another mode, Repeat, Restart: the next run starts from nothing', async () => {
    const drops: Record<string, (h: RunHarness) => void> = {
      mode: (h) => {
        h.session.setMode('listen')
        h.session.setMode('wait')
      },
      repeat: (h) => {
        h.session.repeatAtCursor()
        h.session.setSelection({ range: null })
      },
      restart: (h) => h.session.restart(),
    }
    for (const [name, drop] of Object.entries(drops)) {
      const h = open()
      await start(h)
      read(h, 0, 5, { 2: [WRONG] })
      h.session.seek(3)
      h.frames.flush()
      read(h, 6, 7, { 7: [WRONG] })
      drop(h)
      h.frames.flush()
      if (!ui(h).playing) await start(h)
      h.session.seek(8)
      h.frames.flush()
      read(h, 16, LAST)
      expect(result(h), name).toMatchObject({ run: true, wrongAttacks: 0, groupsTotal: 4 })
    }
  })

  it('Listen and Follow show none; a lead-in is read for nothing', async () => {
    const h = open()
    h.session.setMode('follow')
    await start(h)
    for (let g = 0; g <= LAST; g++) {
      h.step(2000)
      h.tap(pitch(g))
    }
    tail(h)
    expect(result(h)).toBeNull()
    h.session.setMode('listen')
    await start(h)
    h.step(60_000)
    expect(result(h)).toBeNull()
    expect(h.attempts).toHaveLength(0)

    const loop = open(piece, { range: { fromOcc: 8, toOcc: 9 } })
    loop.session.seek(6)
    await start(loop)
    read(loop, 12, 15, { 13: [WRONG] })
    expect(loop.attempts).toHaveLength(0)
    expect(result(loop)).toBeNull()
  })
})

describe('the result of a Wait run while the learner goes on', () => {
  async function finished(wrong: Record<number, number[]> = { 8: [WRONG] }): Promise<RunHarness> {
    const h = open()
    await start(h)
    read(h, 0, LAST, wrong)
    tail(h)
    expect(result(h)).not.toBeNull()
    return h
  }

  it('Start clears the marks; wrong keys keep the pill; the first correct note dims it; leaving that bar ends it (U101)', async () => {
    const h = await finished()
    const id = result(h)!.id
    await start(h)
    expect(ui(h)).toMatchObject({ playing: true, corrections: 0, resultDimmed: false })
    h.tap(WRONG)
    expect(result(h)?.id).toBe(id)
    expect(ui(h).resultDimmed).toBe(false)
    h.play(pitch(0))
    expect(ui(h)).toMatchObject({ lastResult: { id }, resultDimmed: true })
    h.play(pitch(1))
    h.frames.flush()
    expect(ui(h)).toMatchObject({ lastResult: null, resultExit: 'played', resultDimmed: false })
    // The run that ended the pill shows its own.
    read(h, 2, LAST)
    expect(result(h)).toMatchObject({ run: true, groupsTotal: 20, wrongAttacks: 1 })
    expect(result(h)!.id).not.toBe(id)
  })

  it('Hide, other hands and another mode end it; a seek only clears the marks', async () => {
    const hide = await finished()
    hide.session.dismissResult()
    expect(ui(hide)).toMatchObject({ lastResult: null, resultExit: 'dismissed', corrections: 0 })

    const hands = await finished()
    hands.session.setSelection({ hands: 'right' })
    hands.frames.flush()
    expect(result(hands)).toBeNull()

    const mode = await finished()
    mode.session.setMode('time')
    expect(result(mode)).toBeNull()

    const seek = await finished()
    seek.session.seek(4)
    seek.frames.flush()
    expect(result(seek)).not.toBeNull()
    expect(ui(seek).corrections).toBe(0)
  })

  it('a rotation keeps the pill and gives the new view its marks', async () => {
    const h = await finished()
    const id = result(h)!.id
    h.session.layoutChanging()
    const page = new Strip()
    h.session.attachStrip(page)
    h.frames.flush()
    expect(result(h)?.id).toBe(id)
    expect(page.corrections).toHaveLength(1)
  })

  it('Again replays from where the run started, whatever was done since', async () => {
    const h = await finished()
    h.session.seek(6)
    h.strip.browsing = true
    h.strip.at = rat(9)
    await h.session.again()
    h.frames.flush()
    expect(groupNow(h)).toBe(0)
    expect(h.strip.browsing).toBe(false)
    expect(result(h)).toBeNull()
    read(h, 0, LAST)
    expect(result(h)).toMatchObject({ passed: true, groupsTotal: 20 })
  })

  it('Again during the next run abandons that reading; its bars are not the new run’s', async () => {
    const h = await finished()
    const before = h.attempts.length
    await start(h)
    h.step(200)
    h.tap(WRONG)
    expect(result(h)).not.toBeNull()
    await h.session.again()
    h.frames.flush()
    expect(h.attempts.slice(before)).toMatchObject([{ completion: 'abandoned', interruptReason: 'user-restart' }])
    expect(h.abandons).toHaveLength(1)
    read(h, 0, LAST)
    expect(result(h)).toMatchObject({ passed: true, wrongAttacks: 0 })
  })

  it('Again drops what the next run had already been through', async () => {
    const h = open(piece, {}, { options: { startPosition: rat(6) } })
    await start(h)
    read(h, 12, LAST, { 13: [WRONG] })
    tail(h)
    // The next run reads the first note wrong and jumps back within its bar: the pill still shows.
    await start(h)
    read(h, 0, 0, { 0: [WRONG] })
    h.session.seek(0)
    h.frames.flush()
    expect(ui(h).resultDimmed).toBe(true)
    await h.session.again()
    h.frames.flush()
    expect(groupNow(h)).toBe(12)
    read(h, 12, LAST)
    expect(result(h)).toMatchObject({ passed: true, wrongAttacks: 0, groupsTotal: 8 })
  })

  it('Again while the tail still plays starts over at once', async () => {
    const h = open(withLeft, { hands: 'right' })
    await start(h)
    read(h, 0, LAST - 1, { 2: [WRONG] })
    h.step(500)
    await h.session.again()
    h.frames.flush()
    expect(groupNow(h)).toBe(0)
    expect(h.strip.cursor).toBe(0)
    h.step(30_000)
    // Waiting at the first note: the old tail's end rewinds nothing.
    expect(h.strip.wrappedTo).toBeNull()
  })

  it('the interruption’s Restart is still the piece’s start, not the finished run’s', async () => {
    const h = open(piece, {}, { options: { startPosition: rat(6) } })
    await start(h)
    read(h, 12, LAST)
    tail(h)
    await start(h)
    h.midi.route({ kind: 'input-disconnected' } as Parameters<typeof h.midi.route>[0])
    h.midi.route({ kind: 'input-reconnected' } as Parameters<typeof h.midi.route>[0])
    h.session.restart()
    h.frames.flush()
    expect(groupNow(h)).toBe(0)
  })
})

describe('the Loop button (U142)', () => {
  const rough: PassageRange = { fromOcc: 3, toOcc: 5 }

  async function waitRun(): Promise<RunHarness> {
    const h = open()
    await start(h)
    read(h, 0, LAST, { 8: [WRONG], 9: [WRONG] })
    expect(result(h)!.rough).toEqual(rough)
    return h
  }

  function pausedOver(h: RunHarness, mode: 'wait' | 'time'): void {
    h.frames.flush()
    expect(ui(h)).toMatchObject({ mode, repeat: true, range: rough, playing: false, countIn: null, lastResult: null })
    expect(ui(h)).toMatchObject({ leadIn: false, startAction: 'scored', corrections: 0 })
    expect(h.strip.loop).toEqual(rough)
    expect(h.session.progress.get()).toEqual({ position: 3, occ: 3 })
    expect(h.strip.cursor).toBe(3)
    expect(h.saves.map((s) => s.patch).at(-1)).toMatchObject({ lastPassage: rough, repeatOpen: true })
  }

  it('from Wait: Repeat over the rough bars, paused at their start', async () => {
    const h = await waitRun()
    tail(h)
    const stored = h.attempts.length
    h.session.loopRoughBars()
    pausedOver(h, 'wait')
    h.step(10_000)
    expect(ui(h).playing).toBe(false)
    expect(h.attempts).toHaveLength(stored)
    // Start is then a pass over them, as after any loop.
    await start(h)
    for (let k = 0; k < 100 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
    read(h, 6, 11, { 7: [WRONG] })
    expect(result(h)).toMatchObject({ passed: false, wrongAttacks: 1, groupsTotal: 6, streak: 0 })
    expect(result(h)).not.toHaveProperty('run')
    expect(result(h)).not.toHaveProperty('rough')
  })

  it('while the tail plays, while browsing, and while the next run is on', async () => {
    const inTail = await waitRun()
    inTail.session.loopRoughBars()
    pausedOver(inTail, 'wait')

    const browsing = await waitRun()
    tail(browsing)
    browsing.strip.browsing = true
    browsing.strip.at = rat(7)
    browsing.session.loopRoughBars()
    expect(browsing.strip.browsing).toBe(false)
    pausedOver(browsing, 'wait')

    const playing = await waitRun()
    tail(playing)
    await start(playing)
    playing.play(pitch(0))
    expect(ui(playing).resultDimmed).toBe(true)
    playing.session.loopRoughBars()
    pausedOver(playing, 'wait')
  })

  it('a Start still loading sounds is canceled: it starts nothing', async () => {
    const backend = Object.assign(new RecordingBackend(() => 0), { monitor: vi.fn(), dispose: vi.fn() })
    let loaded!: (m: BrowserAudioModule) => void
    const h = open(
      withLeft,
      { hands: 'right' },
      {
        deps: { loadBrowserAudio: () => new Promise<BrowserAudioModule>((r) => (loaded = r)), hasWebAudio: () => true },
      },
    )
    await start(h)
    read(h, 0, LAST - 1, { 8: [WRONG], 9: [WRONG] })
    tail(h)
    // The piano's output goes: the next Start loads this device's sound.
    h.midi.out = null
    h.midi.route({ kind: 'output-disconnected' } as Parameters<typeof h.midi.route>[0])
    const starting = h.session.start()
    h.session.loopRoughBars()
    loaded({ createBrowserAudio: () => backend } as unknown as BrowserAudioModule)
    await starting
    h.step(5000)
    expect(ui(h)).toMatchObject({ repeat: true, playing: false })
  })

  it('from Keep time: the bars with wrong or missed groups, in the same mode; never for timing alone', async () => {
    class WebAudioMetronome {
      click(): void {}
      cancel(): void {}
      setVolume(): void {}
      setContext(): void {}
    }
    const keepTime = () =>
      open(
        piece,
        {},
        {
          options: { mode: 'time' },
          deps: { loadMetronome: async () => ({ WebAudioMetronome }) as unknown as MetronomeModule },
        },
      )
    /** Count-in, then every group on its beat moved by `offset(g)` ms; null is not played. */
    async function play(h: RunHarness, offset: (group: number) => number | null): Promise<void> {
      await start(h)
      const downbeat = h.clock.now + 4000
      for (let g = 0; g <= LAST; g++) {
        const ms = offset(g)
        if (ms === null) continue
        h.clock.advanceTo(downbeat + g * 2000 + ms)
        h.frames.flush()
        h.tap(pitch(g))
      }
      h.step(5000)
    }

    const missed = keepTime()
    await play(missed, (g) => (g === 8 || g === 9 ? (g === 8 ? null : 0) : 0))
    expect(result(missed)).toMatchObject({ passed: false, timing: { missed: 1 } })
    expect(result(missed)).not.toHaveProperty('run')
    expect(result(missed)!.rough).toEqual(rough)
    missed.session.loopRoughBars()
    pausedOver(missed, 'time')

    const late = keepTime()
    // The second note of bar 5 late, but played before the window closed: timing, no wrong note.
    await play(late, (g) => (g === 9 ? 140 : 0))
    expect(result(late)).toMatchObject({ timing: { missed: 0 } })
    expect(result(late)).not.toHaveProperty('rough')

    const clean = keepTime()
    await play(clean, () => 0)
    expect(result(clean)).toMatchObject({ passed: true })
    expect(result(clean)).not.toHaveProperty('rough')
    clean.session.loopRoughBars()
    expect(ui(clean).repeat).toBe(false)
  })

  it('after its card was opened over the tail: Again counts in from the pass’s start, Loop opens Repeat paused', async () => {
    class WebAudioMetronome {
      click(): void {}
      cancel(): void {}
      setVolume(): void {}
      setContext(): void {}
    }
    const deps = { loadMetronome: async () => ({ WebAudioMetronome }) as unknown as MetronomeModule }
    const pass = async (h: RunHarness, from: number, to: number, skip: number) => {
      const downbeat = h.clock.now + 4000
      for (let g = from; g <= to; g++) {
        if (g === skip) continue
        h.clock.advanceTo(downbeat + (g - from) * 2000)
        h.frames.flush()
        h.tap(pitch(g))
      }
      h.step(300)
      expect(result(h)).not.toBeNull()
    }
    for (const action of ['again', 'loop'] as const) {
      const h = open(piece, {}, { options: { mode: 'time', startPosition: rat(4) }, deps })
      await start(h)
      await pass(h, 8, LAST, 13)
      expect(ui(h).playing || h.session.engine.state.phase === 'completed').toBe(true)
      h.session.openResultDetails(result(h)!.id)
      h.frames.flush()
      expect(ui(h).playing).toBe(false)
      if (action === 'again') {
        await h.session.again()
        h.frames.flush()
        expect(ui(h)).toMatchObject({ countIn: 4, lastResult: null })
        expect(h.session.engine.timeline.start).toEqual(rat(4))
      } else {
        h.session.loopRoughBars()
        h.frames.flush()
        expect(ui(h)).toMatchObject({ mode: 'time', repeat: true, playing: false, countIn: null, lastResult: null })
        expect(ui(h).range).toEqual({ fromOcc: 5, toOcc: 7 })
      }
    }

    // A Keep time review at its goal: Repeat has ended, the card offers Again.
    const h = open(piece, { range: { fromOcc: 0, toOcc: 1 } }, { options: { mode: 'time', repeatTarget: 1 }, deps })
    await start(h)
    await pass(h, 0, 3, -1)
    expect(result(h)).toMatchObject({ targetReached: true })
    expect(ui(h).reviewing).toBe(true)
    h.session.openResultDetails(result(h)!.id)
    h.frames.flush()
    await h.session.again()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ countIn: 4, repeat: true, range: { fromOcc: 0, toOcc: 1 }, lastResult: null })
  })

  it('a Wait run after its card was opened over the tail: Again and Loop do as without it', async () => {
    for (const action of ['again', 'loop'] as const) {
      const h = open(withLeft, { hands: 'right' })
      await start(h)
      read(h, 0, LAST - 1, { 8: [WRONG], 9: [WRONG] })
      h.session.openResultDetails(result(h)!.id)
      if (action === 'again') {
        await h.session.again()
        h.frames.flush()
        expect(ui(h)).toMatchObject({ playing: true, lastResult: null })
        expect(groupNow(h)).toBe(0)
      } else {
        h.session.loopRoughBars()
        pausedOver(h, 'wait')
      }
    }
  })

  it('none in Repeat, in Wait and in Keep time', async () => {
    const h = open(piece, { range: { fromOcc: 0, toOcc: 5 } })
    await start(h)
    for (let k = 0; k < 100 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
    read(h, 0, 11, { 4: [WRONG] })
    expect(result(h)).toMatchObject({ wrongAttacks: 1 })
    expect(result(h)).not.toHaveProperty('rough')
    h.session.loopRoughBars()
    expect(ui(h).range).toEqual({ fromOcc: 0, toOcc: 5 })
  })
})

describe('What you played, over a Wait run (U100, U142)', () => {
  const played = async (h: RunHarness, occ: number): Promise<number[]> => {
    h.backend.calls.length = 0
    expect(await h.session.playSnippet(result(h)!.id, occ, 'played')).toBeNull()
    h.step(20_000)
    return h.backend.calls.filter((c) => c.op === 'on').map((c) => (c as { note: number }).note)
  }

  it('replays a bar as it was played the last time, also one from before a jump', async () => {
    const h = open()
    await start(h)
    read(h, 0, 7, { 2: [WRONG], 4: [WRONG + 2] })
    h.session.seek(0)
    h.frames.flush()
    read(h, 0, 3, { 3: [WRONG + 1] })
    h.session.seek(5)
    h.frames.flush()
    h.session.setSelection({ multiplier: 1.25 })
    read(h, 10, LAST)
    tail(h)
    // Bar 2 from the second time, bar 3 from the first, bar 5 (groups 8 and 9) never.
    expect(await played(h, 1)).toEqual([pitch(2), WRONG + 1, pitch(3)])
    expect(await played(h, 2)).toEqual([WRONG + 2, pitch(4), pitch(5)])
    expect(h.session.snippetBlocked(result(h)!.id, 4, 'played')).toBe('No keys were captured in this bar.')
    expect(await played(h, 9)).toEqual([pitch(18), pitch(19)])
  })

  it('keeps a chord’s presses on both sides of a speed change, and nothing pressed while paused', async () => {
    const chord = buildScore({
      notes: [
        { at: 0, dur: 4, midi: 60 },
        { at: 0, dur: 4, midi: 64 },
        { at: 4, dur: 4, midi: 67 },
      ],
      bars: 2,
    })
    const h = open(chord)
    await start(h)
    h.tap(60)
    h.session.pause()
    h.frames.flush()
    h.tap(WRONG)
    await start(h)
    h.session.setSelection({ multiplier: 0.8 })
    h.frames.flush()
    h.tap(64)
    h.play(67)
    tail(h)
    expect(result(h)).toMatchObject({ passed: true, groupsTotal: 2 })
    expect(await played(h, 0)).toEqual([60, 64])
  })

  it('a dropped run’s keys are not the next one’s', async () => {
    const h = open()
    await start(h)
    read(h, 0, 5, { 2: [WRONG] })
    h.session.restart()
    h.frames.flush()
    read(h, 0, LAST)
    tail(h)
    expect(await played(h, 1)).toEqual([pitch(2), pitch(3)])
  })
})
