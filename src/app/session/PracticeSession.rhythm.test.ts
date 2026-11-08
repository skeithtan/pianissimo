/**
 * Keep time (rhythm mode, DECISIONS P13): a count-in, then the strict transport plays without
 * waiting and the engine judges every group against its scheduled time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import type { MetronomeModule } from '../../core/playback'
import { resetSharedAudioContext, sharedAudioContext } from '../../core/playback/webaudio/context'
import type { LadderSettings } from '../../core/storage/records'
import { harness, testSettings, type Harness } from './testkit'
import type { SessionOptions } from './PracticeSession'
import type { Selection } from './selection'
import type { SessionSettings } from './types'

// Quarter = 60 in 4/4: one beat per second, a four-beat count-in.
const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
})
const noTempo = buildScore({ notes: [{ at: 0, midi: 60 }], tempo: null })
const LOOP = { fromOcc: 0, toOcc: 0 }
/** The harness clock starts at 1000; the count-in takes four beats. */
const T0 = 1000
const RUN = T0 + 4000

/** What reached the metronome sink: clicks and cancels. */
interface Recorded {
  clicks: { time: number; accent: boolean }[]
  cancels: number[]
}

function recordingMetronome(rec: Recorded): () => Promise<MetronomeModule> {
  class WebAudioMetronome {
    click(time: number, accent: boolean): void {
      rec.clicks.push({ time, accent })
    }
    cancel(now: number): void {
      rec.cancels.push(now)
    }
    setVolume(): void {}
  }
  return async () => ({ WebAudioMetronome }) as unknown as MetronomeModule
}

let rec: Recorded
beforeEach(() => {
  rec = { clicks: [], cancels: [] }
  resetSharedAudioContext()
  sharedAudioContext(() => new FakeAudioContext() as unknown as AudioContext)
})
afterEach(() => resetSharedAudioContext())

function open(
  selection: Partial<Selection> = {},
  opts: { settings?: SessionSettings; options?: Partial<SessionOptions>; rhythm?: boolean } = {},
): Harness {
  return harness(melody, selection, {
    settings: opts.settings ?? testSettings(),
    options: { rhythm: opts.rhythm ?? true, ...opts.options },
    deps: { loadMetronome: recordingMetronome(rec) },
  })
}

async function begin(h: Harness): Promise<void> {
  await h.session.start()
  h.frames.flush()
}

/** Advance to `at` (absolute clock time) and run a frame. */
function at(h: Harness, time: number): void {
  h.clock.advanceTo(time)
  h.frames.flush()
}

/** Tap each pitch at its scheduled time (+ offset ms), group i at RUN + i·beatMs. */
function playOnTime(
  h: Harness,
  pitches: readonly number[],
  offsets: readonly number[] = [],
  start = RUN,
  beatMs = 1000,
) {
  pitches.forEach((p, i) => {
    at(h, start + i * beatMs + (offsets[i] ?? 0))
    h.tap(p)
  })
}

const ui = (h: Harness) => h.session.ui.get()

