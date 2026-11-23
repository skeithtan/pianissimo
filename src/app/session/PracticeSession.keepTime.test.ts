/**
 * Keep time (DECISIONS P13): the silent-bar stop (U112) with the tolerance and a grace, completed
 * passes kept on every path but the unattended stop, the music's stall shift, the rewind after a
 * pass from the cursor (U126, U128), the loop after a seek outside it, Playback at 0%, the
 * reserved cue row (U122) and the count-in's metronome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import type { ScoreModel } from '../../core/model/score'
import { ZERO, rat } from '../../core/music/rational'
import type { MetronomeModule } from '../../core/playback'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import { resetSharedAudioContext, sharedAudioContext } from '../../core/playback/webaudio/context'
import { KEEP_TIME_GRACE_MS, type SessionOptions } from './PracticeSession'
import type { Selection } from './selection'
import { harness, testSettings, type Harness } from './testkit'
import type { SessionDeps, SessionSettings } from './types'

/** The harness clock starts at 1000; a 4/4 count-in at quarter = 60 takes four seconds. */
const T0 = 1000
const RUN = T0 + 4000
const GRACE = KEEP_TIME_GRACE_MS
const LOOP = { fromOcc: 0, toOcc: 0 }

/** Four bars, one whole note on each downbeat: a bar lasts 4 s. */
const wholes = buildScore({ notes: [60, 62, 64, 65].map((midi, bar) => ({ at: bar * 4, dur: 4, midi })), bars: 4 })
/** Eight quarters over two bars. */
const melody = buildScore({ notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })), bars: 2 })

interface Recorded {
  clicks: { time: number; accent: boolean }[]
}

function metronomeModule(rec: Recorded): MetronomeModule {
  class WebAudioMetronome {
    click(time: number, accent: boolean): void {
      rec.clicks.push({ time, accent })
    }
    cancel(): void {}
    setVolume(): void {}
    setContext(): void {}
  }
  return { WebAudioMetronome } as unknown as MetronomeModule
}

let rec: Recorded
beforeEach(() => {
  rec = { clicks: [] }
  resetSharedAudioContext()
  sharedAudioContext(() => new FakeAudioContext() as unknown as AudioContext)
})
afterEach(() => resetSharedAudioContext())

function open(
  model: ScoreModel,
  selection: Partial<Selection> = {},
  opts: { settings?: SessionSettings; options?: Partial<SessionOptions>; deps?: Partial<SessionDeps> } = {},
): Harness {
  return harness(model, selection, {
    settings: opts.settings ?? testSettings(),
    options: { mode: 'time', ...opts.options },
    deps: { loadMetronome: async () => metronomeModule(rec), ...opts.deps },
  })
}

async function begin(h: Harness): Promise<void> {
  await h.session.start()
  h.frames.flush()
}

/** Advance to `time` (absolute clock time) and run a frame. */
function at(h: Harness, time: number): void {
  h.clock.advanceTo(time)
  h.frames.flush()
}

function playAt(h: Harness, time: number, ...notes: number[]): void {
  at(h, time)
  h.tap(...notes)
}

const ui = (h: Harness) => h.session.ui.get()

