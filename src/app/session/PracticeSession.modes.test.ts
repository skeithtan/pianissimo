/**
 * The four modes (Listen, Wait, Keep time, Follow): the learner's explicit choice. Changing it stops
 * what plays, keeps the cursor at the next playable onset and starts nothing; nothing of the old
 * mode outlives it. Listen and Follow record nothing and never move the saved position. A piano
 * that goes away changes neither the mode, nor the hands, nor Repeat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { PRACTICE_MODES, type PracticeMode } from '../../core/model/practice'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { rat, type Rational } from '../../core/music/rational'
import type { BrowserAudioModule, MetronomeModule } from '../../core/playback'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import { RecordingBackend } from '../../core/playback/testkit'
import { resetSharedAudioContext, sharedAudioContext } from '../../core/playback/webaudio/context'
import type { SessionOptions } from './PracticeSession'
import type { Selection } from './selection'
import { FakeStrip, harness as baseHarness, testSettings, type Harness } from './testkit'
import type { MicFollowerLike, SessionDeps, SessionSettings } from './types'

// Quarter = 60: one quarter (1/4) a second. Three bars: the melody in quarters, half notes under it.
const RIGHT = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79]
const LEFT = [48, 50, 52, 53, 55, 57]
const score = buildScore({
  notes: [
    ...RIGHT.map((midi, at) => ({ at, midi })),
    ...LEFT.map((midi, k) => ({ at: k * 2, dur: 2, midi, hand: 'L' as const })),
  ],
  bars: 3,
})
const BAR_2 = { fromOcc: 1, toOcc: 1 }
const PORT = { id: 'in-1', name: 'Piano', manufacturer: null, state: 'disconnected', connection: 'closed' } as never

/** Every ordered pair of different modes. */
const CHANGES = PRACTICE_MODES.flatMap((from) =>
  PRACTICE_MODES.filter((to) => to !== from).map((to) => [from, to] as const),
)

class BrowsableStrip extends FakeStrip {
  browsing = false
  browsePosition: Rational | null = null
  override isBrowsing(): boolean {
    return this.browsing
  }
  browsedPosition(): Rational | null {
    return this.browsing ? this.browsePosition : null
  }
  returnToCurrent(): void {
    this.browsing = false
  }
}

interface Mic extends MicFollowerLike {
  open: boolean
}

type ModesHarness = Omit<Harness, 'strip'> & {
  readonly strip: BrowsableStrip
  readonly mics: Mic[]
  readonly clicks: number[]
}

function harness(
  mode: PracticeMode,
  selection: Partial<Selection> = {},
  opts: { settings?: SessionSettings; options?: Partial<SessionOptions>; deps?: Partial<SessionDeps> } = {},
): ModesHarness {
  const mics: Mic[] = []
  const clicks: number[] = []
  class WebAudioMetronome {
    click(time: number): void {
      clicks.push(time)
    }
    cancel(now: number): void {
      for (let k = clicks.length - 1; k >= 0 && clicks[k]! >= now; k--) clicks.pop()
    }
    setVolume(): void {}
  }
  const h = baseHarness(score, selection, {
    ...(opts.settings ? { settings: opts.settings } : {}),
    options: { mode, ...opts.options },
    deps: {
      loadMetronome: async () => ({ WebAudioMetronome }) as unknown as MetronomeModule,
      createMicFollower: () => {
        const mic: Mic = {
          open: false,
          async start() {
            mic.open = true
          },
          reset() {},
          pause() {},
          resume() {},
          dispose() {
            mic.open = false
          },
        }
        mics.push(mic)
        return mic
      },
      ...opts.deps,
    },
  })
  const strip = new BrowsableStrip()
  h.session.attachStrip(strip)
  h.frames.flush()
  return { ...h, strip, mics, clicks }
}

const ui = (h: ModesHarness) => h.session.ui.get()
const cursor = (h: ModesHarness) => h.session.progress.get().position
const notes = (h: ModesHarness, from = 0) =>
  h.backend
    .ons()
    .slice(from)
    .map((c) => c.note)

/** Notes sounding on the output: on without a matching off, or a cleanup, since. */
function sounding(h: ModesHarness): number[] {
  const down: number[] = []
  for (const c of h.backend.calls) {
    if (c.op === 'on') down.push(c.note)
    else if (c.op === 'off') {
      const k = down.indexOf(c.note)
      if (k >= 0) down.splice(k, 1)
    } else if (c.op === 'cleanup') down.length = 0
  }
  return down
}

/** Plays a little from the start of the piece, up to somewhere between the third and fourth notes. */
async function playSome(h: ModesHarness): Promise<void> {
  await h.session.start()
  h.frames.flush()
  const mode = ui(h).mode
  if (mode === 'time') h.step(4000) // the count-in
  if (mode === 'listen') h.step(2500)
  else {
    // With one hand the other is played by the app; the learner's presses are the right hand's.
    for (const [k, note] of [60, 62, 64].entries()) {
      h.midi.on(note, h.clock.now)
      if (ui(h).hands === 'both' && k % 2 === 0) h.midi.on(LEFT[k / 2]!, h.clock.now)
      h.step(k < 2 ? 1000 : 500)
      h.midi.off(note, h.clock.now)
      if (ui(h).hands === 'both' && k % 2 === 0) h.midi.off(LEFT[k / 2]!, h.clock.now)
    }
  }
  h.frames.flush()
  expect(ui(h).playing).toBe(true)
  expect(cursor(h)).toBeCloseTo(0.625)
}

