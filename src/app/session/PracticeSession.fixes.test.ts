/**
 * Regression tests for audited session bugs: concurrent Start, Again after closing Repeat or
 * reaching the target, one hand on device sound, lead-in cues and paused feedback, the
 * disconnect interruption, the input monitor under an overlay and volumes.
 */
import { describe, expect, it, vi } from 'vitest'
import { CHORD_SLIP_MS } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import type { PracticeMode } from '../../core/model/practice'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { sharedAudioContext, type BrowserAudioModule, type MetronomeModule } from '../../core/playback'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import { resetSharedAudioContext } from '../../core/playback/webaudio/context'
import { RecordingBackend } from '../../core/playback/testkit'
import { FakeMidiBackend, harness, testSettings } from './testkit'

const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
})
const loop = { fromOcc: 1, toOcc: 1 }
const deviceSound = (extra = {}) => {
  const backend = Object.assign(new RecordingBackend(() => 0), { monitor: vi.fn(), dispose: vi.fn(), ...extra })
  return { backend, load: vi.fn(async () => ({ createBrowserAudio: () => backend }) as unknown as BrowserAudioModule) }
}
const port = { id: 'in-1', name: 'Piano', manufacturer: null, state: 'disconnected' as const, connection: 'closed' }

/** Let the lazy loader's promise chain finish (it takes several microtasks). */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

/** A browser-sound loader that resolves only when the test says so. */
function pendingLoad() {
  let resolve!: (m: BrowserAudioModule) => void
  const load = vi.fn(() => new Promise<BrowserAudioModule>((r) => (resolve = r)))
  return { load, resolve: (m: BrowserAudioModule) => resolve(m) }
}

describe('Start while sounds load', () => {
  it('a second Start while device sound loads still yields a working attempt', async () => {
    const s = deviceSound()
    const p = pendingLoad()
    const h = harness(
      melody,
      { hands: 'right', range: loop },
      { deps: { loadBrowserAudio: p.load, hasWebAudio: () => true } },
    )
    h.midi.out = null
    h.session.updateSettings(testSettings())
    h.frames.flush()
    const a = h.session.start()
    const b = h.session.start()
    p.resolve({ createBrowserAudio: () => s.backend } as unknown as BrowserAudioModule)
    await Promise.all([a, b])
    h.frames.flush()
    h.step(500)
    h.play(67, 69, 71, 72)
    for (let i = 0; i < 300; i++) h.step(20)
    expect(h.attempts.filter((x) => x.kind === 'scored').map((x) => x.completion)).toEqual(['completed'])
  })

  it('clearing the loop while device sound loads: no scored attempt outside Repeat', async () => {
    const s = deviceSound()
    const p = pendingLoad()
    const h = harness(
      melody,
      { hands: 'right', range: loop },
      { deps: { loadBrowserAudio: p.load, hasWebAudio: () => true } },
    )
    h.midi.out = null
    h.session.updateSettings(testSettings())
    h.frames.flush()
    const a = h.session.start()
    h.session.setSelection({ range: null })
    p.resolve({ createBrowserAudio: () => s.backend } as unknown as BrowserAudioModule)
    await a
    h.frames.flush()
    expect(h.session.engine.mode).toBe('reading')
  })
})