describe('Keep time: count-in', () => {
  it('counts in one bar with accented first click, then starts the clock and the music together', async () => {
    const h = open()
    expect(ui(h)).toMatchObject({ rhythm: true, startAction: 'scored', startEnabled: true, countIn: null })
    await begin(h)
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.transport).toBe('strict')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h).countIn).toBe(4)
    expect(ui(h).playing).toBe(true)
    expect(rec.clicks).toEqual([
      { time: 1000, accent: true },
      { time: 2000, accent: false },
      { time: 3000, accent: false },
      { time: 4000, accent: false },
    ])
    const counts: (number | null)[] = []
    for (let t = 2000; t <= 4000; t += 1000) {
      at(h, t)
      counts.push(ui(h).countIn)
    }
    expect(counts).toEqual([3, 2, 1])
    expect(h.session.engine.state.phase).toBe('ready')
    at(h, RUN)
    expect(ui(h).countIn).toBeNull()
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.engine.state.clockStartedAt).toBe(RUN)
    // The attempt's own clicks follow the Metronome setting (off): only the count-in clicked.
    at(h, RUN + 3000)
    expect(rec.clicks).toHaveLength(4)
  })

  it('counts in at the speed and in dotted beats for a compound meter', async () => {
    const six = buildScore({ notes: [0, 3, 6, 9].map((at, i) => ({ at: at / 2, midi: 60 + i })), meter: [6, 8] })
    const h = harness(
      six,
      { multiplier: 0.5 },
      { options: { rhythm: true }, deps: { loadMetronome: recordingMetronome(rec) } },
    )
    await begin(h)
    // Two dotted-quarter beats of 1.5 s, at half speed 3 s each.
    expect(rec.clicks.map((c) => c.time)).toEqual([1000, 4000])
    expect(ui(h).countIn).toBe(2)
    at(h, 7000)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.engine.state.clockStartedAt).toBe(7000)
  })

  it('clicks with the metronome on too; the attempt then clicks its own beats', async () => {
    const h = open({}, { settings: testSettings({ metronome: { ...DEFAULT_SETTINGS.metronome, enabled: true } }) })
    await begin(h)
    expect(rec.clicks).toHaveLength(4)
    at(h, RUN + 1500)
    expect(rec.clicks.length).toBeGreaterThan(4)
    expect(rec.clicks[4]!.time).toBeGreaterThanOrEqual(RUN)
  })

  it('does not judge presses during the count-in', async () => {
    const h = open()
    await begin(h)
    at(h, 2500)
    h.tap(60)
    h.tap(61)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.session.engine.state.wrongAttacks).toBe(0)
    expect(h.strip.pulses).toBe(0)
    at(h, RUN)
    expect(h.session.engine.state.phase).toBe('running')
  })

  it('a pause during the count-in cancels it and its clicks', async () => {
    const h = open()
    await begin(h)
    at(h, 2500)
    const cancels = rec.cancels.length
    h.session.pause()
    h.frames.flush()
    expect(rec.cancels.length).toBeGreaterThan(cancels)
    expect(rec.cancels.at(-1)).toBe(2500)
    expect(ui(h).countIn).toBeNull()
    expect(ui(h).playing).toBe(false)
    at(h, RUN + 2000)
    expect(h.session.engine.state.phase).toBe('interrupted')
    expect(h.session.engine.state.clockStartedAt).toBeNull()
  })

  it('a seek during the count-in cancels it and interrupts the attempt', async () => {
    const h = open()
    await begin(h)
    at(h, 2500)
    expect(h.session.seekPosition(melody.occurrences[1]!.start)).toBe(false)
    h.frames.flush()
    expect(ui(h).countIn).toBeNull()
    expect(h.session.engine.state.phase).toBe('interrupted')
    expect(h.session.engine.state.interruptReason).toBe('seek')
    at(h, RUN + 1000)
    expect(h.session.engine.state.phase).toBe('interrupted')
  })

  it('a speed change during the count-in prepares a fresh attempt with its own count-in at the new speed', async () => {
    const h = open()
    await begin(h)
    at(h, 2500)
    h.session.setSelection({ multiplier: 0.5 })
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h).countIn).toBe(4)
    expect(rec.clicks.slice(-4).map((c) => c.time)).toEqual([2500, 4500, 6500, 8500])
    at(h, RUN)
    expect(h.session.engine.state.phase).toBe('ready')
    at(h, 10500)
    expect(h.session.engine.state.phase).toBe('running')
  })
})