/** Nothing of the old mode is left: nothing plays, sounds, clicks, waits, listens or animates. */
function expectStill(h: ModesHarness, mode: PracticeMode, position: number): void {
  h.frames.flush()
  h.frames.flush()
  expect(ui(h)).toMatchObject({
    mode,
    playing: false,
    countIn: null,
    waiting: null,
    lastResult: null,
    interruption: null,
    micStatus: null,
    ...(mode === 'wait' ? {} : { leadIn: false }),
    activity: mode === 'follow' ? 'playing' : 'idle',
  })
  expect(sounding(h)).toEqual([])
  expect(h.mics.every((mic) => !mic.open)).toBe(true)
  expect(h.clock.pendingTimers).toBe(0)
  expect(h.frames.pending).toBe(0)
  expect(cursor(h)).toBeCloseTo(position)
  expect(h.strip.cursor).toBeCloseTo(position)
  const heard = h.backend.ons().length
  const clicked = h.clicks.length
  h.step(20_000)
  expect(h.backend.ons()).toHaveLength(heard)
  expect(h.clicks).toHaveLength(clicked)
  expect(h.strip.cursor).toBeCloseTo(position)
  expect(ui(h).playing).toBe(false)
}

/** Start in the mode it is in now, and that it goes on from `position`. */
async function expectStartsFrom(h: ModesHarness, position: number): Promise<void> {
  const heard = h.backend.ons().length
  await h.session.start()
  h.frames.flush()
  expect(ui(h).playing).toBe(true)
  expect(cursor(h)).toBeCloseTo(position)
  if (ui(h).mode === 'listen') expect(notes(h, heard)).toContain(RIGHT[position * 4])
  else if (ui(h).mode === 'time') expect(h.session.engine.timeline.start).toEqual(rat(position * 4, 4))
  else expect(h.strip.targets.map((n) => score.notes[n]!.midi)).toContain(RIGHT[position * 4])
}

beforeEach(() => {
  resetSharedAudioContext()
  sharedAudioContext(() => new FakeAudioContext() as unknown as AudioContext)
})
afterEach(() => resetSharedAudioContext())

describe('practicing a suggestion’s bars (U148)', () => {
  it.each(PRACTICE_MODES)('from %s playing: Repeat over them with the hands and speed, paused', async (mode) => {
    const h = harness(mode)
    await playSome(h)
    const next = mode === 'time' ? 'time' : 'wait'
    h.session.practiceBars(BAR_2, 'right', 0.5, next)
    h.step(20_000)
    expect(cursor(h)).toBe(1)
    expect(sounding(h)).toEqual([])
    expect(ui(h)).toMatchObject({ mode: next, playing: false, countIn: null, lastResult: null, leadIn: false })
    expect(ui(h)).toMatchObject({ repeat: true, range: BAR_2, hands: 'right', multiplier: 0.5, startAction: 'scored' })
    expect(Object.assign({}, ...h.saves.map((s) => s.patch))).toMatchObject({
      lastPassage: BAR_2,
      lastHands: 'right',
      lastMultiplier: 0.5,
      repeatOpen: true,
    })
  })

  it('over the loop already open, the cursor goes back to its start', async () => {
    const h = harness('wait', { range: BAR_2 }, { options: { repeat: true } })
    h.session.seek(2)
    h.session.practiceBars(BAR_2, 'both', 1, 'wait')
    expectStill(h, 'wait', 1)
    expect(ui(h)).toMatchObject({ repeat: true, range: BAR_2, leadIn: false })
  })
})

describe('changing mode', () => {
  it.each(CHANGES)('%s to %s before anything played: the cursor stays', async (from, to) => {
    const h = harness(from)
    h.session.seekPosition(rat(5, 4))
    h.frames.flush()
    const saves = h.saves.length
    h.session.setMode(to)
    expect(h.saves.slice(saves)).toEqual([{ patch: { mode: to, lastHands: 'both' }, immediate: true }])
    expectStill(h, to, 1.25)
    await expectStartsFrom(h, 1.25)
  })

  it.each(CHANGES)('%s to %s while it plays: it stops at the next onset', async (from, to) => {
    const h = harness(from, { hands: 'right' })
    await playSome(h)
    h.session.setMode(to)
    expectStill(h, to, 0.75)
    await expectStartsFrom(h, 0.75)
  })

  it.each(CHANGES)('%s to %s paused mid-piece: the cursor stays', async (from, to) => {
    const h = harness(from)
    await playSome(h)
    h.session.pause()
    h.frames.flush()
    // Keep time's Pause goes back to where its pass began (its attempt has no middle to go on from).
    const at = cursor(h)
    h.session.setMode(to)
    const next = Math.ceil(at * 4 - 1e-9) / 4
    expectStill(h, to, next)
    await expectStartsFrom(h, next)
  })

  it.each(CHANGES)('%s to %s with Repeat open keeps it open, or puts it away in Follow', async (from, to) => {
    const h = harness(from, { range: BAR_2 }, { options: { repeat: true } })
    h.session.setMode(to)
    h.frames.flush()
    expect(ui(h)).toMatchObject({ mode: to, repeat: to !== 'follow', range: to === 'follow' ? null : BAR_2 })
    expect(h.strip.loop).toEqual(to === 'follow' ? null : BAR_2)
    // Follow starts at the piece's start here: it opened there, with the loop put away.
    const position = from === 'follow' ? 0 : 1
    if (from === 'follow' && to === 'wait') expect(ui(h).leadIn).toBe(true)
    expectStill(h, to, from === 'follow' && to === 'listen' ? 1 : position)
    expect(h.saves.some((s) => 'repeatOpen' in s.patch || 'lastPassage' in s.patch)).toBe(false)
  })

  it('the same mode again changes nothing', async () => {
    const h = harness('wait')
    await playSome(h)
    const saves = h.saves.length
    h.session.setMode('wait')
    h.frames.flush()
    expect(ui(h).playing).toBe(true)
    expect(h.saves).toHaveLength(saves)
  })

  it('goes back and forth without drifting', () => {
    const h = harness('wait')
    h.session.seekPosition(rat(3, 2))
    for (const mode of ['listen', 'time', 'follow', 'wait', 'follow', 'listen', 'wait'] as const) {
      h.session.setMode(mode)
      h.frames.flush()
      expect(cursor(h)).toBe(1.5)
    }
  })

  it('past the last onset the cursor goes to the start, as the next Start would', async () => {
    const h = harness('listen')
    h.session.seekPosition(rat(11, 4))
    await h.session.start()
    h.step(500)
    h.session.setMode('wait')
    expectStill(h, 'wait', 0)
  })

  it('after the session is disposed changes nothing', () => {
    const h = harness('wait')
    h.session.dispose()
    const saves = h.saves.length
    h.session.setMode('listen')
    expect(h.saves).toHaveLength(saves)
  })
})