describe('Start canceled while sounds load', () => {
  /** Device sound only (no piano output), loading until the test resolves it. */
  function loading(selection: Parameters<typeof harness>[1], mode: PracticeMode = 'wait') {
    const s = deviceSound()
    const p = pendingLoad()
    const h = harness(melody, selection, {
      options: { mode },
      deps: { loadBrowserAudio: p.load, hasWebAudio: () => true },
    })
    h.midi.out = null
    h.session.updateSettings(testSettings())
    h.frames.flush()
    const finish = async (start: Promise<void>) => {
      p.resolve({ createBrowserAudio: () => s.backend } as unknown as BrowserAudioModule)
      await start
      await settle()
      h.frames.flush()
    }
    return { h, s, finish }
  }

  it.each(['listen', 'wait', 'follow'] as const)(
    '%s, then another mode during the load: nothing plays, and a Start there does not wait for it',
    async (mode) => {
      const { h, s, finish } = loading({ hands: 'right' }, mode)
      const start = h.session.start()
      h.session.setMode('time')
      const second = h.session.start()
      await finish(start)
      await second
      h.frames.flush()
      // Only the Keep time Start went on: its attempt, and no sound of the old mode.
      expect(h.session.ui.get()).toMatchObject({ mode: 'time', activity: 'scored', playing: true, countIn: 4 })
      h.step(500)
      expect(s.backend.ons()).toEqual([])
    },
  )

  it.each(['listen', 'wait', 'follow'] as const)(
    '%s, then another mode during the load and no Start there: nothing starts',
    async (mode) => {
      const { h, s, finish } = loading({ hands: 'right' }, mode)
      const start = h.session.start()
      h.session.setMode(mode === 'listen' ? 'wait' : 'listen')
      await finish(start)
      h.step(1000)
      expect(h.session.ui.get()).toMatchObject({ activity: 'idle', playing: false, startEnabled: true })
      expect(s.backend.ons()).toEqual([])
    },
  )

  it('Listen, then other hands during the load: it plays those', async () => {
    const { h, s, finish } = loading({}, 'listen')
    const start = h.session.start()
    h.session.setSelection({ hands: 'left' })
    await finish(start)
    expect(h.session.ui.get()).toMatchObject({ mode: 'listen', hands: 'left' })
    h.step(500)
    // The melody is the right hand's.
    expect(s.backend.ons()).toEqual([])
  })

  it('Wait loses its piano during the load: nothing plays', async () => {
    const { h, s, finish } = loading({ hands: 'right' })
    const start = h.session.start()
    h.session.setInputAvailable(false)
    await finish(start)
    h.step(1000)
    expect(h.session.ui.get()).toMatchObject({ hands: 'right', playing: false, startEnabled: false })
    expect(s.backend.ons()).toEqual([])
  })

  it('Listen, then an overlay opened during the load: nothing plays', async () => {
    const { h, s, finish } = loading({}, 'listen')
    const start = h.session.start()
    h.session.holdInput(true)
    await finish(start)
    h.step(1000)
    // As before the Start: no Listen transport was built.
    expect(h.session.ui.get()).toMatchObject({ activity: 'idle', playing: false, startEnabled: true })
    expect(s.backend.ons()).toHaveLength(0)
  })

  it('one-hand reading, then Pause during the load: nothing plays, and Start again works', async () => {
    const { h, finish } = loading({ hands: 'right' })
    const start = h.session.start()
    h.session.pause()
    await finish(start)
    h.step(1000)
    expect(h.session.ui.get()).toMatchObject({ activity: 'idle', playing: false, startEnabled: true })
    expect(h.session.engine.state.phase).not.toBe('running')
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ activity: 'reading', playing: true })
    h.play(60, 62)
    expect(h.session.engine.state.groupIndex).toBe(2)
  })

  it('Start, Pause and Start again during the load: the second Start plays', async () => {
    const { h, finish } = loading({ hands: 'right' })
    const first = h.session.start()
    h.session.pause()
    const second = h.session.start()
    await finish(first)
    await second
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ activity: 'reading', playing: true })
    h.play(60, 62)
    expect(h.session.engine.state.groupIndex).toBe(2)
  })

  it('Start, Pause, Start, Pause during the load: nothing plays, and Start afterwards works', async () => {
    const { h, finish } = loading({ hands: 'right' })
    const first = h.session.start()
    h.session.pause()
    const second = h.session.start()
    h.session.pause()
    await finish(first)
    await second
    h.step(1000)
    expect(h.session.ui.get()).toMatchObject({ playing: false, startEnabled: true })
    expect(h.session.engine.state.phase).not.toBe('running')
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ activity: 'reading', playing: true })
  })

  it('one-hand reading, then an overlay opened during the load: nothing plays', async () => {
    const { h, s, finish } = loading({ hands: 'right' })
    const start = h.session.start()
    h.session.holdInput(true)
    await finish(start)
    h.step(1000)
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.engine.state.phase).not.toBe('running')
    expect(s.backend.ons()).toHaveLength(0)
  })

  it('one-hand Follow, then an overlay opened during the load: nothing plays', async () => {
    const { h, s, finish } = loading({ hands: 'right' }, 'follow')
    const start = h.session.start()
    h.session.holdInput(true)
    await finish(start)
    h.step(1000)
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', playing: false })
    expect(s.backend.ons()).toHaveLength(0)
  })

  it('Follow through the microphone, then an overlay while it opens: nothing plays', async () => {
    let open!: () => void
    const mic = {
      start: vi.fn(() => new Promise<void>((r) => (open = r))),
      reset: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    }
    const h = harness(
      melody,
      {},
      {
        options: { mode: 'follow' },
        deps: { createMicFollower: () => mic },
      },
    )
    h.session.setInputAvailable(false)
    const start = h.session.start()
    await settle()
    expect(mic.start).toHaveBeenCalledTimes(1)
    h.session.holdInput(true)
    open()
    await start
    h.frames.flush()
    h.step(1000)
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', playing: false })
    expect(mic.resume).not.toHaveBeenCalled()
    // Paused as an ordinary pause of Follow through the microphone, not closed.
    expect(mic.pause).toHaveBeenCalledTimes(1)
    expect(mic.dispose).not.toHaveBeenCalled()
    // The overlay closes: Start follows, with the microphone already open.
    h.session.holdInput(false)
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(true)
    expect(mic.start).toHaveBeenCalledTimes(1)
    expect(mic.reset).toHaveBeenCalledTimes(1)
    expect(mic.resume).toHaveBeenCalledTimes(1)
  })
})

