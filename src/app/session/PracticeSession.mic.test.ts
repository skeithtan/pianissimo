/**
 * The microphone follower in play-through (DECISIONS P15): the session opens it on Start, turns
 * its position estimates into gate releases, and closes it when play-through ends.
 */
import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import type { ScoreModel } from '../../core/model/score'
import { type Rational, ZERO, rat } from '../../core/music/rational'
import { harness, testSettings, type Harness } from './testkit'
import type { MetronomeModule } from '../../core/playback'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import { resetSharedAudioContext, sharedAudioContext } from '../../core/playback/webaudio/context'
import type { MicEstimate, MicFollowerLike, SessionDeps } from './types'

// Quarter = 60: one quarter (a quarter of a whole note) per second; group k at k/4.
const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
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

function micHarness(model: ScoreModel = melody, opts: { follow?: boolean; fail?: Error } = {}) {
  const mics: FakeMic[] = []
  const h = harness(
    model,
    {},
    {
      settings: testSettings({ mic: { follow: opts.follow ?? true } }),
      deps: {
        createMicFollower: (_model: ScoreModel, onEstimate, onLost) => {
          const mic = new FakeMic(onEstimate, onLost)
          if (opts.fail) mic.fail = opts.fail
          mics.push(mic)
          return mic
        },
      },
    },
  )
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

  it('an estimate at the end finishes the piece', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    mic().hear(5)
    h.step(6000)
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.ui.get().phase).toBe('completed')
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

  it('a speed change leaves the follower alone; hands other than both close the microphone', async () => {
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
    h.session.setSelection({ hands: 'right', multiplier: 0.8 })
    await h.session.start()
    expect(mics[0]!.disposed).toBe(true)
    expect(mics.length).toBe(1)
    expect(h.session.ui.get().micStatus).toBeNull()
  })

  it('leaving play-through closes the microphone and clears its status', async () => {
    const { h, mic } = micHarness()
    await playThrough(h)
    h.session.setPlayThrough(false)
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get().micStatus).toBeNull()
    expect(h.session.ui.get().playThrough).toBe(false)
  })

  it('turning the setting off mid-play closes the microphone; on again reopens it on Start', async () => {
    const { h, mics, mic } = micHarness()
    await playThrough(h)
    h.session.updateSettings(testSettings({ mic: { follow: false } }))
    expect(mic().disposed).toBe(true)
    expect(h.session.ui.get().playing).toBe(true)
    h.session.updateSettings(testSettings({ mic: { follow: true } }))
    await Promise.resolve()
    expect(mics.length).toBe(2)
    expect(mics[1]!.calls[0]).toBe('start')
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

  it('without a piano the hands stay available and only play-through can start', async () => {
    const { h, mics } = micHarness()
    h.session.setInputAvailable(false)
    let ui = h.session.ui.get()
    expect(ui.handsAvailable).toBe(true)
    expect(ui.hands).toBe('both')
    expect(ui.startEnabled).toBe(false)
    expect(ui.startReason).toContain('Play through follows the microphone')
    h.session.setPlayThrough(true)
    ui = h.session.ui.get()
    expect(ui.startAction).toBe('play')
    expect(ui.startEnabled).toBe(true)
    h.session.setSelection({ hands: 'right', multiplier: 1 })
    h.frames.flush()
    ui = h.session.ui.get()
    expect(ui.hands).toBe('right')
    expect(ui.startEnabled).toBe(false)
    expect(ui.startReason).toContain('both hands only')
    h.session.setSelection({ hands: 'both', multiplier: 1 })
    h.frames.flush()
    await h.session.start()
    h.frames.flush()
    expect(mics.length).toBe(1)
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('without the setting, no piano still holds the hands off', () => {
    const { h } = micHarness(melody, { follow: false })
    h.session.setInputAvailable(false)
    expect(h.session.ui.get().handsAvailable).toBe(false)
    expect(h.session.ui.get().hands).toBe('none')
    h.session.updateSettings(testSettings({ mic: { follow: true } }))
    expect(h.session.ui.get().handsAvailable).toBe(true)
    expect(h.session.ui.get().hands).toBe('both')
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
      // With the setting off the same play-through clicks.
      h.session.updateSettings(settings(false))
      h.tap(67)
      h.step(1000)
      h.tap(69)
      h.step(1000)
      expect(clicks.length).toBeGreaterThan(0)
    } finally {
      resetSharedAudioContext()
    }
  })

  it('MIDI presses still work alongside the microphone', async () => {
    const { h } = micHarness()
    await playThrough(h)
    h.tap(60)
    h.frames.flush()
    expect(h.strip.targets).toEqual([1])
    expect(rat(1, 4)).toEqual({ n: 1, d: 4 })
  })
})