describe('changing mode with the cursor in or around an open loop', () => {
  it('from a running attempt: Keep time rests there, Listen stays in the loop there, Wait leads in from there', async () => {
    const h = harness('wait', { range: BAR_2, hands: 'right' }, { options: { repeat: true } })
    await h.session.start()
    h.play(67, 69)
    h.step(500)
    h.session.setMode('time')
    expectStill(h, 'time', 1.5)
    expect(h.attempts.at(-1)).toMatchObject({ completion: 'interrupted', interruptReason: 'mode-change' })
    h.session.setMode('listen')
    expectStill(h, 'listen', 1.5)
    h.session.setMode('wait')
    expectStill(h, 'wait', 1.5)
    expect(ui(h)).toMatchObject({ leadIn: true, repeat: true, startAction: 'scored' })
    // It reads to the loop's end and wraps into the attempt, as after a seek there (U38).
    await h.session.start()
    h.frames.flush()
    h.play(71, 72)
    for (let k = 0; k < 40 && h.session.engine.mode !== 'scored'; k++) h.step(100)
    expect(h.session.engine.mode).toBe('scored')
    expect(cursor(h)).toBeCloseTo(1)
  })

  it('Keep time’s Start still counts in at the loop start', async () => {
    const h = harness('listen', { range: BAR_2, hands: 'right' }, { options: { repeat: true } })
    h.session.seekPosition(rat(3, 2))
    h.session.setMode('time')
    expectStill(h, 'time', 1.5)
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.timeline.start).toEqual(rat(1))
    expect(ui(h).countIn).toBe(4)
  })

  it('from a lead-in: Listen goes to the loop, Follow and Keep time keep the place', async () => {
    const h = harness('wait', { range: BAR_2, hands: 'right' }, { options: { repeat: true } })
    h.session.seekPosition(rat(1, 4))
    await h.session.start()
    h.frames.flush()
    h.tap(62)
    h.step(500)
    h.session.setMode('follow')
    expectStill(h, 'follow', 0.5)
    h.session.setMode('wait')
    expectStill(h, 'wait', 0.5)
    expect(ui(h)).toMatchObject({ leadIn: true, range: BAR_2 })
    h.session.setMode('time')
    expectStill(h, 'time', 0.5)
    h.session.setMode('listen')
    expectStill(h, 'listen', 1)
    // Nothing read in the lead-in is recorded.
    expect(h.attempts).toEqual([])
  })

  it('a finished run resting at the loop end goes on at the loop start', async () => {
    const h = harness('wait', { range: BAR_2, hands: 'right' }, { options: { repeat: true, repeatTarget: 1 } })
    await h.session.start()
    h.play(67, 69, 71, 72)
    h.step(1500)
    expect(ui(h).lastResult).toMatchObject({ targetReached: true })
    expect(cursor(h)).toBeCloseTo(2)
    h.session.setMode('time')
    expectStill(h, 'time', 1)
    h.session.setMode('wait')
    expectStill(h, 'wait', 1)
    expect(ui(h).leadIn).toBe(false)
  })

  it.each([
    ['a note held over its start', score, { ...BAR_2, start: rat(9, 8) }],
    [
      'a rest',
      buildScore({
        notes: [
          { at: 0, midi: 60 },
          { at: 5, midi: 62 },
        ],
        bars: 2,
      }),
      BAR_2,
    ],
  ] as const)('a loop that begins with %s: Wait waits at its start, not in a lead-in', (_what, model, range) => {
    const h = baseHarness(model, { range, hands: 'right' })
    for (const mode of ['listen', 'wait', 'time', 'wait'] as const) {
      h.session.setMode(mode)
      h.frames.flush()
      expect(h.session.ui.get()).toMatchObject({ mode, leadIn: false, repeat: true })
      expect(h.session.engine.timeline).toBe(h.session.timeline)
      expect(h.session.engine.state.groupIndex).toBe(0)
    }
  })
})