describe('Again', () => {
  it('Again after closing Repeat does not leave a running engine without a transport', async () => {
    const h = harness(melody, { range: loop })
    h.session.setRepeatTarget(1)
    await h.session.start()
    h.play(67, 69, 71, 72)
    h.step(1000)
    expect(h.session.ui.get().lastResult?.targetReached).toBe(true)
    h.session.setRepeatMode(false)
    h.frames.flush()
    // Closing Repeat is a selection change: the result card goes with the corrections (U39).
    expect(h.session.ui.get().lastResult).toBeNull()
    h.session.restart()
    h.frames.flush()
    const ui = h.session.ui.get()
    expect(ui.playing && ui.activity === 'idle').toBe(false)
    expect(ui.playing).toBe(false)
  })

  it('Again after the target is reached starts a new run', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } })
    h.session.setRepeatTarget(2)
    await h.session.start()
    h.play(60, 62, 64, 65)
    h.step(1000)
    h.play(60, 62, 64, 65)
    h.step(1000)
    expect(h.session.ui.get().lastResult?.targetReached).toBe(true)
    h.session.restart()
    h.frames.flush()
    h.step(100)
    h.play(60, 62, 64, 65)
    h.step(1000)
    expect(h.session.ui.get().lastResult).toMatchObject({ streak: 1, targetReached: false })
  })
})