describe('Keep time: the silent-bar stop takes early downbeats and late deliveries (U112)', () => {
  const production = { deps: { keepTimeGraceMs: GRACE } }

  it('a downbeat played 20 ms early counts for its bar: the pass goes on and is recorded', async () => {
    const h = open(wholes, {}, production)
    await begin(h)
    playAt(h, RUN, 60)
    playAt(h, RUN + 4000 - 20, 62)
    playAt(h, RUN + 8000, 64)
    at(h, RUN + 8000 + GRACE + 1)
    expect(ui(h).playing).toBe(true)
    playAt(h, RUN + 12_000, 65)
    at(h, RUN + 17_000)
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ completion: 'completed', passed: true })
  })

  it('a four-bar loop whose first note comes 15 ms before the downbeat is not stopped after bar 1', async () => {
    const h = open(wholes, { range: { fromOcc: 0, toOcc: 3 } }, production)
    await begin(h)
    playAt(h, RUN - 15, 60)
    playAt(h, RUN + 4000, 62)
    at(h, RUN + 4000 + GRACE + 1)
    expect(ui(h).playing).toBe(true)
    playAt(h, RUN + 8000, 64)
    playAt(h, RUN + 12_000, 65)
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ completion: 'completed' })
  })

  it('a key stamped inside a bar but delivered after its barline still counts for that bar', async () => {
    const h = open(wholes, {}, production)
    await begin(h)
    playAt(h, RUN, 60)
    // The barline of bar 2 passed (its timer would have judged it there); the grace has not.
    at(h, RUN + 8000 + 60)
    expect(ui(h).playing).toBe(true)
    h.midi.on(64, RUN + 8000 - 10)
    h.midi.off(64, RUN + 8000 - 5)
    h.frames.flush()
    at(h, RUN + 8000 + GRACE + 1)
    expect(ui(h).playing).toBe(true)
  })

  it('a truly silent bar still stops, a grace after its barline, and records nothing', async () => {
    const h = open(wholes, {}, production)
    await begin(h)
    playAt(h, RUN, 60)
    at(h, RUN + 8000 + GRACE - 1)
    expect(ui(h).playing).toBe(true)
    at(h, RUN + 8000 + GRACE)
    expect(ui(h)).toMatchObject({ playing: false, countIn: null, lastResult: null })
    at(h, RUN + 20_000)
    expect(h.attempts).toHaveLength(0)
  })
})

