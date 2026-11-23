/**
 * The microphone in Follow (DECISIONS P15, P16, P22): the session opens it on Start, turns its
 * position estimates into gate releases, and closes it when Follow is left. Without a piano Follow
 * uses it; with one, the choice (`settings.mic.follow`) picks it.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import type { PracticeMode } from '../../core/model/practice'
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
  opts: {
    follow?: boolean
    fail?: Error
    supported?: boolean
    selection?: Partial<Selection>
    mode?: PracticeMode
  } = {},
) {
  const mics: FakeMic[] = []
  const h = harness(model, opts.selection ?? {}, {
    options: { mode: opts.mode ?? 'wait' },
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

async function follow(h: Harness): Promise<void> {
  h.session.setMode('follow')
  await h.session.start()
  h.frames.flush()
}

describe('Follow through the microphone', () => {
  it('Start opens the microphone at the first group and follows its estimates', async () => {
    const { h, mics, mic } = micHarness()
    await follow(h)
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
    await follow(h)
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
    await follow(h)
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
    await follow(h)
    mic().hear(0.51)
    h.frames.flush()
    expect(h.strip.targets).toEqual([3])
    expect(h.strip.cursor).toBeGreaterThanOrEqual(0.5)
    h.step(1500)
    expect(h.strip.cursor).toBeCloseTo(0.75)
  })

  it('an estimate at the end rewinds the piece and pauses the microphone follower', async () => {
    const { h, mic } = micHarness()
    await follow(h)
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
    await follow(h)
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
    await follow(h)
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

  it.each(['listen', 'wait', 'time'] as const)('changing to %s closes the microphone', async (mode) => {
    const { h, mic } = micHarness()
    await follow(h)
    mic().hear(0.26)
    h.step(500)
    h.session.setMode(mode)
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get()).toMatchObject({ mode, playing: false, micStatus: null })
    // A late word from it changes nothing.
    mic().hear(0.8)
    mic().onLost('gone')
    h.step(1000)
    expect(h.strip.cursor).toBeCloseTo(0.5)
    expect(h.session.ui.get()).toMatchObject({ mode, playing: false, micStatus: null })
  })

  it('changing mode while the microphone opens closes it once it has, and the new mode starts without it', async () => {
    const opened: (() => void)[] = []
    const { h, mics, mic } = micHarness()
    h.session.setMode('follow')
    const start = FakeMic.prototype.start
    FakeMic.prototype.start = async function (this: FakeMic) {
      this.calls.push('start')
      await new Promise<void>((resolve) => opened.push(resolve))
    }
    try {
      const first = h.session.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(mics).toHaveLength(1)
      expect(h.session.ui.get().micStatus).toBe('Starting the microphone…')
      h.session.setMode('wait')
      expect(mic().disposed).toBe(true)
      expect(h.session.ui.get()).toMatchObject({ mode: 'wait', micStatus: null })
      // The browser still asks for the microphone: Start here does not wait for the answer.
      await h.session.start()
      h.frames.flush()
      expect(h.session.ui.get()).toMatchObject({ mode: 'wait', activity: 'reading', playing: true })
      opened.forEach((resolve) => resolve())
      await first
      h.frames.flush()
      expect(mics).toHaveLength(1)
      expect(mic().calls).not.toContain('resume')
      expect(h.session.ui.get()).toMatchObject({ mode: 'wait', playing: true, micStatus: null })
    } finally {
      FakeMic.prototype.start = start
    }
  })

  it('back to Follow while the first microphone still opens: only the new one is used', async () => {
    const opened: (() => void)[] = []
    const { h, mics, mic } = micHarness()
    h.session.setMode('follow')
    const start = FakeMic.prototype.start
    FakeMic.prototype.start = async function (this: FakeMic) {
      this.calls.push('start')
      await new Promise<void>((resolve) => opened.push(resolve))
    }
    try {
      const first = h.session.start()
      await Promise.resolve()
      await Promise.resolve()
      h.session.setMode('listen')
      h.session.setMode('follow')
      const second = h.session.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(mics).toHaveLength(2)
      opened.forEach((resolve) => resolve())
      await Promise.all([first, second])
      h.frames.flush()
      expect(mics[0]!.disposed).toBe(true)
      expect(mics[0]!.calls).not.toContain('resume')
      expect(mic().calls).toEqual(['start', 'reset 0/1', 'resume'])
      expect(h.session.ui.get()).toMatchObject({ mode: 'follow', playing: true })
    } finally {
      FakeMic.prototype.start = start
    }
  })

  it('switching the source mid-play pauses: the next Start follows the new one (DECISIONS P22)', async () => {
    const { h, mics, mic } = micHarness()
    await follow(h)
    mic().hear(0.26)
    h.frames.flush()
    h.session.updateSettings(testSettings({ mic: { follow: false } }))
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get()).toMatchObject({ playing: false, mode: 'follow', follow: 'piano', micStatus: null })
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

  it('a microphone that cannot start leaves Follow stopped with the reason', async () => {
    const { h, mic } = micHarness(melody, { fail: new Error('Microphone access was not allowed.') })
    await follow(h)
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.ui.get().micStatus).toBe('Microphone access was not allowed.')
    expect(mic().disposed).toBe(true)
    h.session.setMode('wait')
    expect(h.session.ui.get().micStatus).toBeNull()
  })

  it('without a piano Follow uses the microphone, with no Settings visit (P22)', async () => {
    const { h, mics, mic } = micHarness(melody, { follow: false, mode: 'follow' })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get()).toMatchObject({
      mode: 'follow',
      hands: 'both',
      follow: 'mic',
      pianoConnected: false,
      micSupported: true,
      startAction: 'play',
      startEnabled: true,
      startReason: null,
      metronomeMuted: true,
    })
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    expect(mic().hands).toBe('both')
    expect(h.session.ui.get()).toMatchObject({ playing: true, micStatus: 'Following through the microphone.' })
    mic().hear(0.26)
    h.frames.flush()
    expect(h.strip.targets).toEqual([2])
  })

  it.each([
    ['wait', 'reading', 'Wait needs a connected piano.'],
    ['time', 'scored', 'Keep time needs a connected piano.'],
  ] as const)(
    'without a piano %s stays chosen and blocked, whatever the microphone can do',
    async (mode, action, reason) => {
      const { h, mics } = micHarness(melody, { follow: true, mode })
      const saves = h.saves.length
      h.session.setInputAvailable(false)
      expect(h.session.ui.get()).toMatchObject({
        mode,
        hands: 'both',
        startAction: action,
        startEnabled: false,
        startReason: reason,
      })
      await h.session.start()
      h.frames.flush()
      expect(mics).toHaveLength(0)
      h.session.setSelection({ hands: 'right' })
      h.session.setInputAvailable(true)
      expect(h.session.ui.get()).toMatchObject({ mode, hands: 'right', playing: false, startReason: null })
      expect(h.saves.slice(saves).some((s) => s.patch.mode !== undefined)).toBe(false)
    },
  )

  it('no piano and no microphone: Follow says it needs one of the two; Listen still plays', async () => {
    const { h } = micHarness(melody, { supported: false, mode: 'follow' })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get()).toMatchObject({
      mode: 'follow',
      hands: 'both',
      micSupported: false,
      follow: 'piano',
      startAction: 'play',
      startEnabled: false,
      startReason: 'Follow needs a connected piano or a microphone.',
    })
    h.session.setMode('listen')
    expect(h.session.ui.get()).toMatchObject({ mode: 'listen', startAction: 'listen', startEnabled: true })
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('one hand with the microphone follows that hand only and plays nothing (DECISIONS P22)', async () => {
    const { h, mic } = micHarness(offBeats, { follow: false, selection: { hands: 'left' }, mode: 'follow' })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', startEnabled: true, hands: 'left' })
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
    h.session.setMode('follow')
    expect(h.session.ui.get()).toMatchObject({ startAction: 'play', startEnabled: true, follow: 'mic' })
    h.session.updateSettings({ ...testSettings({ mic: { follow: false } }), route: { ...DEFAULT_SETTINGS.route } })
    expect(h.session.ui.get()).toMatchObject({ startEnabled: false, otherHand: { piano: true } })
  })

  it('a piano connecting while the microphone follows pauses it; Start follows the piano from there', async () => {
    const { h, mics, mic } = micHarness(melody, { follow: false, mode: 'follow' })
    h.session.setInputAvailable(false)
    await h.session.start()
    mic().hear(0.26)
    h.frames.flush()
    h.session.setInputAvailable(true)
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', playing: false, follow: 'piano', micStatus: null })
    expect(h.strip.targets).toEqual([2])
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    h.tap(64)
    h.frames.flush()
    expect(h.strip.targets).toEqual([3])
  })

  it('a piano unplugged while Follow follows it pauses; Start opens the microphone', async () => {
    const { h, mics, mic } = micHarness(melody, { follow: false })
    await follow(h)
    h.tap(60)
    h.frames.flush()
    h.midi.route({ kind: 'input-disconnected', port: { id: 'in-1', name: 'Piano' } as never })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get()).toMatchObject({ playing: false, mode: 'follow', follow: 'mic' })
    expect(mics.length).toBe(0)
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    expect(mic().started).toEqual(rat(1, 4))
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('a piano unplugged while the microphone follows does not pause', async () => {
    const { h } = micHarness()
    await follow(h)
    h.midi.route({ kind: 'input-disconnected', port: { id: 'in-1', name: 'Piano' } as never })
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('a microphone that stops by itself pauses Follow with the reason; Start opens it again', async () => {
    const { h, mics, mic } = micHarness()
    await follow(h)
    mic().hear(0.26)
    h.frames.flush()
    mic().onLost('The microphone stopped. Press Start to listen again.')
    expect(mic().disposed).toBe(true)
    let ui = h.session.ui.get()
    expect(ui.playing).toBe(false)
    expect(ui.mode).toBe('follow')
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

  it('ui.metronomeMuted: only in Follow with the microphone following (DECISIONS P16, P20)', () => {
    const { h } = micHarness()
    expect(h.session.ui.get()).toMatchObject({ mode: 'wait', metronomeMuted: false, metronomeScope: 'general' })
    h.session.setMode('follow')
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', metronomeMuted: true, metronomeScope: 'general' })
    // One hand: the microphone follows that hand and the app plays nothing (P22).
    h.session.setSelection({ hands: 'right' })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', metronomeMuted: true })
    h.session.updateSettings(testSettings({ mic: { follow: false } }))
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ mode: 'follow', metronomeMuted: false })
    h.session.updateSettings(testSettings({ mic: { follow: true } }))
    for (const mode of ['listen', 'wait', 'time'] as const) {
      h.session.setMode(mode)
      h.frames.flush()
      expect(h.session.ui.get()).toMatchObject({ mode, metronomeMuted: false })
    }
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
      await follow(h)
      // The clicks would come out of the device beside its own microphone.
      for (let k = 0; k < 4; k++) {
        mics[0]!.hear(k / 4 + 0.001)
        h.step(1000)
      }
      expect(clicks).toEqual([])
      // Following the piano instead (it pauses), it clicks.
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
    await follow(h)
    h.tap(60)
    h.step(3000)
    expect(h.strip.targets).toEqual([0])
    expect(h.strip.cursor).toBe(0)
    mic().hear(0.001)
    h.frames.flush()
    expect(h.strip.targets).toEqual([1])
  })
})