describe('a new run during the tail of a Repeat pass', () => {
  const bar = { fromOcc: 0, toOcc: 0 }

  async function failedPass(again: (h: ReturnType<typeof harness>) => Promise<void> | void) {
    const h = harness(melody, { range: bar })
    h.session.setRepeatTarget(1)
    await h.session.start()
    h.play(60)
    h.tap(61)
    h.play(62, 64, 65)
    // The pass failed; the music still plays to the loop end before Repeat resets.
    expect(h.session.ui.get().lastResult?.passed).toBe(false)
    expect(h.session.ui.get().playing).toBe(false)
    await again(h)
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    // The first note is guarded after the failed pass, so it completes after the hold.
    h.play(60)
    h.step(CHORD_SLIP_MS)
    h.play(62, 64, 65)
    expect(h.session.ui.get().lastResult?.targetReached).toBe(true)
    for (let i = 0; i < 50; i++) h.step(100)
    return h
  }

  it('Start: a clean pass reaches the target and the session stays completed', async () => {
    const h = await failedPass((x) => x.session.start())
    expect(h.session.engine.state.phase).toBe('completed')
    expect(h.session.ui.get()).toMatchObject({ playing: false, lastResult: { targetReached: true } })
    expect(h.attempts.map((a) => a.passed)).toEqual([false, true])
  })

  it('Restart: a clean pass reaches the target and the session stays completed', async () => {
    const h = await failedPass((x) => x.session.restart())
    expect(h.session.engine.state.phase).toBe('completed')
    expect(h.session.ui.get()).toMatchObject({ playing: false, lastResult: { targetReached: true } })
  })

  it('without a new Start the pass repeats by itself', async () => {
    const h = harness(melody, { range: bar })
    h.session.setRepeatTarget(1)
    await h.session.start()
    h.play(60)
    h.tap(61)
    h.play(62, 64, 65)
    for (let i = 0; i < 50; i++) h.step(100)
    expect(h.session.engine.state.phase).toBe('ready')
  })
})

describe('one hand on device sound', () => {
  it('both hands Ready on device sound, then one hand: the new attempt gets Ready', async () => {
    const s = deviceSound()
    const h = harness(
      melody,
      { hands: 'both', range: { fromOcc: 0, toOcc: 0 } },
      { deps: { loadBrowserAudio: s.load, hasWebAudio: () => true } },
    )
    h.midi.out = null
    h.session.updateSettings(testSettings())
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    h.session.setSelection({ hands: 'right' })
    for (let i = 0; i < 20; i++) h.step(50)
    await settle()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    expect(s.load).toHaveBeenCalledTimes(1)
  })

  it('reading on both hands, then one hand while device sound is not loaded: the music plays on', async () => {
    const s = deviceSound()
    const h = harness(melody, { hands: 'both' }, { deps: { loadBrowserAudio: s.load, hasWebAudio: () => true } })
    h.midi.out = null
    h.session.updateSettings(testSettings())
    await h.session.start()
    h.play(60)
    h.session.setSelection({ hands: 'right' })
    await settle()
    h.step(100)
    expect(s.load).toHaveBeenCalledTimes(1)
    expect(h.session.ui.get()).toMatchObject({ playing: true, activity: 'reading' })
    const before = h.session.progress.get().position
    h.play(62, 64)
    expect(h.session.progress.get().position).toBeGreaterThan(before)
  })
})

describe('lead-in', () => {
  it('accidental cue in a lead-in follows the lead-in group', async () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    h.frames.flush()
    await h.session.start()
    h.frames.flush()
    h.tap(61)
    expect(h.session.feedback.get().cue).toEqual({ kind: 'accidental', text: 'C♮4', accidental: '♮' })
    h.tap(68)
    expect(h.session.feedback.get().cue).toBeNull()
  })

  it('paused key feedback in a lead-in judges the lead-in group', () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    h.session.setKeyboardVisible(true)
    h.frames.flush()
    h.press(60)
    expect(h.strip.accepted).toEqual([0])
    h.release(60)
    h.press(67)
    expect(h.strip.accepted).toEqual([])
    expect(h.session.guide.get().keys).toContainEqual(expect.objectContaining({ midi: 67, state: 'wrong' }))
  })
})