describe('Keep time: playing against the music', () => {
  it('releases every gate: the music never waits for the learner', async () => {
    const h = open()
    await begin(h)
    at(h, RUN + 2500)
    // Two and a half quarters later the cursor is there, though nothing was played.
    expect(h.strip.cursor).toBeCloseTo(2.5 / 4, 3)
    expect(h.session.engine.state.missedGroups).toBe(3)
    expect(h.session.engine.state.groupIndex).toBe(3)
  })

  it('a group completed early within the tolerance never moves the music ahead', async () => {
    const h = open()
    await begin(h)
    at(h, RUN)
    h.tap(60)
    at(h, RUN + 900)
    h.tap(62)
    expect(h.session.engine.state.lastOffsetMs).toBe(-100)
    expect(h.session.engine.state.groupIndex).toBe(2)
    expect(h.strip.cursor).toBeLessThan(0.25)
    at(h, RUN + 1000)
    expect(h.strip.cursor).toBeCloseTo(0.25, 3)
  })

  it('a missed group gets the soft wash only; a late slip tints the cursor amber for a moment', async () => {
    const h = open()
    await begin(h)
    // Group 0 closes at RUN + 150.
    at(h, RUN + 200)
    expect(h.session.engine.state.missedGroups).toBe(1)
    expect(h.flash.hits.at(-1)).toMatchObject({ now: RUN + 200, soft: true })
    expect(h.strip.pulses).toBe(0)
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.session.feedback.get().visible).toBe(false)
    const hits = h.flash.hits.length
    h.tap(60)
    expect(h.session.engine.state.wrongAttacks).toBe(0)
    expect(h.strip.earlyMarker).toBe(true)
    expect(h.strip.pulses).toBe(0)
    expect(h.flash.hits).toHaveLength(hits)
    at(h, RUN + 800)
    expect(h.strip.earlyMarker).toBe(false)
  })

  it('a clean attempt records the strict context, the tolerance and on-time offsets', async () => {
    const h = open()
    await begin(h)
    playOnTime(h, [60, 62, 64, 65, 67, 69, 71, 72], [0, 20, -30, 0, 50, 0, -10, 0])
    h.frames.flush()
    const record = h.attempts.at(-1)!
    expect(record).toMatchObject({
      kind: 'scored',
      completion: 'completed',
      passed: true,
      rhythm: { toleranceMs: 150 },
      context: { transport: 'strict', matchingRules: 'strict-v1-tol-150ms' },
    })
    expect(record.groups?.map((g) => g.offsetMs)).toEqual([0, 20, -30, 0, 50, 0, -10, 0])
    expect(ui(h).lastResult).toMatchObject({
      passed: true,
      timing: { groups: 8, onTime: 8, early: 0, late: 0, missed: 0 },
    })
  })

  it('the result summary counts on-time and missed groups; a miss fails the attempt', async () => {
    const h = open()
    await begin(h)
    playOnTime(h, [60, 62, 64], [0, 0, 0])
    // 65 is never played: the music passes it.
    playOnTime(h, [67, 69, 71, 72], [], RUN + 4000)
    h.frames.flush()
    expect(h.attempts.at(-1)).toMatchObject({ passed: false, missedGroups: 1, completion: 'completed' })
    expect(ui(h).lastResult?.timing).toEqual({ groups: 8, onTime: 7, early: 0, late: 0, missed: 1 })
    expect(ui(h).corrections).toBeGreaterThan(0)
  })

  it('pause interrupts; Start afterwards is a fresh attempt from the start, with a count-in', async () => {
    const h = open()
    await begin(h)
    playOnTime(h, [60, 62])
    h.session.pause()
    h.frames.flush()
    expect(h.attempts.at(-1)).toMatchObject({ completion: 'interrupted', interruptReason: 'pause' })
    expect(ui(h).playing).toBe(false)
    const t = h.clock.now
    await begin(h)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.session.engine.state.groupIndex).toBe(0)
    expect(ui(h).countIn).toBe(4)
    at(h, t + 4000)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.engine.state.clockStartedAt).toBe(t + 4000)
  })

  it('a seek while running interrupts', async () => {
    const h = open()
    await begin(h)
    playOnTime(h, [60])
    h.session.seekPosition(melody.occurrences[1]!.start)
    h.frames.flush()
    expect(h.attempts.at(-1)).toMatchObject({ completion: 'interrupted', interruptReason: 'seek' })
  })

  it('passes the tolerance setting to the engine; changing it interrupts an attempt', async () => {
    const tight = testSettings({ rhythm: { toleranceMs: 80 } })
    const h = open({}, { settings: tight })
    await begin(h)
    playOnTime(h, [60, 62], [0, -100])
    // -100 ms is beyond ±80: an early wrong attack, then the group is passed.
    expect(h.session.engine.state.wrongAttacks).toBe(1)
    h.session.updateSettings(testSettings({ rhythm: { toleranceMs: 250 } }))
    h.frames.flush()
    const record = h.attempts.at(-1)!
    expect(record).toMatchObject({ completion: 'interrupted', interruptReason: 'setting-change' })
    expect(record.rhythm).toEqual({ toleranceMs: 80 })
    expect(record.context.matchingRules).toBe('strict-v1-tol-80ms')
    expect(ui(h).interruption?.text).toBe('The Keep time tolerance changed, so the attempt stopped.')
    // The next attempt uses the new tolerance.
    h.session.restart()
    h.frames.flush()
    expect(ui(h).interruption).toBeNull()
    expect(ui(h).countIn).toBe(4)
    const t = h.clock.now
    playOnTime(h, [60, 62, 64, 65, 67, 69, 71, 72], [], t + 4000)
    h.frames.flush()
    expect(h.attempts.at(-1)).toMatchObject({ rhythm: { toleranceMs: 250 }, passed: true })
  })

  it('a label-setting interruption keeps its own text', async () => {
    const h = open()
    await begin(h)
    at(h, RUN + 100)
    h.session.beforeApplyLabels({ ...DEFAULT_SETTINGS.labels, mode: 'all' })
    h.frames.flush()
    expect(ui(h).interruption?.text).toBe('A label setting changed, so the attempt stopped.')
  })
})