describe('Keep time: a completed pass is kept on every path but the unattended stop', () => {
  /** Bars 1 to 3 played, the last note missed: the engine completes before the last bar ends. */
  async function completedBeforeLastBar(selection: Partial<Selection> = {}): Promise<Harness> {
    const h = open(wholes, selection, { deps: { keepTimeGraceMs: GRACE } })
    await begin(h)
    playAt(h, RUN, 60)
    playAt(h, RUN + 4000, 62)
    playAt(h, RUN + 8000, 64)
    at(h, RUN + 13_000)
    expect(h.session.engine.state.phase).toBe('completed')
    expect(ui(h).playing).toBe(true)
    expect(h.attempts).toHaveLength(0)
    return h
  }

  it('four whole notes, the last three 10 ms early, with the real final-chord hold: one record and its result', async () => {
    const h = open(wholes, {}, { deps: { keepTimeGraceMs: GRACE, finalSlipMs: CHORD_SLIP_MS } })
    await begin(h)
    playAt(h, RUN, 60)
    playAt(h, RUN + 4000 - 10, 62)
    playAt(h, RUN + 8000 - 10, 64)
    playAt(h, RUN + 12_000 - 10, 65)
    at(h, RUN + 16_000 + GRACE + 500)
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ kind: 'scored', completion: 'completed', passed: true })
    expect(ui(h).lastResult).toMatchObject({ id: h.attempts[0]!.id, passed: true })
  })

  it('a pause before the last bar ends keeps the record and starts no further pass', async () => {
    const h = await completedBeforeLastBar({ range: { fromOcc: 0, toOcc: 3 } })
    h.session.pause()
    h.frames.flush()
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ completion: 'completed', missedGroups: 1, passed: false })
    expect(ui(h)).toMatchObject({ playing: false, countIn: null, lastResult: { id: h.attempts[0]!.id } })
    at(h, RUN + 30_000)
    expect(ui(h)).toMatchObject({ playing: false, countIn: null })
    expect(h.session.engine.state.phase).toBe('completed')
    expect(h.attempts).toHaveLength(1)
  })

  it('a seek before the last bar ends keeps the record and clears its marks with the move', async () => {
    const h = await completedBeforeLastBar()
    expect(h.session.seekPosition(rat(1))).toBe(true)
    h.frames.flush()
    expect(h.attempts).toHaveLength(1)
    expect(ui(h)).toMatchObject({ playing: false, corrections: 0, lastResult: { id: h.attempts[0]!.id } })
    expect(h.strip.corrections).toEqual([])
  })

  it.each(['listen', 'wait', 'follow'] as const)(
    'changing to %s keeps the record, with no result card',
    async (mode) => {
      const h = await completedBeforeLastBar()
      h.session.setMode(mode)
      expect(h.attempts).toHaveLength(1)
      expect(h.attempts[0]).toMatchObject({ completion: 'completed' })
      h.frames.flush()
      expect(ui(h)).toMatchObject({ mode, playing: false, lastResult: null, corrections: 0, reviewing: false })
      at(h, RUN + 30_000)
      expect(h.attempts).toHaveLength(1)
      expect(ui(h)).toMatchObject({ mode, playing: false, lastResult: null })
    },
  )

  it('leaving the view keeps the record and publishes nothing afterwards', async () => {
    const h = await completedBeforeLastBar()
    h.session.dispose()
    expect(h.attempts).toHaveLength(1)
    const emissions = h.session.ui.emissions
    at(h, RUN + 30_000)
    expect(h.session.ui.emissions).toBe(emissions)
    expect(h.attempts).toHaveLength(1)
  })

  it('only the unattended stop drops a completed pass: the silent last bar', async () => {
    const h = await completedBeforeLastBar()
    at(h, RUN + 16_000 + GRACE)
    expect(ui(h)).toMatchObject({ playing: false, lastResult: null })
    expect(h.attempts).toHaveLength(0)
  })

  it('a pause while the Repeat opening check is still pending drops the pass and keeps the previous result', async () => {
    const h = open(wholes, { range: { fromOcc: 0, toOcc: 1 } }, { deps: { keepTimeGraceMs: GRACE } })
    await begin(h)
    playAt(h, RUN, 60)
    playAt(h, RUN + 4000, 62)
    const previous = ui(h).lastResult!
    expect(h.attempts).toHaveLength(1)
    // The next pass (its own count-in from the loop end): keys, but never a written pitch.
    const next = RUN + 12_000
    playAt(h, next, 61)
    playAt(h, next + 4000, 63)
    at(h, next + 5000)
    expect(h.session.engine.state.phase).toBe('completed')
    expect(ui(h).playing).toBe(true)
    h.session.pause()
    h.frames.flush()
    expect(h.attempts).toHaveLength(1)
    expect(ui(h)).toMatchObject({ playing: false, countIn: null, reviewing: true, lastResult: { id: previous.id } })
  })

  describe('a one-bar loop, whose opening check carries to the next traversal', () => {
    /** A clean first pass, then the second pass's keys; paused after the engine completed it. */
    async function pausedSecondPass(keys: readonly number[]): Promise<Harness> {
      const h = open(melody, { range: LOOP }, { deps: { keepTimeGraceMs: GRACE } })
      await begin(h)
      ;[60, 62, 64, 65].forEach((pitch, i) => playAt(h, RUN + i * 1000, pitch))
      expect(h.attempts).toHaveLength(1)
      const next = RUN + 8000
      keys.forEach((pitch, i) => playAt(h, next + i * 1000, pitch))
      at(h, next + 3600)
      expect(h.session.engine.state.phase).toBe('completed')
      h.session.pause()
      h.frames.flush()
      return h
    }

    it('keeps a pass whose bar was played, though no written pitch came yet', async () => {
      const h = await pausedSecondPass([61, 63, 66])
      expect(h.attempts).toHaveLength(2)
      expect(h.attempts[1]).toMatchObject({ completion: 'completed', passed: false })
      expect(ui(h).lastResult?.id).toBe(h.attempts[1]!.id)
    })

    it('drops a pass in which nothing was pressed', async () => {
      const h = await pausedSecondPass([])
      expect(h.attempts).toHaveLength(1)
      expect(ui(h).lastResult?.id).toBe(h.attempts[0]!.id)
    })
  })
})