describe('no piano', () => {
  it('hands and speed stay selectable and are saved', () => {
    const h = harness(melody, { hands: 'right' })
    h.session.setInputAvailable(false)
    h.session.setSelection({ multiplier: 0.5 })
    h.session.setSelection({ hands: 'left' })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ mode: 'wait', hands: 'left', multiplier: 0.5 })
    expect(h.saves.map((s) => [s.patch.lastHands, s.patch.lastMultiplier])).toEqual([
      ['right', 0.5],
      ['left', 0.5],
    ])
  })

  it('scored: disconnect + reconnect shows the disconnect interruption', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.play(60, 62)
    h.midi.route({ kind: 'input-disconnected', port: port as never })
    h.session.setInputAvailable(false)
    h.frames.flush()
    h.midi.route({ kind: 'input-reconnected', port: port as never })
    h.session.setInputAvailable(true)
    h.frames.flush()
    expect(h.session.ui.get().interruption?.reason).toBe('disconnect')
    expect(h.session.ui.get().hands).toBe('both')
    // Restart from the banner prepares a new attempt that gets Ready.
    h.session.restart()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('reading: disconnect + reconnect shows the disconnect interruption with Resume', async () => {
    const h = harness(melody, { hands: 'right' })
    await h.session.start()
    h.play(60, 62)
    h.midi.route({ kind: 'input-disconnected', port: port as never })
    h.session.setInputAvailable(false)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ mode: 'wait', hands: 'right', startEnabled: false })
    h.midi.route({ kind: 'input-reconnected', port: port as never })
    h.session.setInputAvailable(true)
    h.frames.flush()
    expect(h.session.ui.get().interruption).toMatchObject({ reason: 'disconnect', canResume: true })
    h.session.resume()
    await settle()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ playing: true, activity: 'reading', interruption: null })
    const before = h.session.progress.get().position
    h.play(64, 65)
    expect(h.session.progress.get().position).toBeGreaterThan(before)
  })
})

describe('device sound', () => {
  it('a key released while an overlay holds input is released in the monitor', async () => {
    const s = deviceSound()
    const h = harness(melody, { hands: 'right' }, { deps: { loadBrowserAudio: s.load, hasWebAudio: () => true } })
    h.midi.out = null
    h.session.updateSettings(testSettings({ sound: { ...DEFAULT_SETTINGS.sound, monitorInput: true } }))
    await h.session.start()
    h.frames.flush()
    h.session.pause()
    h.press(70)
    h.session.holdInput(true)
    h.release(70)
    h.session.holdInput(false)
    const evs = s.backend.monitor.mock.calls.map((c) => c[0] as { kind: string; note?: number })
    expect(evs.some((e) => e.kind === 'noteoff' && e.note === 70)).toBe(true)
  })

  it('a browser volume change reaches the loaded device sound', async () => {
    const s = deviceSound({ setVolume: vi.fn() })
    const h = harness(
      melody,
      {},
      { options: { mode: 'listen' }, deps: { loadBrowserAudio: s.load, hasWebAudio: () => true } },
    )
    h.midi.out = null
    h.session.updateSettings(testSettings())
    await h.session.start()
    h.step(200)
    h.session.updateSettings(testSettings({ sound: { ...DEFAULT_SETTINGS.sound, browserVolume: 0.2 } }))
    expect((s.backend as unknown as { setVolume: ReturnType<typeof vi.fn> }).setVolume).toHaveBeenCalledWith(0.2)
  })

  it('a metronome volume change reaches the loaded metronome', async () => {
    const setVolume = vi.fn()
    class WebAudioMetronome {
      click(): void {}
      cancel(): void {}
      setVolume = setVolume
    }
    const loadMetronome = vi.fn(async () => ({ WebAudioMetronome }) as unknown as MetronomeModule)
    const metronome = { ...DEFAULT_SETTINGS.metronome, enabled: true }
    resetSharedAudioContext()
    sharedAudioContext(() => new FakeAudioContext() as unknown as AudioContext)
    try {
      const h = harness(melody, {}, { settings: testSettings({ metronome }), deps: { loadMetronome } })
      await h.session.start()
      expect(loadMetronome).toHaveBeenCalledTimes(1)
      h.session.updateSettings(testSettings({ metronome: { ...metronome, volume: 0.3 } }))
      expect(setVolume).toHaveBeenCalledWith(0.3)
    } finally {
      resetSharedAudioContext()
    }
  })
})