describe('changing mode at an awkward moment', () => {
  it.each(['listen', 'wait', 'follow'] as const)('during the count-in, to %s', async (to) => {
    const h = harness('time', { hands: 'right' })
    await h.session.start()
    h.step(1500)
    expect(ui(h).countIn).toBe(3)
    h.session.setMode(to)
    expect(h.clicks.every((time) => time <= h.clock.now)).toBe(true)
    expectStill(h, to, 0)
    expect(h.attempts).toEqual([])
  })

  it.each(CHANGES)('during a browse hold, %s to %s: the release continues nothing', async (from, to) => {
    const h = harness(from, { hands: 'right' })
    await playSome(h)
    h.session.browseStarted()
    h.strip.browsing = true
    h.strip.browsePosition = rat(2)
    h.frames.flush()
    expect(ui(h).playing).toBe(true)
    h.session.setMode(to)
    h.frames.flush()
    expect(ui(h)).toMatchObject({ mode: to, playing: false })
    await h.session.browseReleased()
    h.step(5000)
    expect(ui(h).playing).toBe(false)
    // Still browsing: the next Start adopts the browsed note (U52).
    expect(h.strip.browsing).toBe(true)
    await h.session.start()
    h.frames.flush()
    expect(cursor(h)).toBeCloseTo(2)
  })

  it.each(['wait', 'time'] as const)('%s: while a finished pass plays on to the Repeat reset', async (from) => {
    const h = harness(from, { range: BAR_2, hands: 'right' }, { options: { repeat: true } })
    await h.session.start()
    h.frames.flush()
    if (from === 'time') h.step(4000)
    for (const note of [67, 69, 71, 72]) {
      if (from === 'wait') h.play(note)
      else h.tap(note)
      if (note !== 72) h.step(1000)
    }
    h.step(300)
    h.session.setMode('listen')
    expect(h.attempts).toMatchObject([{ completion: 'completed', passed: true }])
    expectStill(h, 'listen', 1)
    expect(h.attempts).toHaveLength(1)
    expect(h.strip.corrections).toEqual([])
    expect(h.strip.reviewing).toBe(false)
    expect(h.strip.wraps).toBe(0)
  })

  it('while a finished pass plays on: nothing of that run is left for a loop change to go on with (U94)', async () => {
    const h = harness('wait', { range: BAR_2, hands: 'right' }, { options: { repeat: true } })
    await h.session.start()
    h.play(67, 69, 71, 72)
    h.step(300)
    h.session.setMode('time')
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 1 } })
    h.step(1000)
    expect(ui(h)).toMatchObject({ mode: 'time', playing: false, countIn: null })
  })

  it('while the last chord is still open (P24): the pass is recorded and nothing follows it', async () => {
    const h = harness(
      'wait',
      { range: BAR_2, hands: 'right' },
      { options: { repeat: true }, deps: { finalSlipMs: 60 } },
    )
    await h.session.start()
    h.play(67, 69, 71, 72)
    expect(h.attempts).toEqual([])
    h.session.setMode('time')
    expect(h.attempts).toMatchObject([{ completion: 'completed', passed: true }])
    // The strip does not pan back for a pass that never comes.
    expect(h.strip.wraps).toBe(0)
    expectStill(h, 'time', 1.75)
    expect(h.attempts).toHaveLength(1)
  })

  it('while the other hand’s sounds load for a hand just taken: the cursor stays once they have', async () => {
    const backend = Object.assign(new RecordingBackend(() => 0), { monitor: vi.fn(), dispose: vi.fn() })
    let loaded!: () => void
    const loadBrowserAudio = () =>
      new Promise<BrowserAudioModule>((resolve) => {
        loaded = () => resolve({ createBrowserAudio: () => backend } as unknown as BrowserAudioModule)
      })
    const h = harness('wait', {}, { deps: { loadBrowserAudio, hasWebAudio: () => true } })
    h.midi.out = null
    await playSome(h)
    h.session.setSelection({ hands: 'right' })
    h.session.setMode('time')
    expectStill(h, 'time', 0.75)
    loaded()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expectStill(h, 'time', 0.75)
    expect(backend.ons()).toEqual([])
  })

  it.each(['wait', 'pause'] as const)(
    'while Listen loads this device’s sounds after the piano’s output went (%s): the cursor stays',
    async (then) => {
      const loadBrowserAudio = () => new Promise<BrowserAudioModule>(() => undefined)
      const h = harness('listen', {}, { deps: { loadBrowserAudio, hasWebAudio: () => true } })
      await playSome(h)
      h.midi.out = null
      h.midi.route({ kind: 'output-disconnected', port: PORT })
      void h.session.start()
      await Promise.resolve()
      if (then === 'wait') h.session.setMode('wait')
      else h.session.pause()
      h.session.dismissResult()
      h.frames.flush()
      expect(ui(h)).toMatchObject({ mode: then === 'wait' ? 'wait' : 'listen', playing: false })
      expect(cursor(h)).toBe(0.75)
      expect(h.strip.cursor).toBe(0.75)
    },
  )

  it('Follow paused and changed, then left: coming back it starts, it does not resume', async () => {
    const h = harness('follow')
    await playSome(h)
    h.session.pause()
    h.session.setSelection({ hands: 'right' })
    h.frames.flush()
    expect(ui(h).phase).toBe('paused')
    h.session.setMode('wait')
    h.session.setMode('follow')
    h.frames.flush()
    expect(ui(h).phase).toBeNull()
  })

  it('while a snippet plays in the result card', async () => {
    const h = harness('wait', { range: BAR_2, hands: 'right' }, { options: { repeat: true, repeatTarget: 1 } })
    await h.session.start()
    h.play(67, 69, 71, 72)
    h.step(1500)
    const id = ui(h).lastResult!.id
    expect(await h.session.playSnippet(id, 1, 'written')).toBeNull()
    h.step(500)
    expect(h.session.snippet.get()).not.toBeNull()
    h.session.setMode('listen')
    expect(h.session.snippet.get()).toBeNull()
    expectStill(h, 'listen', 1)
    expect(await h.session.playSnippet(id, 1, 'written')).toBe('This pass is over.')
  })

  it('with a hint on the score: it goes at once instead of freezing there', async () => {
    const settings = testSettings({ hints: { ...DEFAULT_SETTINGS.hints, lifetime: 'until-correct' } })
    const h = harness('wait', {}, { settings })
    await h.session.start()
    h.session.requestHint()
    h.step(500)
    expect(h.strip.opacity.size).toBeGreaterThan(0)
    h.session.setMode('listen')
    expectStill(h, 'listen', 0)
    expect(h.strip.opacity.size).toBe(0)
  })

  it('a result, its marks and its streak go', async () => {
    const h = harness('wait', { range: BAR_2, hands: 'right' }, { options: { repeat: true, repeatTarget: 2 } })
    await h.session.start()
    h.play(67)
    h.tap(68)
    h.play(69, 71, 72)
    h.step(1500)
    expect(ui(h).lastResult).not.toBeNull()
    expect(h.strip.corrections.length).toBeGreaterThan(0)
    h.session.setMode('time')
    h.frames.flush()
    expect(ui(h)).toMatchObject({ lastResult: null, corrections: 0, reviewing: false })
    expect(h.strip.corrections).toEqual([])
  })

  it('a wrong key pressed just before: no flash afterward', async () => {
    const h = harness('wait')
    await h.session.start()
    h.midi.on(61, h.clock.now)
    h.session.setMode('listen')
    h.frames.flush()
    expect(h.flash.hits).toEqual([])
  })

  it('a key held meanwhile is not shown as played once Follow starts', async () => {
    const h = harness('wait')
    h.session.setKeyboardVisible(true)
    h.press(60)
    expect(h.session.guide.get().keys).toContainEqual(expect.objectContaining({ midi: 60, state: 'accepted' }))
    h.session.setMode('follow')
    await h.session.start()
    h.frames.flush()
    expect(h.session.guide.get().keys).toContainEqual(expect.objectContaining({ midi: 60, state: 'target' }))
  })

  it('a settings overlay open: it changes, and keys stay away from the session', async () => {
    const h = harness('wait', { hands: 'right' })
    await playSome(h)
    h.session.holdInput(true)
    h.session.setMode('time')
    expectStill(h, 'time', 0.75)
    h.session.holdInput(false)
    await expectStartsFrom(h, 0.75)
  })

  it('leaves the MIDI path alone: keys pressed in Listen are never judged or kept', async () => {
    const h = harness('listen')
    await playSome(h)
    const version = h.session.engine.state.groupIndex
    h.tap(60, 61, 62)
    h.session.pause()
    h.tap(61)
    expect(h.session.engine.state).toMatchObject({ groupIndex: version, wrongAttacks: 0 })
    expect(h.flash.hits).toEqual([])
    expect(h.strip.accepted).toEqual([])
  })
})