describe('Keep time: the first downbeat may come up to the tolerance early', () => {
  /** Melody notes `from` on, each on its beat after the downbeat at `run`. */
  function playOn(h: Harness, from: number, run = RUN): void {
    ;[60, 62, 64, 65, 67, 69, 71, 72].slice(from).forEach((pitch, i) => playAt(h, run + (from + i) * 1000, pitch))
  }

  it.each([15, 1])('a first note %i ms before the downbeat counts, with its own offset', async (ms) => {
    const h = open(melody)
    await begin(h)
    playAt(h, RUN - ms, 60)
    playOn(h, 1)
    const record = h.attempts.at(-1)!
    expect(record).toMatchObject({ completion: 'completed', passed: true, missedGroups: 0, wrongAttacks: 0 })
    expect(record.groups![0]!.offsetMs).toBe(-ms)
  })

  it('a three-note chord on the first downbeat 10 ms early is one group with all three accepted', async () => {
    const chord = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 0, midi: 64 },
        { at: 0, midi: 67 },
        { at: 1, midi: 62 },
      ],
    })
    const h = open(chord)
    await begin(h)
    playAt(h, RUN - 10, 60, 64, 67)
    at(h, RUN)
    expect(h.session.engine.state).toMatchObject({ groupIndex: 1, lastOffsetMs: -10, wrongAttacks: 0 })
    playAt(h, RUN + 1000, 62)
    expect(h.attempts.at(-1)).toMatchObject({ passed: true, groupsTotal: 2, missedGroups: 0 })
  })

  it('a wrong key 10 ms before the downbeat is the first group wrong key, as one before a later onset is', async () => {
    const h = open(melody)
    await begin(h)
    playAt(h, RUN - 10, 61)
    playAt(h, RUN, 60)
    playAt(h, RUN + 1000, 62)
    playAt(h, RUN + 1990, 61)
    playOn(h, 2)
    const groups = h.attempts.at(-1)!.groups!
    expect(groups[0]).toMatchObject({ wrongPitches: [61], wrongAttacks: 1 })
    expect(groups[2]).toMatchObject({ wrongPitches: [61], wrongAttacks: 1 })
  })

  it('a press earlier than the tolerance stays count-in noodling; the on-time press counts', async () => {
    const h = open(melody)
    await begin(h)
    playAt(h, RUN - 200, 60)
    playOn(h, 0)
    expect(h.attempts.at(-1)).toMatchObject({ passed: true, missedGroups: 0, wrongAttacks: 0 })
    expect(h.attempts.at(-1)!.groups![0]!.offsetMs).toBe(0)
  })

  it('a press stamped after the downbeat but delivered before the count-in timer ran counts a little late', async () => {
    const h = open(melody)
    await begin(h)
    at(h, RUN - 1)
    h.midi.on(60, RUN + 4)
    h.midi.off(60, RUN + 6)
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    at(h, RUN + 6)
    playOn(h, 1)
    expect(h.attempts.at(-1)).toMatchObject({ passed: true, missedGroups: 0 })
    expect(h.attempts.at(-1)!.groups![0]!.offsetMs).toBe(4)
  })

  it('the early first note feeds the live timing trend: rushing on the third drifting note', async () => {
    const h = open(melody)
    await begin(h)
    playAt(h, RUN - 60, 60)
    playAt(h, RUN + 1000 - 90, 62)
    expect(h.strip.timingCue).toBeNull()
    playAt(h, RUN + 2000 - 130, 64)
    expect(h.strip.timingCue).toBe('rushing')
  })

  it('a far early press in the count-in shows its cue at once, as it would during the pass', async () => {
    const eighths = buildScore({ notes: [60, 62, 64, 65].map((midi, i) => ({ at: i / 2, midi, dur: 1 / 2 })) })
    const h = open(eighths)
    await begin(h)
    // The second note's pitch, half a second before its onset.
    playAt(h, RUN - 10, 62)
    at(h, RUN)
    expect(h.strip.timingCue).toBe('rushing')
  })

  it('in Repeat, the next pass downbeat 15 ms early counts the same way after its own count-in', async () => {
    const h = open(melody, { range: LOOP })
    await begin(h)
    ;[60, 62, 64, 65].forEach((pitch, i) => playAt(h, RUN + i * 1000, pitch))
    expect(h.attempts).toHaveLength(1)
    const next = RUN + 8000
    playAt(h, next - 15, 60)
    ;[62, 64, 65].forEach((pitch, i) => playAt(h, next + (i + 1) * 1000, pitch))
    expect(h.attempts).toHaveLength(2)
    expect(h.attempts[1]).toMatchObject({ passed: true, missedGroups: 0 })
    expect(h.attempts[1]!.groups![0]!.offsetMs).toBe(-15)
  })

  it('gated practice is unchanged: the first press after Ready starts the clock', async () => {
    const h = open(melody, { range: LOOP }, { options: { mode: 'wait' } })
    await begin(h)
    expect(h.session.engine.state.phase).toBe('ready')
    at(h, T0 + 500)
    h.tap(60)
    expect(h.session.engine.state).toMatchObject({ phase: 'running', clockStartedAt: T0 + 500 })
    expect(h.session.engine.transport).toBe('accompaniment')
  })
})