describe('Keep time: modes', () => {
  it('is exclusive with play-through', () => {
    const h = open({}, { rhythm: false })
    h.session.setRhythmMode(true)
    expect(ui(h).rhythm).toBe(true)
    h.session.setPlayThrough(true)
    expect(ui(h)).toMatchObject({ playThrough: true, rhythm: false, startAction: 'play' })
    h.session.setRhythmMode(true)
    expect(ui(h)).toMatchObject({ playThrough: false, micStatus: null, rhythm: true, startAction: 'scored' })
    expect(h.saves.filter((s) => 'rhythm' in s.patch).map((s) => s.patch.rhythm)).toEqual([true, false, true])
  })

  it('needs a hand selected and a numerical tempo', () => {
    const none = open({ hands: 'none' }, { rhythm: false })
    none.session.setRhythmMode(true)
    expect(none.session.ui.get().rhythm).toBe(false)
    const h = harness(noTempo, {}, { options: { rhythm: true } })
    expect(h.session.ui.get().rhythm).toBe(false)
    h.session.setRhythmMode(true)
    expect(h.session.ui.get().rhythm).toBe(false)
  })

  it('without Repeat reads the whole piece from its start, not from the reading position', async () => {
    const h = open({}, { options: { startPosition: melody.occurrences[1]!.start } })
    expect(h.session.engine.state.groupIndex).toBe(4)
    await begin(h)
    expect(h.session.engine.state.groupIndex).toBe(0)
    expect(h.session.engine.timeline.groups).toHaveLength(8)
  })

  it('Repeat mode: every pass gets its own count-in at the loop start', async () => {
    const h = open({ range: LOOP })
    await begin(h)
    playOnTime(h, [60, 62, 64, 65])
    expect(h.attempts.at(-1)).toMatchObject({ passed: true })
    expect(ui(h).lastResult?.streak).toBe(1)
    // The music finishes the bar, then the next pass is prepared and counts in.
    at(h, RUN + 4000)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h).countIn).toBe(4)
    expect(rec.clicks.filter((c) => c.accent).map((c) => c.time)).toEqual([T0, RUN + 4000])
    at(h, RUN + 8000)
    expect(h.session.engine.state.phase).toBe('running')
    playOnTime(h, [60, 62, 64, 65], [], RUN + 8000)
    expect(ui(h).lastResult?.streak).toBe(2)
  })

  it('Repeat mode: a seek only interrupts or moves the cursor, no lead-in; Start counts in at the loop start', async () => {
    const h = open({ range: { fromOcc: 1, toOcc: 1 } })
    expect(h.session.seekPosition(melody.occurrences[0]!.start)).toBe(true)
    h.frames.flush()
    expect(ui(h).leadIn).toBe(false)
    await begin(h)
    expect(h.session.engine.timeline.groups[0]!.notes).toEqual(h.session.timeline.groups[0]!.notes)
    expect(h.session.engine.state.groupIndex).toBe(0)
    expect(h.session.engine.state.position).toEqual(melody.occurrences[1]!.start)
    expect(ui(h).countIn).toBe(4)
  })

  it('the speed ladder climbs in Keep time, and the next pass counts in at the new speed', async () => {
    const ladder: LadderSettings = { goal: 1, step: 0.05 }
    const h = open({ range: LOOP, multiplier: 0.5 }, { options: { ladder, repeatTarget: 1 } })
    await begin(h)
    // Half speed: two-second beats.
    const run = T0 + 8000
    at(h, run)
    expect(h.session.engine.state.phase).toBe('running')
    playOnTime(h, [60, 62, 64, 65], [], run, 2000)
    expect(ui(h).lastResult).toMatchObject({ passed: true, ladder: { climbedTo: 0.55 } })
    at(h, run + 8000)
    expect(ui(h).multiplier).toBe(0.55)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.session.engine.transport).toBe('strict')
    expect(ui(h).countIn).toBe(4)
    const beat = 1000 / 0.55
    const last = rec.clicks.slice(-4).map((c) => c.time - (run + 8000))
    last.forEach((t, k) => expect(t).toBeCloseTo(k * beat, 6))
    expect(h.attempts.at(-1)?.context.multiplier).toBe(0.5)
  })

  it('switching Keep time off mid-attempt interrupts and returns to reading at the current position', async () => {
    const h = open()
    await begin(h)
    playOnTime(h, [60, 62, 64])
    h.session.setRhythmMode(false)
    h.frames.flush()
    expect(h.attempts.at(-1)).toMatchObject({ completion: 'interrupted', interruptReason: 'mode-change' })
    expect(h.session.engine.mode).toBe('reading')
    expect(h.session.engine.transport).toBe('accompaniment')
    expect(h.session.engine.state.groupIndex).toBe(3)
    expect(ui(h)).toMatchObject({ rhythm: false, playing: false, startAction: 'reading', countIn: null })
    expect(ui(h).interruption).toBeNull()
  })

  it('switching Keep time on stops reading and the next Start is a strict attempt', async () => {
    const h = open({}, { rhythm: false })
    await h.session.start()
    h.play(60, 62)
    expect(h.session.engine.mode).toBe('reading')
    h.session.setRhythmMode(true)
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    expect(ui(h).startAction).toBe('scored')
    await begin(h)
    expect(h.session.engine.transport).toBe('strict')
    expect(ui(h).countIn).toBe(4)
  })
})