describe('Human-held guard on the MIDI output', () => {
  const withEcho = (echo: 'untested' | 'none' | 'echo-detected') =>
    testSettings({ route: { ...DEFAULT_SETTINGS.route, outputId: 'out-1', outputVerified: true, echo } })

  /** A Listen harness that records the `humanGuard` of every MIDI backend it builds. */
  function listen(echo: 'untested' | 'none' | 'echo-detected') {
    const guards: boolean[] = []
    const backend = new FakeMidiBackend(() => 0)
    const h = harness(
      melody,
      {},
      {
        options: { mode: 'listen' },
        settings: withEcho(echo),
        deps: {
          createMidiBackend: (_out, _ch, guard) => {
            guards.push(guard)
            return backend
          },
        },
      },
    )
    return { h, guards }
  }

  it('is off on an untested route, so an echoing piano cannot make app notes stick', async () => {
    const { h, guards } = listen('untested')
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().activity).toBe('listening')
    expect(guards).toEqual([false])
  })

  it('is on on a route verified echo-free', async () => {
    const { h, guards } = listen('none')
    await h.session.start()
    expect(guards).toEqual([true])
  })

  it('is off on an echoing route', async () => {
    const { h, guards } = listen('echo-detected')
    await h.session.start()
    expect(guards).toEqual([false])
  })

  it('the backend is rebuilt with the guard on once the echo test finds the route echo-free', async () => {
    const { h, guards } = listen('untested')
    await h.session.start()
    h.step(300)
    h.session.pause()
    h.frames.flush()
    h.session.updateSettings(withEcho('none'))
    h.frames.flush()
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().activity).toBe('listening')
    expect(guards).toEqual([false, true])
  })
})