describe('Keep time: the cue and the bar windows follow the music after a stall', () => {
  /** A main-thread stall: the overdue timers then run late, the transport's (due first) first. */
  function stall(h: Harness, ms: number): void {
    h.clock.now += ms
    h.clock.advance(0)
    h.frames.flush()
  }

  /** Advance until the music reaches group `group`, then `late` ms more, and press `pitch`. */
  function pressAtArrival(h: Harness, group: number, pitch: number, late = 0): void {
    for (let i = 0; i < 20_000 && h.session.engine.state.transportGate < group; i++) h.clock.advance(1)
    h.clock.advance(late)
    h.tap(pitch)
  }

  it('a 600 ms stall after note 1 moves the music later: presses on its new beat show no cue', async () => {
    const h = open(melody)
    await begin(h)
    playAt(h, RUN, 60)
    stall(h, 600)
    ;[62, 64, 65, 67, 69, 71, 72].forEach((pitch, i) => pressAtArrival(h, i + 1, pitch))
    expect(h.strip.timingCalls.filter((c) => c.direction !== null)).toEqual([])
    expect(h.attempts.at(-1)).toMatchObject({ completion: 'completed', passed: true })
    expect(ui(h).lastResult?.timing).toMatchObject({ groups: 8, onTime: 8 })
  })

  it('after the stall the scored trend builds across presses: dragging on the third drifting note', async () => {
    const h = open(melody)
    await begin(h)
    playAt(h, RUN, 60)
    stall(h, 600)
    ;[62, 64, 65].forEach((pitch, i) => pressAtArrival(h, i + 1, pitch))
    pressAtArrival(h, 4, 67, 10)
    pressAtArrival(h, 5, 69, 40)
    expect(h.strip.timingCalls.filter((c) => c.direction !== null)).toEqual([])
    pressAtArrival(h, 6, 71, 75)
    expect(h.strip.timingCue).toBe('dragging')
  })

  it('the bar windows move with the music: a note on the shifted fourth beat counts for its bar', async () => {
    const beatFour = buildScore({ notes: [60, 62, 64, 65].map((midi, bar) => ({ at: bar * 4 + 3, midi })), bars: 4 })
    // A loop of the four bars: the pass starts at the first barline, not at the first note.
    const h = open(beatFour, { range: { fromOcc: 0, toOcc: 3 } })
    await begin(h)
    playAt(h, RUN + 3000, 60)
    stall(h, 1200)
    pressAtArrival(h, 1, 62)
    // Bar 2 ended at RUN + 8000 on the schedule fixed at the downbeat; the press came after that.
    expect(h.clock.now).toBeGreaterThan(RUN + 8000)
    at(h, h.clock.now + 1001)
    expect(ui(h).playing).toBe(true)
  })
})