describe('Listen hears only the chosen hands', () => {
  it.each([
    ['both', [...RIGHT.slice(0, 4), 48, 50]],
    ['right', RIGHT.slice(0, 4)],
    ['left', [48, 50]],
  ] as const)('%s', async (hands, expected) => {
    const h = harness('listen', { hands })
    await h.session.start()
    h.step(3800)
    expect(notes(h).sort()).toEqual([...expected].sort())
  })

  it('a hand change while it plays goes on from the same place, without a gap', async () => {
    const h = harness('listen')
    await h.session.start()
    h.step(1500)
    const before = h.backend.ons().length
    h.session.setSelection({ hands: 'left' })
    expect(sounding(h)).toEqual([])
    h.frames.flush()
    expect(ui(h)).toMatchObject({ mode: 'listen', hands: 'left', playing: true })
    expect(cursor(h)).toBeCloseTo(0.375)
    h.step(2600)
    expect(cursor(h)).toBeCloseTo(1.025)
    expect(notes(h, before)).toEqual([50, 52])
    h.session.setSelection({ hands: 'right' })
    h.step(1000)
    expect(notes(h, before).slice(2)).toEqual([69])
    expect(h.saves.filter((s) => s.patch.lastHands).map((s) => s.patch.lastHands)).toEqual(['left', 'right'])
  })

  it('a hand change while paused, or before the first Play, keeps the place', async () => {
    const h = harness('listen')
    h.session.seekPosition(rat(1))
    h.session.setSelection({ hands: 'left' })
    h.frames.flush()
    expect(cursor(h)).toBe(1)
    await h.session.start()
    h.step(2500)
    expect(notes(h)).toEqual([52, 53])
    h.session.pause()
    h.session.setSelection({ hands: 'right' })
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    expect(cursor(h)).toBeCloseTo(1.625)
    const before = h.backend.ons().length
    await h.session.start()
    h.step(500)
    expect(notes(h, before)).toEqual([72])
  })

  it('hands and speed changed at once play on at the new speed', async () => {
    const h = harness('listen')
    await h.session.start()
    h.step(2000)
    h.session.setSelection({ hands: 'left', multiplier: 0.5 })
    h.step(2000)
    expect(cursor(h)).toBeCloseTo(0.75)
    expect(ui(h)).toMatchObject({ hands: 'left', multiplier: 0.5, playing: true })
  })

  it('its output gone after a hand change, a seek still lands on the chosen hand', async () => {
    const h = harness('listen')
    await h.session.start()
    h.session.setSelection({ hands: 'left' })
    h.session.updateSettings(testSettings({ sound: { ...DEFAULT_SETTINGS.sound, destination: 'browser' } }))
    h.session.seekPosition(rat(5, 4))
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    expect(cursor(h)).toBe(1.5)
  })

  it('a loop changed while it plays stays with the chosen hand, and Repeat loops it', async () => {
    const h = harness('listen', { hands: 'left', range: BAR_2 }, { options: { repeat: true } })
    await h.session.start()
    h.step(500)
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    h.step(8500)
    expect(notes(h).every((n) => LEFT.includes(n))).toBe(true)
    expect(notes(h)).toEqual(expect.arrayContaining([52, 53, 55, 57]))
    expect(ui(h).playing).toBe(true)
  })

  it('the strip snaps to the chosen hands, and the cue row stays away', () => {
    const h = harness('listen', { hands: 'left' })
    expect(h.strip.snaps).toEqual(LEFT.map((_, k) => rat(k, 2)))
    expect(h.strip.timingEnabled).toBe(false)
    expect(h.strip.targets).toEqual([])
  })
})

