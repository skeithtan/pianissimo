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
import { harness, testSettings } from './testkit'

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