describe('Keep time: the rewind after a pass from the cursor (U126, U128)', () => {
  async function finishedFromCursor(): Promise<Harness> {
    const h = open(melody, {}, { options: { startPosition: rat(5, 4) } })
    await begin(h)
    expect(h.session.engine.timeline.start).toEqual(rat(5, 4))
    playAt(h, RUN, 69)
    playAt(h, RUN + 1000, 71)
    playAt(h, RUN + 2000, 72)
    expect(h.attempts.at(-1)).toMatchObject({ completion: 'completed', passed: true })
    // The tail ends with the piece at RUN + 3000.
    at(h, RUN + 3100)
    return h
  }

  it('the cursor, the progress and the view go to zero, and Start counts in from the top', async () => {
    const h = await finishedFromCursor()
    expect(h.strip.wrappedTo).toBe(0)
    expect(h.strip.cursor).toBe(0)
    expect(h.session.progress.get()).toEqual({ position: 0, occ: 0 })
    expect(ui(h)).toMatchObject({ phase: 'completed', playing: false, lastResult: { passed: true } })
    await begin(h)
    expect(h.session.engine.timeline.start).toEqual(ZERO)
    expect(h.session.engine.state.position).toEqual(ZERO)
    expect(h.strip.cursor).toBe(0)
    expect(ui(h).countIn).toBe(4)
  })

  it('Again replays from where the finished pass started', async () => {
    const h = await finishedFromCursor()
    h.session.restart()
    h.frames.flush()
    expect(h.session.engine.timeline.start).toEqual(rat(5, 4))
    expect(ui(h).countIn).toBe(4)
    expect(h.strip.cursor).toBe(1.25)
    const run = h.clock.now + 4000
    playAt(h, run, 69)
    playAt(h, run + 1000, 71)
    playAt(h, run + 2000, 72)
    expect(h.attempts.at(-1)).toMatchObject({ passed: true, groupsTotal: 3 })
  })
})

describe('Keep time in Repeat: back to the loop after a seek outside it', () => {
  it('a speed change after a seek past a one-bar loop puts the cursor at the loop start', () => {
    const h = open(melody, { range: LOOP })
    expect(h.session.seekPosition(rat(3, 2))).toBe(true)
    h.frames.flush()
    expect(h.strip.cursor).toBe(1.5)
    h.session.setSelection({ multiplier: 0.8 })
    h.frames.flush()
    expect(h.strip.cursor).toBe(0)
    expect(h.session.engine.timeline).toBe(h.session.timeline)
    expect(h.session.engine.state.groupIndex).toBe(0)
  })

  it('switching to Wait after such a seek keeps the cursor there: a lead-in, as a seek in Wait sets up', () => {
    const h = open(melody, { range: LOOP })
    h.session.seekPosition(rat(3, 2))
    h.frames.flush()
    h.session.setMode('wait')
    h.frames.flush()
    expect(ui(h)).toMatchObject({ leadIn: true, repeat: true, playing: false })
    expect(h.session.engine.state.position).toEqual(rat(3, 2))
    expect(h.strip.cursor).toBe(1.5)
  })
})

describe('Keep time: Playback at 0% counts as Playback off', () => {
  const duet = buildScore({
    notes: [
      { at: 0, midi: 60, hand: 'R' },
      { at: 0, midi: 48, hand: 'L' },
      { at: 1, midi: 62, hand: 'R' },
      { at: 1, midi: 50, hand: 'L' },
    ],
  })
  const playback = (scorePlaybackVolume: number, patch: Partial<SessionSettings> = {}) =>
    testSettings({ rhythm: { ...DEFAULT_SETTINGS.rhythm, scorePlayback: true, scorePlaybackVolume }, ...patch })
  const echo = { ...testSettings().route, echo: 'echo-detected' as const }

  it('a pass at 0% is filed without the Playback comparison context', async () => {
    const h = open(duet, {}, { settings: playback(0) })
    await begin(h)
    playAt(h, RUN, 48, 60)
    playAt(h, RUN + 1000, 50, 62)
    const record = h.attempts.at(-1)!
    expect(record).toMatchObject({ completion: 'completed', passed: true })
    expect(record.context.scorePlayback).toBeUndefined()
    expect(record.rhythm).toEqual({ toleranceMs: 150 })
    expect(h.backend.ons()).toEqual([])
  })

  it('Start asks for no echo-free output at 0%; above 0% it does again', async () => {
    const h = open(duet, {}, { settings: playback(0, { route: echo }) })
    expect(ui(h)).toMatchObject({ startEnabled: true, startReason: null })
    await begin(h)
    at(h, RUN)
    expect(h.session.engine.state.phase).toBe('running')
    h.session.updateSettings(playback(0.5, { route: echo }))
    h.frames.flush()
    expect(ui(h).startEnabled).toBe(false)
    expect(ui(h).startReason).toContain('echo-free')
    expect(h.session.engine.state.phase).toBe('running')
  })

  it('raising the volume from 0% during a pass turns Playback on from the next notes', async () => {
    const h = open(duet, { range: LOOP }, { settings: playback(0) })
    await begin(h)
    at(h, RUN + 500)
    h.session.updateSettings(playback(0.5))
    expect(h.backend.ons()).toHaveLength(0)
    at(h, RUN + 1000)
    expect(h.backend.ons().map(({ note }) => note)).toEqual([50, 62])
    h.tap(50, 62)
    expect(h.attempts.at(-1)).toMatchObject({ context: { scorePlayback: true }, missedGroups: 1 })
  })
})