describe('Listen and Follow leave the practice place and the history alone (U72)', () => {
  it.each(['listen', 'follow'] as const)('%s: playing, seeking, pausing, hiding and leaving', async (mode) => {
    const h = harness(mode)
    await playSome(h)
    h.tap(99)
    h.session.seekPosition(rat(1))
    h.session.suspend()
    h.session.pause()
    h.session.seekPosition(rat(2))
    h.session.holdInput(true)
    h.session.holdInput(false)
    await h.session.start()
    h.session.browseStarted()
    h.midi.route({ kind: 'input-disconnected', port: PORT })
    h.session.setInputAvailable(false)
    h.session.suspend()
    h.step(20_000)
    h.session.dispose()
    expect(h.saves).toEqual([])
    expect(h.attempts).toEqual([])
    expect(h.abandons).toEqual([])
  })

  it('a reading left for Listen keeps its own place, recorded once; Listen then moves nothing', async () => {
    const h = harness('wait', { hands: 'right' })
    await playSome(h)
    h.session.setMode('listen')
    expect(h.attempts).toMatchObject([{ kind: 'reading', completion: 'interrupted', interruptReason: 'mode-change' }])
    const resumes = h.saves.filter((s) => s.patch.resume)
    expect(resumes.at(-1)).toMatchObject({ patch: { resume: { position: rat(3, 4) } }, immediate: true })
    await h.session.start()
    h.step(4000)
    h.session.pause()
    h.session.seekPosition(rat(2))
    h.session.dispose()
    expect(h.saves.filter((s) => 'resume' in s.patch)).toHaveLength(resumes.length)
    expect(h.attempts).toHaveLength(1)
    expect(h.abandons).toEqual([])
  })

  it('looking at a piece never practiced leaves no place in it', async () => {
    const h = harness('wait')
    h.session.setMode('listen')
    await h.session.start()
    h.step(3000)
    h.session.setMode('follow')
    await h.session.start()
    h.step(3000)
    h.session.dispose()
    expect(h.saves.some((s) => 'resume' in s.patch)).toBe(false)
  })

  it.each(['listen', 'follow'] as const)('%s: whatever the engine ended there would not be recorded', (mode) => {
    const h = harness(mode)
    h.session.engine.resume(h.clock.now)
    h.session.engine.input({
      kind: 'noteon',
      seq: 1,
      channel: 0,
      note: 61,
      velocity: 80,
      time: h.clock.now,
      portId: 'in-1',
    })
    h.session.engine.interrupt('user-stop', h.clock.now)
    h.session.suspend()
    h.session.dispose()
    expect([h.attempts, h.abandons, h.saves]).toEqual([[], [], []])
  })

  it('reaching the end clears nothing', async () => {
    const h = harness('listen')
    h.session.seekPosition(rat(11, 4))
    await h.session.start()
    h.step(3000)
    expect(ui(h).playing).toBe(false)
    expect(h.saves).toEqual([])
  })

  it('hands, speed, loop and Repeat are still the piece’s', () => {
    const h = harness('listen')
    h.session.setSelection({ hands: 'left' })
    h.session.setSelection({ multiplier: 0.5 })
    h.session.setRepeatMode(true, 1)
    expect(h.saves.map((s) => s.patch)).toEqual([
      { lastHands: 'left', lastPassage: null, lastMultiplier: 1 },
      { lastHands: 'left', lastPassage: null, lastMultiplier: 0.5 },
      { lastHands: 'left', lastPassage: BAR_2, lastMultiplier: 0.5, repeatOpen: true },
    ])
    expect(h.saves.every((s) => s.immediate)).toBe(true)
  })

  it('Wait goes back to saving where it is', async () => {
    const h = harness('listen')
    h.session.seekPosition(rat(1))
    h.session.setMode('wait')
    expect(h.saves.some((s) => 'resume' in s.patch)).toBe(false)
    h.session.suspend()
    expect(h.saves.at(-1)).toMatchObject({ patch: { resume: { position: rat(1), hands: 'both' } }, immediate: true })
  })
})

