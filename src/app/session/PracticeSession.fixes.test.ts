/**
 * Regression tests for audited session bugs: concurrent Start, Again after closing Repeat or
 * reaching the target, one hand on device sound, lead-in cues and paused feedback, lastHands
 * without a piano, the disconnect interruption, the input monitor under an overlay and volumes.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
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
  function loading(selection: Parameters<typeof harness>[1]) {
    const s = deviceSound()
    const p = pendingLoad()
    const h = harness(melody, selection, { deps: { loadBrowserAudio: p.load, hasWebAudio: () => true } })
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

  it('Listen, then a hand chosen during the load: reading is honored, Listen never plays', async () => {
    const { h, s, finish } = loading({ hands: 'none' })
    const start = h.session.start()
    h.session.setSelection({ hands: 'right' })
    await finish(start)
    expect(h.session.ui.get()).toMatchObject({ hands: 'right', activity: 'reading', playing: true })
    // Nothing of the Listen performance (the left hand's part is all the device plays now).
    h.step(500)
    expect(s.backend.ons().every((c) => c.note < 60)).toBe(true)
  })

  it('Listen, then the held hands given back during the load: reading starts, not Listen', async () => {
    const { h, finish } = loading({ hands: 'right' })
    h.session.setInputAvailable(false)
    h.frames.flush()
    expect(h.session.ui.get().hands).toBe('none')
    const start = h.session.start()
    h.session.setInputAvailable(true)
    await finish(start)
    expect(h.session.ui.get()).toMatchObject({ hands: 'right', activity: 'reading' })
  })

  it('Listen, then an overlay opened during the load: nothing plays', async () => {
    const { h, s, finish } = loading({ hands: 'none' })
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

  it('one-hand play-through, then an overlay opened during the load: nothing plays', async () => {
    const { h, s, finish } = loading({ hands: 'right' })
    h.session.setPlayThrough(true)
    const start = h.session.start()
    h.session.holdInput(true)
    await finish(start)
    h.step(1000)
    expect(h.session.ui.get()).toMatchObject({ playThrough: true, playing: false })
    expect(s.backend.ons()).toHaveLength(0)
  })

  it('play-through through the microphone, then an overlay while it opens: nothing plays', async () => {
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
      { settings: testSettings({ mic: { follow: true } }), deps: { createMicFollower: () => mic } },
    )
    h.session.setPlayThrough(true)
    const start = h.session.start()
    await settle()
    expect(mic.start).toHaveBeenCalledTimes(1)
    h.session.holdInput(true)
    open()
    await start
    h.frames.flush()
    h.step(1000)
    expect(h.session.ui.get()).toMatchObject({ playThrough: true, playing: false })
    expect(mic.resume).not.toHaveBeenCalled()
    // Paused as an ordinary pause of play-through through the microphone, not closed.
    expect(mic.pause).toHaveBeenCalledTimes(1)
    expect(mic.dispose).not.toHaveBeenCalled()
    // The overlay closes: Start plays through, with the microphone already open.
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
    h.play(60, 62, 64, 65)
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
    h.frames.flush()
    h.press(60)
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.strip.accepted).toEqual([0])
    h.release(60)
    h.press(67)
    expect(h.strip.accepted).toEqual([])
    expect(h.strip.wrongMarker).toBe(true)
  })
})

describe('no piano', () => {
  it('a speed change without a piano does not save lastHands none', () => {
    const h = harness(melody, { hands: 'right' })
    h.session.setInputAvailable(false)
    h.session.setSelection({ multiplier: 0.5 })
    h.frames.flush()
    expect(h.saves.some((s) => s.patch.lastHands === 'none')).toBe(false)
    expect(h.saves.some((s) => s.patch.lastHands === 'right' && s.patch.lastMultiplier === 0.5)).toBe(true)
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
    expect(h.session.ui.get().hands).toBe('none')
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
    const h = harness(melody, { hands: 'none' }, { deps: { loadBrowserAudio: s.load, hasWebAudio: () => true } })
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
      { hands: 'none' },
      {
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