describe('The timing cue row is reserved by the setting, not the phase (U122)', () => {
  it('stays reserved from attach through preparing, ready, running, completed and a pause', async () => {
    const h = open(melody, { range: LOOP })
    const phases = new Set<string>()
    const seen = () => phases.add(h.session.engine.state.phase)
    expect(h.strip.timingCalls[0]).toEqual({ direction: null, enabled: true })
    seen()
    h.press(60)
    await begin(h)
    seen()
    h.release(60)
    seen()
    at(h, RUN)
    seen()
    playAt(h, RUN, 60)
    playAt(h, RUN + 1000, 62)
    playAt(h, RUN + 2000, 64)
    playAt(h, RUN + 3000, 65)
    seen()
    at(h, RUN + 4500)
    seen()
    h.session.pause()
    h.frames.flush()
    seen()
    expect([...phases]).toEqual(['paused', 'preparing', 'ready', 'running', 'completed', 'interrupted'])
    expect(h.strip.timingCalls.every((c) => c.enabled)).toBe(true)
  })

  it('stays reserved through Wait and Follow, and is off in Listen or with cues off', async () => {
    const h = open(melody, {}, { options: { mode: 'wait' } })
    await begin(h)
    h.session.pause()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('paused')
    h.session.setMode('follow')
    await begin(h)
    h.session.pause()
    h.frames.flush()
    expect(h.strip.timingCalls.every((c) => c.enabled)).toBe(true)
    h.session.setMode('listen')
    h.frames.flush()
    expect(h.strip.timingEnabled).toBe(false)
    h.session.setMode('wait')
    h.frames.flush()
    expect(h.strip.timingEnabled).toBe(true)
    h.session.updateSettings(testSettings({ hints: { ...DEFAULT_SETTINGS.hints, showTimingCues: false } }))
    h.frames.flush()
    expect(h.strip.timingEnabled).toBe(false)
  })
})

describe('Keep time: the count-in clicks when a metronome setting changes while Start loads it', () => {
  it('a second request while the first loads waits for it instead of canceling it', async () => {
    const pending: ((module: MetronomeModule) => void)[] = []
    const loadMetronome = () => new Promise<MetronomeModule>((resolve) => pending.push(resolve))
    const h = open(melody, {}, { deps: { loadMetronome } })
    const started = h.session.start()
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    // The Practice menu's Metronome switch, flipped while Start still loads the click.
    h.session.updateSettings(testSettings({ metronome: { ...DEFAULT_SETTINGS.metronome, enabled: true } }))
    pending[0]!(metronomeModule(rec))
    await started
    h.frames.flush()
    expect(ui(h).countIn).toBe(4)
    expect(rec.clicks.slice(0, 4)).toEqual([
      { time: T0, accent: true },
      { time: T0 + 1000, accent: false },
      { time: T0 + 2000, accent: false },
      { time: T0 + 3000, accent: false },
    ])
    for (const resolve of pending.slice(1)) resolve(metronomeModule(rec))
  })
})