describe('the piano goes away and comes back (U42, U71)', () => {
  const unplug = (h: ModesHarness) => {
    h.midi.route({ kind: 'input-disconnected', port: PORT })
    h.session.setInputAvailable(false)
    h.frames.flush()
  }
  const replug = (h: ModesHarness) => {
    h.midi.route({ kind: 'input-reconnected', port: PORT })
    h.session.setInputAvailable(true)
    h.frames.flush()
  }

  it('Wait: one interruption, Start resumes where it was', async () => {
    const h = harness('wait', { hands: 'right' })
    await playSome(h)
    const saves = h.saves.length
    unplug(h)
    expect(ui(h)).toMatchObject({
      mode: 'wait',
      hands: 'right',
      playing: false,
      inputDisconnected: true,
      startEnabled: false,
      startReason: 'Wait needs a connected piano.',
    })
    expect(ui(h).interruption).toMatchObject({ reason: 'disconnect', canResume: true })
    expect(h.attempts).toMatchObject([{ completion: 'interrupted', interruptReason: 'disconnect' }])
    expect(sounding(h)).toEqual([])
    h.step(5000)
    await h.session.start()
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    replug(h)
    expect(ui(h)).toMatchObject({ mode: 'wait', inputDisconnected: false, startEnabled: true, startReason: null })
    expect(ui(h).playing).toBe(false)
    expect(h.attempts).toHaveLength(1)
    // Only the place it had reached was saved: not the mode, the hands or anything else.
    expect(h.saves.slice(saves).every((s) => Object.keys(s.patch).join() === 'resume')).toBe(true)
    h.session.resume()
    await vi.waitFor(() => expect(h.session.engine.state.phase).toBe('running'))
    h.frames.flush()
    expect(ui(h)).toMatchObject({ activity: 'reading', playing: true, interruption: null })
    expect(h.session.engine.state.position).toEqual(rat(3, 4))
  })

  it.each(['wait', 'time'] as const)('%s in Repeat: it stays open, paused; Start is a new attempt', async (mode) => {
    const h = harness(mode, { range: BAR_2, hands: 'right' }, { options: { repeat: true } })
    await h.session.start()
    if (mode === 'time') h.step(4000)
    h.tap(67)
    h.step(500)
    unplug(h)
    expect(ui(h)).toMatchObject({ mode, hands: 'right', repeat: true, range: BAR_2, playing: false, countIn: null })
    expect(ui(h).interruption).toMatchObject({ reason: 'disconnect', canResume: false })
    expect(h.attempts).toHaveLength(1)
    h.step(20_000)
    expect(ui(h)).toMatchObject({ repeat: true, playing: false })
    replug(h)
    expect(ui(h)).toMatchObject({ mode, repeat: true, range: BAR_2, playing: false, startEnabled: true })
    await h.session.start()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ activity: 'scored', playing: true, interruption: null })
    expect(h.saves.some((s) => 'repeatOpen' in s.patch || 'mode' in s.patch || 'lastHands' in s.patch)).toBe(false)
  })

  it('Keep time from the cursor: Start counts in again', async () => {
    const h = harness('time', { hands: 'right' })
    h.session.seekPosition(rat(1))
    await h.session.start()
    h.step(5000)
    unplug(h)
    expect(ui(h)).toMatchObject({ mode: 'time', playing: false, startReason: 'Keep time needs a connected piano.' })
    expect(h.clock.pendingTimers).toBe(0)
    replug(h)
    await h.session.start()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ mode: 'time', playing: true, countIn: 4 })
  })

  it('during the count-in it stops the clicks', async () => {
    const h = harness('time', { hands: 'right' })
    await h.session.start()
    h.step(1500)
    unplug(h)
    expect(ui(h).countIn).toBeNull()
    expect(h.clicks.every((time) => time <= h.clock.now)).toBe(true)
    h.step(10_000)
    expect(ui(h).playing).toBe(false)
  })

  it('gone without a route event (another input chosen), a run still ends', async () => {
    const h = harness('wait', { hands: 'right' })
    await playSome(h)
    h.session.setInputAvailable(false)
    h.frames.flush()
    expect(ui(h)).toMatchObject({ playing: false, startEnabled: false, inputDisconnected: false })
    expect(ui(h).interruption?.reason).toBe('disconnect')
    expect(sounding(h)).toEqual([])
    h.session.setInputAvailable(true)
    await h.session.start()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ activity: 'reading', playing: true })
  })

  it('a browse hold ends with it: the release continues nothing', async () => {
    const h = harness('wait', { hands: 'right' })
    await playSome(h)
    h.session.browseStarted()
    h.session.setInputAvailable(false)
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    await h.session.browseReleased()
    h.session.setInputAvailable(true)
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
  })

  it('a pass that had finished and plays on to the next one stops too', async () => {
    const h = harness('wait', { range: BAR_2, hands: 'right' }, { options: { repeat: true } })
    await h.session.start()
    h.play(67, 69, 71, 72)
    h.step(300)
    h.session.setInputAvailable(false)
    h.step(5000)
    expect(ui(h)).toMatchObject({ playing: false, repeat: true })
    expect(ui(h).lastResult).not.toBeNull()
    expect(h.session.engine.state.phase).toBe('completed')
  })

  it('Listen plays on', async () => {
    const h = harness('listen')
    await playSome(h)
    const heard = h.backend.ons().length
    unplug(h)
    h.step(1000)
    expect(ui(h)).toMatchObject({ mode: 'listen', playing: true, startEnabled: true, startReason: null })
    expect(ui(h).interruption).toBeNull()
    expect(h.backend.ons().length).toBeGreaterThan(heard)
    replug(h)
    expect(ui(h)).toMatchObject({ mode: 'listen', playing: true })
    expect(h.attempts).toEqual([])
  })

  it('Follow pauses, and goes on through the microphone meanwhile or the piano afterward', async () => {
    const h = harness('follow', { hands: 'right' })
    await playSome(h)
    unplug(h)
    expect(ui(h)).toMatchObject({ mode: 'follow', hands: 'right', playing: false, follow: 'mic', startEnabled: true })
    expect(ui(h).interruption).toBeNull()
    expect(h.mics).toEqual([])
    replug(h)
    expect(ui(h)).toMatchObject({ mode: 'follow', playing: false, follow: 'piano' })
    await h.session.start()
    h.frames.flush()
    expect(ui(h).playing).toBe(true)
    expect(h.session.progress.get().position).toBeCloseTo(0.75)
    expect(h.mics).toEqual([])
  })

  it('Follow with no microphone waits for the piano', async () => {
    const h = harness('follow', { hands: 'right' }, { deps: { micSupported: () => false } })
    await playSome(h)
    unplug(h)
    expect(ui(h)).toMatchObject({
      mode: 'follow',
      startEnabled: false,
      startReason: 'Follow needs a connected piano or a microphone.',
      phase: 'paused',
    })
    replug(h)
    await h.session.start()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ mode: 'follow', playing: true })
  })

  it('the mode, hands and speed can change meanwhile', async () => {
    const h = harness('wait', { hands: 'right' })
    await playSome(h)
    unplug(h)
    h.session.setSelection({ hands: 'both' })
    h.session.setSelection({ multiplier: 0.5 })
    h.frames.flush()
    expect(ui(h)).toMatchObject({ mode: 'wait', hands: 'both', multiplier: 0.5, startEnabled: false })
    expect(cursor(h)).toBeCloseTo(0.75)
    h.session.setMode('listen')
    expectStill(h, 'listen', 0.75)
    await h.session.start()
    h.step(500)
    expect(ui(h)).toMatchObject({ mode: 'listen', playing: true })
    h.session.setMode('wait')
    replug(h)
    expect(ui(h)).toMatchObject({ mode: 'wait', playing: false, interruption: null, startEnabled: true })
  })
})

