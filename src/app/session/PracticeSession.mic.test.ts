/**
 * The microphone follower in play-through (DECISIONS P15, P16, P22): the session opens it on
 * Start, turns its position estimates into gate releases, and closes it when play-through ends.
 * Without a piano play-through is how a hand plays (P22); with one, the Follow choice
 * (`settings.mic.follow`) picks the microphone.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import type { ScoreModel } from '../../core/model/score'
import { type Rational, ZERO, rat } from '../../core/music/rational'
import { harness, testSettings, type Harness } from './testkit'
import type { MetronomeModule } from '../../core/playback'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import { resetSharedAudioContext, sharedAudioContext } from '../../core/playback/webaudio/context'
import type { Selection } from './selection'
import type { MicEstimate, MicFollowerLike, SessionDeps } from './types'

// Quarter = 60: one quarter (a quarter of a whole note) per second; group k at k/4.
const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
})

// The left hand plays on the off-beats: its groups are at 1/8, 3/8, … (DECISIONS P22).
const offBeats = buildScore({
  notes: [
    ...[60, 62, 64, 65].map((midi, at) => ({ at, midi })),
    ...[48, 50, 52, 53].map((midi, at) => ({ at: at + 0.5, midi, hand: 'L' as const })),
  ],
  bars: 2,
})

class FakeMic implements MicFollowerLike {
  calls: string[] = []
  started: Rational | null = null
  disposed = false
  fail: Error | null = null
  constructor(
    readonly onEstimate: (e: MicEstimate) => void,
    readonly onLost: (reason: string) => void,
    readonly hands?: 'both' | 'right' | 'left',
  ) {}
  async start(position: Rational): Promise<void> {
    this.calls.push('start')
    if (this.fail) throw this.fail
    this.started = position
  }
  reset(position: Rational): void {
    this.calls.push(`reset ${position.n}/${position.d}`)
  }
  pause(): void {
    this.calls.push('pause')
  }
  resume(): void {
    this.calls.push('resume')
  }
  dispose(): void {
    this.disposed = true
    this.calls.push('dispose')
  }
  hear(position: number, confidence = 0.9): void {
    this.onEstimate({ position, confidence })
  }
}

function micHarness(
  model: ScoreModel = melody,
  opts: { follow?: boolean; fail?: Error; supported?: boolean; selection?: Partial<Selection> } = {},
) {
  const mics: FakeMic[] = []
  const h = harness(model, opts.selection ?? {}, {
    settings: testSettings({ mic: { follow: opts.follow ?? true } }),
    deps: {
      createMicFollower: (_model: ScoreModel, onEstimate, onLost, hands) => {
        const mic = new FakeMic(onEstimate, onLost, hands)
        if (opts.fail) mic.fail = opts.fail
        mics.push(mic)
        return mic
      },
      micSupported: () => opts.supported ?? true,
    },
  })
  return { h, mics, mic: () => mics[mics.length - 1]! }
}

async function playThrough(h: Harness): Promise<void> {
  h.session.setPlayThrough(true)
  await h.session.start()
  h.frames.flush()
}

describe('Play-through through the microphone', () => {
  it('Start opens the microphone at the first group and follows its estimates', async () => {
    const { h, mics, mic } = micHarness()
    await playThrough(h)
    expect(mics.length).toBe(1)
    expect(mic().started).toEqual(ZERO)
    expect(mic().calls).toEqual(['start', 'reset 0/1', 'resume'])
    expect(h.session.ui.get().micStatus).toBe('Following through the microphone.')
    expect(h.session.ui.get().playing).toBe(true)
    expect(h.strip.targets).toEqual([0])
    h.step(2000)
    expect(h.strip.cursor).toBe(0)
    mic().hear(0.001)
    h.frames.flush()
    expect(h.strip.targets).toEqual([1])
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    h.step(600)
    // Holding at the next onset until the microphone hears it.
    expect(h.strip.cursor).toBeCloseTo(0.25)
    mic().hear(0.26)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.375)
  })

  it('ignores low confidence and estimates behind the current group', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    mic().hear(0.3, 0.2)
    h.step(500)
    expect(h.strip.cursor).toBe(0)
    mic().hear(-0.5)
    h.step(500)
    expect(h.strip.cursor).toBe(0)
    mic().hear(0.3)
    h.frames.flush()
    expect(h.strip.targets).toEqual([2])
  })

  it('follows fast and slow microphone performances without timing cues', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    mic().hear(0)
    h.step(100)
    mic().hear(0.25)
    h.frames.flush()
    expect(h.strip.targets).toEqual([2])
    expect(h.strip.timingCue).toBeNull()
    h.step(3000)
    mic().hear(0.5)
    h.frames.flush()
    expect(h.strip.targets).toEqual([3])
    expect(h.strip.timingCue).toBeNull()
  })

  it('an estimate past several groups releases them all in order', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    mic().hear(0.51)
    h.frames.flush()
    expect(h.strip.targets).toEqual([3])
    expect(h.strip.cursor).toBeGreaterThanOrEqual(0.5)
    h.step(1500)
    expect(h.strip.cursor).toBeCloseTo(0.75)
  })

  it('an estimate at the end rewinds the piece and pauses the microphone follower', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    mic().hear(5)
    h.step(6000)
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.ui.get().phase).toBe('completed')
    expect(h.strip.wrappedTo).toBe(0)
    expect(h.strip.cursor).toBe(0)
    expect(mic().calls.at(-1)).toBe('pause')
  })

  it('pause and resume freeze and restart the estimate; a seek restarts it there', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    mic().hear(0.26)
    h.step(100)
    h.session.pause()
    expect(mic().calls.at(-1)).toBe('pause')
    mic().hear(0.6)
    h.frames.flush()
    expect(h.strip.targets).toEqual([2])
    await h.session.start()
    expect(mic().calls.slice(-2)).toEqual(['reset 1/2', 'resume'])
    h.session.seek(1)
    h.frames.flush()
    expect(mic().calls.at(-1)).toBe('reset 1/1')
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('a speed change leaves the follower alone; new hands reopen it for those hands', async () => {
    const { h, mics, mic } = micHarness()
    await playThrough(h)
    mic().hear(0.26)
    h.frames.flush()
    const calls = mic().calls.length
    h.session.setSelection({ hands: 'both', multiplier: 0.8 })
    // The follower follows the order of the notes, at any speed: nothing to tell it, and it
    // goes on from where the player is.
    expect(mic().calls.length).toBe(calls)
    expect(h.session.ui.get().playing).toBe(true)
    mic().hear(0.51)
    h.frames.flush()
    expect(h.strip.targets).toEqual([3])
    expect(mics[0]!.hands).toBe('both')
    // One hand (P22): the microphone still follows, now that hand's notes only.
    h.session.setSelection({ hands: 'right', multiplier: 0.8 })
    await h.session.start()
    h.frames.flush()
    expect(mics[0]!.disposed).toBe(true)
    expect(mics.length).toBe(2)
    expect(mic().hands).toBe('right')
    expect(mic().started).toEqual(rat(3, 4))
    expect(h.session.ui.get()).toMatchObject({ playing: true, micStatus: 'Following through the microphone.' })
  })

  it('leaving play-through closes the microphone and clears its status', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    h.session.setPlayThrough(false)
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get().micStatus).toBeNull()
    expect(h.session.ui.get().playThrough).toBe(false)
  })

  it('switching Follow mid-play pauses: the next Start follows the new source (DECISIONS P22)', async () => {
    const { h, mics, mic } = micHarness()
    await playThrough(h)
    mic().hear(0.26)
    h.frames.flush()
    h.session.updateSettings(testSettings({ mic: { follow: false } }))
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get()).toMatchObject({ playing: false, playThrough: true, follow: 'piano', micStatus: null })
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    expect(h.session.ui.get().playing).toBe(true)
    // The piano's keys follow now, from the same group.
    expect(h.strip.targets).toEqual([2])
    h.tap(64)
    h.frames.flush()
    expect(h.strip.targets).toEqual([3])
    h.session.updateSettings(testSettings({ mic: { follow: true } }))
    expect(h.session.ui.get()).toMatchObject({ playing: false, follow: 'mic' })
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(2)
    expect(mic().started).toEqual(rat(3, 4))
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('a microphone that cannot start leaves play-through stopped with the reason', async () => {
    const { h, mic } = micHarness(melody, { fail: new Error('Microphone access was not allowed.') })
    await playThrough(h)
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.ui.get().micStatus).toBe('Microphone access was not allowed.')
    expect(mic().disposed).toBe(true)
    h.session.setPlayThrough(false)
    expect(h.session.ui.get().micStatus).toBeNull()
  })

  it('without a piano: hands available, play-through on and locked, Start follows the microphone', async () => {
    // No Settings visit: the Follow choice is off (P22).
    const { h, mics, mic } = micHarness(melody, { follow: false })
    h.session.setInputAvailable(false)
    let ui = h.session.ui.get()
    expect(ui).toMatchObject({
      handsAvailable: true,
      hands: 'both',
      playThrough: true,
      playThroughLocked: true,
      follow: 'mic',
      pianoConnected: false,
      startAction: 'play',
      startEnabled: true,
      startReason: null,
      metronomeMuted: true,
    })
    // It cannot be switched off while a hand is selected.
    h.session.setPlayThrough(false)
    expect(h.session.ui.get().playThrough).toBe(true)
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    expect(mic().hands).toBe('both')
    ui = h.session.ui.get()
    expect(ui).toMatchObject({ playing: true, micStatus: 'Following through the microphone.' })
    mic().hear(0.26)
    h.frames.flush()
    expect(h.strip.targets).toEqual([2])
  })

  it('without a piano, Listen stays Listen and a hand chosen turns play-through back on', () => {
    const { h } = micHarness(melody, { follow: false })
    h.session.setInputAvailable(false)
    h.session.setSelection({ hands: 'none' })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ hands: 'none', playThrough: false, startAction: 'listen' })
    h.session.setSelection({ hands: 'left' })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ hands: 'left', playThrough: true, startAction: 'play' })
  })

  it('without a piano, Repeat and Keep time wait for one; both come back with it (U98)', () => {
    const { h } = micHarness(melody, { follow: false, selection: { range: { fromOcc: 0, toOcc: 0 } } })
    h.session.setRhythmMode(true)
    expect(h.session.ui.get()).toMatchObject({ repeat: true, rhythm: true })
    const saved = h.saves.length
    h.session.setInputAvailable(false)
    // Play-through takes over: Repeat closes (the loop is remembered), Keep time waits.
    expect(h.session.ui.get()).toMatchObject({ repeat: false, rhythm: false, playThrough: true })
    expect(h.saves.slice(saved).some((s) => s.patch.rhythm === false)).toBe(false)
    expect(h.saves.slice(saved).some((s) => s.patch.repeatOpen === false)).toBe(false)
    h.session.setRhythmMode(true)
    h.session.setRepeatMode(true)
    h.session.repeatFrom(1)
    expect(h.session.ui.get()).toMatchObject({ repeat: false, rhythm: false, playThrough: true })
    h.session.setInputAvailable(true)
    expect(h.session.ui.get()).toMatchObject({
      playThrough: false,
      rhythm: true,
      repeat: true,
      playThroughLocked: false,
    })
    expect(h.session.loop).toEqual({ fromOcc: 0, toOcc: 0 })
  })

  it('no piano and no microphone: the hands are held (Listen), as before', () => {
    const { h } = micHarness(melody, { supported: false })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get()).toMatchObject({
      handsAvailable: false,
      hands: 'none',
      playThrough: false,
      playThroughLocked: false,
      micSupported: false,
      follow: 'piano',
      startAction: 'listen',
    })
    h.session.setInputAvailable(true)
    expect(h.session.ui.get()).toMatchObject({ handsAvailable: true, hands: 'both' })
  })

  it('one hand with the microphone follows that hand only and plays nothing (DECISIONS P22)', async () => {
    const { h, mic } = micHarness(offBeats, { follow: false, selection: { hands: 'left' } })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get()).toMatchObject({ playThrough: true, startEnabled: true, hands: 'left' })
    await h.session.start()
    h.frames.flush()
    expect(mic().hands).toBe('left')
    expect(mic().started).toEqual(rat(1, 8))
    expect(h.session.ui.get().playing).toBe(true)
    // Notes are numbered in score order: the left hand's are the odd ones.
    expect(h.strip.targets).toEqual([1])
    // The left hand's second group, at 3/8, is reached exactly: its third (note 5) is next.
    mic().hear(0.375)
    h.frames.flush()
    expect(h.strip.targets).toEqual([5])
    h.step(4000)
    // No accompaniment: the right hand is never sent to the piano.
    expect(h.backend.ons()).toEqual([])
    expect(h.session.ui.get().metronomeMuted).toBe(true)
  })

  it('one hand with the microphone needs no verified output', () => {
    const { h } = micHarness(offBeats, { selection: { hands: 'right' } })
    h.session.updateSettings({ ...testSettings({ mic: { follow: true } }), route: { ...DEFAULT_SETTINGS.route } })
    h.session.setPlayThrough(true)
    expect(h.session.ui.get()).toMatchObject({ startAction: 'play', startEnabled: true, follow: 'mic' })
    h.session.updateSettings({ ...testSettings({ mic: { follow: false } }), route: { ...DEFAULT_SETTINGS.route } })
    expect(h.session.ui.get().startEnabled).toBe(false)
    expect(h.session.ui.get().startReason).toMatch(/verified output/)
  })

  it('a piano connecting mid play-through: the learner’s choice applies (off: back to reading there)', async () => {
    const { h, mic } = micHarness(melody, { follow: false })
    h.session.setInputAvailable(false)
    await h.session.start()
    mic().hear(0.26)
    h.frames.flush()
    h.session.setInputAvailable(true)
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get()).toMatchObject({ playThrough: false, playing: false, micStatus: null })
    expect(h.strip.targets).toEqual([2])
  })

  it('a piano connecting while play-through was chosen pauses it; Start follows the piano', async () => {
    const { h, mics, mic } = micHarness(melody, { follow: false })
    h.session.setPlayThrough(true)
    h.session.setInputAvailable(false)
    await h.session.start()
    mic().hear(0.26)
    h.frames.flush()
    h.session.setInputAvailable(true)
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get()).toMatchObject({ playThrough: true, playing: false, follow: 'piano' })
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    h.tap(64)
    h.frames.flush()
    expect(h.strip.targets).toEqual([3])
  })

  it('a piano unplugged during a play-through that followed it pauses; Start opens the microphone', async () => {
    const { h, mics, mic } = micHarness(melody, { follow: false })
    await playThrough(h)
    h.tap(60)
    h.frames.flush()
    h.midi.route({ kind: 'input-disconnected', port: { id: 'in-1', name: 'Piano' } as never })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get()).toMatchObject({ playing: false, playThrough: true, follow: 'mic' })
    expect(mics.length).toBe(0)
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    expect(mic().started).toEqual(rat(1, 4))
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('a piano unplugged while the microphone follows does not pause', async () => {
    const { h } = micHarness()
    await playThrough(h)
    h.midi.route({ kind: 'input-disconnected', port: { id: 'in-1', name: 'Piano' } as never })
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('a microphone that stops by itself pauses play-through with the reason; Start opens it again', async () => {
    const { h, mics, mic } = micHarness()
    await playThrough(h)
    mic().hear(0.26)
    h.frames.flush()
    mic().onLost('The microphone stopped. Press Start to listen again.')
    expect(mic().disposed).toBe(true)
    let ui = h.session.ui.get()
    expect(ui.playing).toBe(false)
    expect(ui.playThrough).toBe(true)
    expect(ui.micStatus).toBe('The microphone stopped. Press Start to listen again.')
    // A late word from the closed microphone changes nothing.
    mics[0]!.hear(0.8)
    mics[0]!.onLost('again')
    h.frames.flush()
    expect(h.strip.targets).toEqual([2])
    expect(h.session.ui.get().micStatus).toBe('The microphone stopped. Press Start to listen again.')
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(2)
    expect(mic().started).toEqual(rat(1, 2))
    ui = h.session.ui.get()
    expect(ui.playing).toBe(true)
    expect(ui.micStatus).toBe('Following through the microphone.')
  })

  it('ui.metronomeMuted: only in play-through with the microphone following (DECISIONS P16, P20)', async () => {
    const { h } = micHarness()
    expect(h.session.ui.get()).toMatchObject({ playThrough: false, metronomeMuted: false, metronomeScope: 'general' })
    h.session.setPlayThrough(true)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ playThrough: true, metronomeMuted: true, metronomeScope: 'general' })
    // One hand: the microphone follows that hand and the app plays nothing (P22).
    h.session.setSelection({ hands: 'right' })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ playThrough: true, metronomeMuted: true })
    h.session.setSelection({ hands: 'both' })
    h.frames.flush()
    expect(h.session.ui.get().metronomeMuted).toBe(true)
    h.session.updateSettings(testSettings({ mic: { follow: false } }))
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ playThrough: true, metronomeMuted: false })
    h.session.updateSettings(testSettings({ mic: { follow: true } }))
    h.session.setPlayThrough(false)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ playThrough: false, metronomeMuted: false })
  })

  it('the metronome is silent while the microphone follows', async () => {
    const clicks: number[] = []
    const mics: FakeMic[] = []
    const settings = (follow: boolean) => {
      const s = testSettings({ mic: { follow } })
      return { ...s, metronome: { ...s.metronome, enabled: true } }
    }
    class WebAudioMetronome {
      click(time: number): void {
        clicks.push(time)
      }
      cancel(): void {}
      setVolume(): void {}
      dispose(): void {}
    }
    const deps: Partial<SessionDeps> = {
      createMicFollower: (_model, onEstimate, onLost) => {
        const mic = new FakeMic(onEstimate, onLost)
        mics.push(mic)
        return mic
      },
      loadMetronome: async () => ({ WebAudioMetronome }) as unknown as MetronomeModule,
    }
    resetSharedAudioContext()
    sharedAudioContext(() => new FakeAudioContext() as unknown as AudioContext)
    try {
      const h = harness(melody, {}, { settings: settings(true), deps })
      await playThrough(h)
      // The clicks would come out of the device beside its own microphone.
      for (let k = 0; k < 4; k++) {
        mics[0]!.hear(k / 4 + 0.001)
        h.step(1000)
      }
      expect(clicks).toEqual([])
      // Following the piano instead (it pauses), the same play-through clicks.
      h.session.updateSettings(settings(false))
      await h.session.start()
      h.tap(67)
      h.step(1000)
      h.tap(69)
      h.step(1000)
      expect(clicks.length).toBeGreaterThan(0)
    } finally {
      resetSharedAudioContext()
    }
  })

  it('MIDI presses do not move the cursor while the microphone follows (DECISIONS P22)', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    h.tap(60)
    h.step(3000)
    expect(h.strip.targets).toEqual([0])
    expect(h.strip.cursor).toBe(0)
    mic().hear(0.001)
    h.frames.flush()
    expect(h.strip.targets).toEqual([1])
  })
})