describe('Late tick timer and pending early press', () => {
  // Group 1 (62) and group 2 (64) are 1/16 beat (62.5 ms at 60 BPM) apart — within EARLY_PRESS_GRACE_MS.
  const closeNotes = buildScore({
    notes: [
      { at: 0, midi: 60 },
      { at: 1, midi: 62 },
      { at: 1.0625, midi: 64 },
      { at: 2, midi: 65 },
    ],
    bars: 1,
  })

  function manualTimers(getNow: () => number) {
    let nextId = 1
    const queue: Array<{ id: number; at: number; delay: number; fn: () => void }> = []
    return {
      timers: {
        setTimeout(fn: () => void, ms: number): unknown {
          const id = nextId++
          queue.push({ id, at: getNow() + Math.max(0, ms), delay: ms, fn })
          return id
        },
        clearTimeout(handle: unknown): void {
          const i = queue.findIndex((t) => t.id === handle)
          if (i >= 0) queue.splice(i, 1)
        },
      },
      get dueCount() {
        const now = getNow()
        return queue.filter((t) => t.at <= now).length
      },
      fireNext(): boolean {
        const now = getNow()
        let best = -1
        for (let i = 0; i < queue.length; i++) {
          if (queue[i]!.at <= now && (best < 0 || queue[i]!.at < queue[best]!.at)) best = i
        }
        if (best < 0) return false
        const [t] = queue.splice(best, 1)
        t!.fn()
        return true
      },
    }
  }

  it('defers a late tick once so an earlier-stamped key event completes the group and accepts the pending press', async () => {
    let now = 1000
    const tq = manualTimers(() => now)
    const advanceUntil = (pred: () => boolean) => {
      for (let i = 0; i < 400 && !pred(); i++) {
        now += 20
        while (tq.fireNext()) {
          // drain due timers
        }
      }
      expect(pred()).toBe(true)
    }
    const h = harness(
      closeNotes,
      { range: { fromOcc: 0, toOcc: 0 } },
      { deps: { clock: () => now, timers: tq.timers } },
    )
    h.session.setMode('time')
    await h.session.start()
    advanceUntil(() => h.session.engine.state.phase === 'running')
    h.midi.on(60, now)
    h.midi.off(60, now)
    // Advance close to gate 1 (1000 ms after gate 0), stopping 20 ms before it so the pending
    // press's deadline (now + 150) falls strictly before group 1's missed-note close (gate 1 + 150).
    const gate1At = now + 1000
    advanceUntil(() => now >= gate1At - 20)
    expect(h.session.engine.state.groupIndex).toBe(1)

    // Early press of next group's pitch (64): pending until engine.nextDeadline().
    h.midi.on(64, now)
    h.midi.off(64, now)
    const deadline = h.session.engine.nextDeadline()!
    expect(deadline).toBe(now + 150)
    expect(h.session.engine.state.groupIndex).toBe(1)
    expect(h.flash.hits).toHaveLength(0)

    // Drain transport timers before the pending-press deadline (gates 1 and 2 arrive here).
    for (; now + 10 < deadline;) {
      now += 10
      while (tq.fireNext()) {
        // drain
      }
    }
    now = deadline - 1
    while (tq.fireNext()) {
      // drain
    }

    // Main thread stalls so the deadline timer fires > 8 ms after its scheduled time.
    now = deadline + 15
    expect(tq.dueCount).toBe(1)
    expect(tq.fireNext()).toBe(true)

    // Queued MIDI event stamped BEFORE the deadline arrives after the late timer callback.
    h.midi.on(62, deadline - 10)
    h.midi.off(62, deadline - 10)
    while (tq.fireNext()) {
      // drain any remaining due timers
    }
    h.frames.flush()

    // Group 1 completed and pending 64 completed group 2; no 'ahead' wrong attack.
    expect(h.session.engine.state.groupIndex).toBe(3)
    expect(h.flash.hits).toHaveLength(0)
    // Finish the pass to confirm zero wrong attacks recorded.
    advanceUntil(() => h.session.engine.state.transportGate >= 3)
    h.midi.on(65, now)
    h.midi.off(65, now)
    expect(h.attempts[0]).toMatchObject({ completion: 'completed', wrongAttacks: 0 })
  })

  it('still ticks and expires the pending press as ahead when no key event arrives', async () => {
    let now = 1000
    const tq = manualTimers(() => now)
    const advanceUntil = (pred: () => boolean) => {
      for (let i = 0; i < 400 && !pred(); i++) {
        now += 20
        while (tq.fireNext()) {
          // drain due timers
        }
      }
      expect(pred()).toBe(true)
    }
    const h = harness(
      closeNotes,
      { range: { fromOcc: 0, toOcc: 0 } },
      { deps: { clock: () => now, timers: tq.timers } },
    )
    h.session.setMode('time')
    await h.session.start()
    advanceUntil(() => h.session.engine.state.phase === 'running')
    h.midi.on(60, now)
    h.midi.off(60, now)
    const gate1At = now + 1000
    advanceUntil(() => now >= gate1At - 20)

    h.midi.on(64, now)
    h.midi.off(64, now)
    const deadline = h.session.engine.nextDeadline()!
    expect(deadline).toBe(now + 150)

    // Drain transport timers before the pending-press deadline.
    for (; now + 10 < deadline;) {
      now += 10
      while (tq.fireNext()) {
        // drain
      }
    }
    now = deadline - 1
    while (tq.fireNext()) {
      // drain
    }

    // First run is > 8 ms late: re-queues once with 0 delay, does not expire yet.
    now = deadline + 15
    expect(tq.dueCount).toBe(1)
    expect(tq.fireNext()).toBe(true)
    h.frames.flush()
    expect(h.flash.hits).toHaveLength(0)
    expect(tq.dueCount).toBe(1)

    // Second run ticks normally without re-queuing again, expiring the pending press as 'ahead'.
    expect(tq.fireNext()).toBe(true)
    h.frames.flush()
    expect(h.session.engine.state.groupIndex).toBe(1)
    expect(h.flash.hits).toHaveLength(1)
    expect(tq.dueCount).toBe(0)

    // Complete the pass to verify the wrong attack was counted.
    h.midi.on(62, now)
    h.midi.off(62, now)
    h.midi.on(64, now)
    h.midi.off(64, now)
    advanceUntil(() => h.session.engine.state.transportGate >= 3)
    h.midi.on(65, now)
    h.midi.off(65, now)
    expect(h.attempts[0]).toMatchObject({ completion: 'completed', wrongAttacks: 1 })
  })
})