describe('what the modes do not touch', () => {
  it.each(PRACTICE_MODES)('the cue row, the metronome’s switch and Repeat in %s', (mode) => {
    const h = harness(mode)
    expect(h.strip.timingEnabled).toBe(mode !== 'listen')
    expect(ui(h)).toMatchObject({
      metronomeScope: mode === 'time' ? 'keepTime' : 'general',
      metronomeMuted: false,
      canHint: mode === 'wait' || mode === 'time',
      startAction: ({ listen: 'listen', wait: 'reading', time: 'scored', follow: 'play' } as const)[mode],
    })
    h.session.repeatFrom(1)
    h.frames.flush()
    expect(ui(h)).toMatchObject({ repeat: mode !== 'follow', range: mode === 'follow' ? null : BAR_2 })
  })

  it.each(PRACTICE_MODES)('the microphone without a piano in %s: only Follow uses it', (mode) => {
    const h = harness(mode)
    h.session.setInputAvailable(false)
    h.frames.flush()
    const startEnabled = mode === 'listen' || mode === 'follow'
    expect(ui(h)).toMatchObject({ follow: 'mic', metronomeMuted: mode === 'follow', startEnabled })
    // The cue row stays in Wait and Keep time (U131).
    expect(h.strip.timingEnabled).toBe(mode === 'wait' || mode === 'time')
  })

  it('opened in Follow, the hint pedal names the notes at the cursor', async () => {
    const hintPedal = {
      channel: null,
      controller: 66,
      threshold: 64,
      inverted: false,
      observedMin: 0,
      observedMax: 127,
      verified: true,
    }
    const settings = testSettings({ pedal: { ...DEFAULT_SETTINGS.pedal, hintPedal } })
    const h = harness('follow', {}, { settings })
    await h.session.start()
    h.frames.flush()
    h.midi.cc(66, 127, h.clock.now)
    h.frames.flush()
    expect(h.strip.opacity.size).toBeGreaterThan(0)
  })

  it('the keyboard guide follows the cursor out of the loop when Follow puts it away', () => {
    const h = harness('wait', { range: BAR_2 }, { options: { repeat: true } })
    const keys = () => h.session.guide.get().keys.map((k) => k.midi)
    h.session.setKeyboardVisible(true)
    h.frames.flush()
    expect(keys()).toEqual([52, 67])
    h.session.setMode('follow')
    h.session.seekPosition(rat(0))
    h.frames.flush()
    expect(keys()).toEqual([48, 60])
  })

  it.each(['playing', 'paused', 'not started'] as const)(
    'Listen %s: its output goes away, said only when it was playing there',
    async (state) => {
      const h = harness('wait', { hands: 'right' })
      await h.session.start()
      h.session.setMode('listen')
      if (state !== 'not started') await h.session.start()
      if (state === 'paused') h.session.pause()
      h.midi.out = null
      h.midi.route({ kind: 'output-disconnected', port: PORT })
      h.frames.flush()
      expect(ui(h)).toMatchObject({ mode: 'listen', playing: false, startEnabled: false })
      expect(ui(h).soundStatus).toBe(
        state === 'not started' ? null : 'The piano output was disconnected. Reconnect it to hear playback.',
      )
    },
  )

  it('the hands are always at least one, in every mode', () => {
    for (const mode of PRACTICE_MODES) {
      const h = harness(mode, { hands: 'left' })
      expect(ui(h).hands).toBe('left')
      h.session.setInputAvailable(false)
      expect(ui(h)).toMatchObject({ mode, hands: 'left' })
      for (const other of PRACTICE_MODES) {
        h.session.setMode(other)
        expect(ui(h)).toMatchObject({ mode: other, hands: 'left' })
      }
    }
  })
})
