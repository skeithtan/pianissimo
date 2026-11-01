import { describe, expect, it, vi } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { sharedAudioContext, type BrowserAudioModule } from '../../core/playback'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import { resetSharedAudioContext } from '../../core/playback/webaudio/context'
import { RecordingBackend } from '../../core/playback/testkit'
import type { ScoreModel } from '../../core/model/score'
import type { Spelling } from '../../core/music/pitch'
import { rat } from '../../core/music/rational'
import { FakeStrip, harness, testSettings, type Harness } from './testkit'

/** The octave cue's direction, or null when no octave cue shows. */
function octaveCue(h: Harness): 'up' | 'down' | null {
  const cue = h.session.feedback.get().cue
  return cue?.kind === 'octave' ? cue.direction : null
}

/** Respell notes (by index) and optionally give them a key signature, as an imported score would. */
function respell(model: ScoreModel, spellings: Record<number, Spelling>, keyFifths = 0): ScoreModel {
  return {
    ...model,
    notes: model.notes.map((n) => ({
      ...n,
      sounding: spellings[n.index] ?? n.sounding,
      accidentalContext: { ...n.accidentalContext, keyFifths },
    })),
  }
}

/** Two bars of quarters: right hand C D E F | G A B C, left hand C3 on each downbeat. */
const melody = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
    { at: 2, midi: 64 },
    { at: 3, midi: 65 },
    { at: 4, midi: 67 },
    { at: 5, midi: 69 },
    { at: 6, midi: 71 },
    { at: 7, midi: 72 },
  ],
  bars: 2,
})

const twoHands = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 1, midi: 62 },
    { at: 2, midi: 64 },
    { at: 3, midi: 65 },
    { at: 0, midi: 48, hand: 'L' },
    { at: 2, midi: 43, hand: 'L' },
  ],
  bars: 1,
  tempo: { bpm: 60 },
})

describe('PracticeSession: reading (both hands)', () => {
  it('starts paused, reads from the first group on Start and follows correct presses', async () => {
    const h = harness(melody)
    expect(h.session.ui.get().activity).toBe('idle')
    expect(h.session.ui.get().startAction).toBe('reading')
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().activity).toBe('reading')
    expect(h.session.ui.get().playing).toBe(true)
    expect(h.strip.targets).toEqual([0])
    h.tap(60)
    expect(h.strip.targets).toEqual([1])
    expect(h.strip.cursor).toBeCloseTo(0) // the next target is ahead until its time
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    h.play(62, 64)
    expect(h.session.progress.get().occ).toBe(0)
    h.play(65)
    h.step(1000)
    expect(h.session.progress.get().occ).toBe(1)
  })

  it('flashes once per frame on wrong keys and pulses the local marker', async () => {
    const h = harness(melody)
    await h.session.start()
    h.frames.flush()
    h.midi.on(61, h.clock.now)
    h.midi.on(63, h.clock.now)
    expect(h.flash.hits).toHaveLength(0) // nothing visual inside the input handler
    h.frames.flush()
    expect(h.flash.hits).toHaveLength(1)
    expect(h.strip.pulses).toBe(1)
    expect(h.strip.wrongMarker).toBe(true)
    expect(h.session.feedback.get()).toMatchObject({ visible: true, reason: 'wrong' })
    h.tap(60)
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.session.feedback.get().visible).toBe(false)
  })

  it('never publishes UI state per MIDI event (one frame for a burst)', async () => {
    const h = harness(melody)
    await h.session.start()
    h.frames.flush()
    const before = h.session.ui.emissions
    const progressBefore = h.session.progress.emissions
    for (const n of [60, 62, 64, 65, 67]) {
      h.midi.on(n, h.clock.now)
      h.midi.off(n, h.clock.now)
    }
    expect(h.frames.pending).toBe(1)
    expect(h.session.ui.emissions - before).toBe(0)
    h.frames.flush()
    expect(h.session.ui.emissions - before).toBeLessThanOrEqual(1)
    expect(h.session.progress.emissions - progressBefore).toBeLessThanOrEqual(1)
    expect(h.strip.targets).toEqual([1]) // bursts cannot skip the musical timing
  })

  it('applies strip changes inside its own frame, not one frame later (PF2)', async () => {
    const h = harness(melody)
    await h.session.start()
    h.frames.flush()
    const flushes = h.strip.flushes
    h.midi.on(60, h.clock.now)
    h.midi.off(60, h.clock.now)
    expect(h.strip.flushes).toBe(flushes) // never in the input handler
    h.frames.flush()
    expect(h.strip.flushes).toBe(flushes + 1)
  })

  it('pause keeps progress and saves the resume position; Start resumes', async () => {
    const h = harness(melody)
    await h.session.start()
    h.play(60, 62)
    h.session.pause()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(false)
    const resume = h.saves.filter((s) => s.patch.resume).at(-1)
    expect(resume?.immediate).toBe(true)
    expect(resume?.patch.resume?.group).toBe(2)
    await h.session.start()
    h.frames.flush()
    expect(h.strip.targets).toEqual([2])
  })

  it('a tap on a bar seeks while reading', async () => {
    const h = harness(melody)
    h.session.seek(1)
    h.frames.flush()
    expect(h.strip.targets).toEqual([4])
    expect(h.strip.cursor).toBeCloseTo(1)
  })

  it('starts at a stored resume position', () => {
    const h = harness(melody, {}, { options: { startPosition: melody.notes[5]!.onset } })
    expect(h.strip.targets).toEqual([5])
  })
})

describe('PracticeSession: continuous practice timing', () => {
  it('moves at tempo between onsets and holds for every missing chord pitch without sound output', async () => {
    let audioLoads = 0
    const h = harness(
      twoHands,
      {},
      {
        deps: {
          loadBrowserAudio: async () => {
            audioLoads++
            throw new Error('Both-hands practice does not need a sound backend')
          },
        },
      },
    )
    h.midi.out = null
    await h.session.start()
    h.step(1000)
    expect(h.strip.cursor).toBe(0)
    h.tap(60)
    h.step(1000)
    expect(h.strip.cursor).toBe(0) // C3 is still missing from the opening chord
    h.tap(48)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    expect(h.session.progress.get().position).toBeCloseTo(0.125)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.25)
    h.step(3000)
    h.tap(63)
    expect(h.strip.cursor).toBeCloseTo(0.25)
    h.tap(62)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.375)
    expect(audioLoads).toBe(0)
    expect(h.backend.ons()).toEqual([])
  })

  it('an early press within the grace fast-forwards: the accepted note snaps under the cursor', async () => {
    const h = harness(melody)
    await h.session.start()
    h.tap(60)
    h.step(950)
    h.tap(62)
    expect(h.session.engine.state.groupIndex).toBe(2)
    h.frames.flush()
    expect(h.strip.cursor).toBeCloseTo(0.25)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.375)
  })

  it('keeps the flowing position through pause and resume, and saves without pausing when hidden', async () => {
    const h = harness(melody)
    await h.session.start()
    h.tap(60)
    h.step(500)
    h.session.pause()
    h.step(1000)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    await h.session.start()
    h.step(250)
    expect(h.strip.cursor).toBeCloseTo(0.1875)
    h.session.suspend()
    expect(h.saves.at(-1)?.immediate).toBe(true)
    h.step(250)
    expect(h.strip.cursor).toBeCloseTo(0.25)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.ui.get().interruption).toBeNull()
  })

  it('restarts the flow from the opening gate, including after the whole piece finishes', async () => {
    const score = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 1, midi: 62 },
      ],
      bars: 1,
    })
    const h = harness(score)
    await h.session.start()
    h.tap(60)
    h.step(500)
    h.session.restart()
    h.frames.flush()
    expect(h.strip.cursor).toBe(0)
    h.play(60, 62)
    h.step(3000)
    expect(h.strip.cursor).toBe(1)
    await h.session.start()
    h.frames.flush()
    expect(h.strip.cursor).toBe(0)
    expect(h.session.engine.state.transportGate).toBe(0)
  })

  it('changes reading speed without jumping to the upcoming target, including while paused', async () => {
    const h = harness(melody)
    await h.session.start()
    h.tap(60)
    h.step(500)
    h.session.setSelection({ multiplier: 0.5 })
    h.frames.flush()
    expect(h.strip.cursor).toBeCloseTo(0.125)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.1875)
    h.session.pause()
    h.session.setSelection({ multiplier: 1 })
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.1875)
    await h.session.start()
    h.step(250)
    expect(h.strip.cursor).toBeCloseTo(0.25)
    h.tap(62)
    expect(h.session.engine.state.groupIndex).toBe(2)
  })

  it('seeks a running flow to the requested onset and waits for its keys there', async () => {
    const h = harness(melody)
    await h.session.start()
    h.tap(60)
    h.step(500)
    h.session.seek(1)
    h.step(500)
    expect(h.strip.cursor).toBe(1)
    expect(h.session.engine.state.groupIndex).toBe(4)
    h.tap(67)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(1.125)
  })

  it('ignores loss of a previously used output during silent both-hand practice', async () => {
    const h = harness(melody, { hands: 'none' })
    await h.session.start()
    h.session.setSelection({ hands: 'both' })
    await h.session.start()
    h.tap(60)
    h.step(250)
    const port = {
      id: 'out-1',
      name: 'Piano',
      manufacturer: null,
      state: 'disconnected' as const,
      connection: 'closed',
    }
    h.midi.out = null
    h.midi.route({ kind: 'output-disconnected', port: port as never })
    h.step(250)
    expect(h.strip.cursor).toBeCloseTo(0.125)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.ui.get().soundStatus).toBeNull()
    expect(h.session.ui.get().interruption).toBeNull()
  })

  it('can enable the metronome after starting without rebuilding or moving the score', async () => {
    resetSharedAudioContext()
    const audio = new FakeAudioContext()
    sharedAudioContext(() => audio as unknown as AudioContext)
    let loads = 0
    const metronomeModule = await import('../../core/playback/webaudio/metronome')
    const settings = testSettings()
    const h = harness(
      melody,
      {},
      {
        deps: {
          loadMetronome: async () => {
            loads++
            return metronomeModule
          },
        },
      },
    )
    try {
      await h.session.start()
      h.tap(60)
      h.step(500)
      expect(loads).toBe(0)
      h.session.updateSettings({ ...settings, metronome: { ...settings.metronome, enabled: true } })
      await Promise.resolve() // let the lazy metronome sink attach
      expect(loads).toBe(1)
      h.frames.flush()
      expect(h.strip.cursor).toBeCloseTo(0.125)
      h.step(500)
      h.tap(62) // the click at the learner's onset sounds with the press
      expect(audio.oscillators).toHaveLength(1)
      h.session.updateSettings(settings)
      h.step(1000)
      h.tap(64)
      expect(audio.oscillators).toHaveLength(1)
    } finally {
      h.session.dispose()
      resetSharedAudioContext()
    }
  })

  it('keeps Listen running when the page is hidden', async () => {
    const h = harness(melody, { hands: 'none' })
    await h.session.start()
    h.step(500)
    h.session.suspend()
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.25)
    expect(h.session.ui.get().playing).toBe(true)
    expect(h.session.ui.get().interruption).toBeNull()
  })
})

describe('PracticeSession: octave correction', () => {
  it('points toward the matching octave, clears on an unrelated error, and clears after success', async () => {
    const h = harness(melody)
    await h.session.start()
    h.tap(48)
    expect(octaveCue(h)).toBe('up')
    h.tap(72)
    expect(octaveCue(h)).toBe('down')
    h.tap(63)
    expect(h.session.feedback.get().cue).toBeNull()
    h.tap(48)
    expect(octaveCue(h)).toBe('up')
    h.tap(60)
    expect(h.session.feedback.get().cue).toBeNull()
    h.step(200)
    h.tap(62)
    expect(h.session.engine.state.lastWrongReason).toBe('early')
    expect(h.session.feedback.get().cue).toBeNull()
  })

  it('clears the octave arrow as soon as its target is accepted while the rest of the chord is missing', async () => {
    const chord = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 0, midi: 64 },
      ],
    })
    const h = harness(chord)
    await h.session.start()
    h.tap(72)
    expect(octaveCue(h)).toBe('down')
    h.tap(60)
    expect(h.session.engine.state.missingPitches).toEqual([64])
    expect(h.session.feedback.get().cue).toBeNull()
  })

  it('uses the nearest missing chord pitch and breaks an equal-distance tie toward the lower target', async () => {
    const chord = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 0, midi: 84 },
      ],
    })
    const h = harness(chord)
    await h.session.start()
    h.tap(72)
    expect(octaveCue(h)).toBe('down')
    h.tap(60)
    h.tap(72)
    expect(octaveCue(h)).toBe('up')
    h.session.pause()
    h.frames.flush()
    expect(h.session.feedback.get().cue).toBeNull()
  })
})

describe('PracticeSession: accidental correction', () => {
  /** F♯4 then A4. */
  const sharp = buildScore({
    notes: [
      { at: 0, midi: 66 },
      { at: 1, midi: 69 },
    ],
  })

  it('names a sharp target with its accidental when the natural key of the same letter is pressed', async () => {
    const h = harness(sharp)
    await h.session.start()
    h.tap(65)
    expect(h.session.feedback.get().cue).toEqual({ kind: 'accidental', text: 'F♯4', accidental: '♯' })
    // The same cue object while nothing changes (the view store does not re-render per frame).
    const before = h.session.feedback.get()
    h.step(16)
    expect(h.session.feedback.get()).toBe(before)
    // G is a semitone above F♯ but another letter: not an accidental slip.
    h.tap(67)
    expect(h.session.feedback.get().cue).toBeNull()
    h.tap(65)
    expect(h.session.feedback.get().cue).toMatchObject({ kind: 'accidental' })
    h.tap(66)
    expect(h.session.feedback.get().cue).toBeNull()
  })

  it('shows ♮ for a natural target pressed on the black key of either neighbor spelling', async () => {
    const naturals = buildScore({
      notes: [
        { at: 0, midi: 65 },
        { at: 1, midi: 67 },
      ],
    })
    const h = harness(naturals)
    await h.session.start()
    h.tap(66) // F♯ / G♭ for F
    expect(h.session.feedback.get().cue).toEqual({ kind: 'accidental', text: 'F♮4', accidental: '♮' })
    h.tap(64) // E for F: another letter
    expect(h.session.feedback.get().cue).toBeNull()
    h.tap(65)
    h.step(1000)
    h.tap(66) // F♯ / G♭ for G
    expect(h.session.feedback.get().cue).toEqual({ kind: 'accidental', text: 'G♮4', accidental: '♮' })
  })

  it('follows the score spelling and the naming settings: G♭ for G, F♯ in G major, fixed do', async () => {
    const flat = respell(
      buildScore({
        notes: [
          { at: 0, midi: 66 },
          { at: 1, midi: 66 },
        ],
      }),
      { 0: { step: 'G', alter: -1, octave: 4 } },
    )
    const h = harness(flat)
    await h.session.start()
    h.tap(65) // F for G♭: another letter
    expect(h.session.feedback.get().cue).toBeNull()
    h.tap(67)
    expect(h.session.feedback.get().cue).toEqual({ kind: 'accidental', text: 'G♭4', accidental: '♭' })

    // In G major with key-implied accidentals hidden the label reads "F4"; the cue still shows ♯.
    const settings = testSettings({
      naming: { ...DEFAULT_SETTINGS.naming, alwaysShowEffectiveAccidentals: false, system: 'fixed-do' },
    })
    const g = harness(respell(sharp, {}, 1), {}, { settings })
    await g.session.start()
    expect(g.session.labelTexts.get(0)).toBe('fa4')
    g.tap(65)
    expect(g.session.feedback.get().cue).toEqual({ kind: 'accidental', text: 'fa♯4', accidental: '♯' })
  })

  it('a right pitch too early clears the cue and shows no accidental hint', async () => {
    const h = harness(twoHands, { hands: 'right', range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.tap(60)
    h.tap(59) // B for D: unrelated
    expect(h.session.feedback.get().cue).toBeNull()
    h.tap(61) // C♯ / D♭ for D: an accidental slip
    expect(h.session.feedback.get().cue).toEqual({ kind: 'accidental', text: 'D♮4', accidental: '♮' })
    h.step(200)
    h.tap(62)
    expect(h.session.engine.state.lastWrongReason).toBe('early')
    expect(h.session.feedback.get().cue).toBeNull()
  })
})

describe('PracticeSession: scored attempts', () => {
  it('prepares, waits in Ready, starts the clock on the first press and records the attempt', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } })
    expect(h.session.ui.get().startAction).toBe('scored')
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.loopEditable).toBe(true)
    h.step(500)
    h.tap(60)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.strip.loopEditable).toBe(false)
    expect(h.strip.browse).toBe(false)
    h.step(1000)
    h.tap(62)
    h.step(1000)
    h.tap(64)
    h.step(1000)
    h.tap(65)
    // Finish the notated tail before preparing the next pass.
    h.step(1000)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.attempts).toHaveLength(1)
    const record = h.attempts[0]!
    expect(record.kind).toBe('scored')
    expect(record.completion).toBe('completed')
    expect(record.completionTimeSec).toBeCloseTo(3)
    expect(record.passed).toBe(true)
    expect(h.session.ui.get().lastResult).toMatchObject({ passed: true, wrongAttacks: 0, streak: 1 })
  })

  it('Repeat resets to Ready only after the keys are released', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } })
    h.session.setRepeatTarget(2)
    await h.session.start()
    h.play(60, 62, 64)
    h.step(1000)
    h.press(65) // final key held
    h.step(1000) // the tail finishes before readiness is checked
    expect(h.attempts).toHaveLength(1)
    expect(h.session.engine.state.phase).toBe('preparing')
    expect(h.session.ui.get().waiting).toBe('Release the keys to begin.')
    h.release(65)
    expect(h.session.engine.state.phase).toBe('ready')
    h.play(60, 62, 64, 65)
    expect(h.attempts).toHaveLength(2)
    // Target of two consecutive passes reached: no further pass starts; Repeat mode stays open.
    expect(h.session.ui.get().lastResult?.targetReached).toBe(true)
    expect(h.session.ui.get().repeat).toBe(true)
    expect(h.session.engine.state.phase).toBe('completed')
    expect(h.saves.some((x) => x.patch.repeatTarget === 2)).toBe(true)
  })

  it('a tempo change during a scored attempt interrupts it and prepares a new context', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.tap(60, 61)
    h.session.setSelection({ multiplier: 0.5 })
    h.frames.flush()
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'tempo-change' })
    h.step(300) // the automatic hint shown after the wrong 61 fades before Ready
    expect(h.session.engine.state.phase).toBe('ready')
    h.play(60, 62, 64, 65)
    expect(h.attempts[1]!.context.multiplier).toBe(0.5)
    expect(h.attempts[1]!.contextKey).not.toBe(h.attempts[0]!.contextKey)
    expect(h.saves.some((s) => s.patch.lastMultiplier === 0.5)).toBe(true)
  })

  it('pausing a scored attempt interrupts it (no completed or failed result) without a banner', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.play(60, 62)
    h.session.pause()
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'pause', passed: false })
    // No "Paused" banner: the main button reads Start again.
    expect(h.session.ui.get()).toMatchObject({ interruption: null, playing: false, startAction: 'scored' })
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('zoom or orientation never interrupts a running attempt (P5 revised)', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.tap(60)
    h.session.viewChanged()
    h.frames.flush()
    expect(h.attempts).toHaveLength(0)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.ui.get().interruption).toBeNull()
  })

  it('wraps the strip back to the loop start when a Repeat pass starts over', async () => {
    const h = harness(melody, { range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.frames.flush()
    expect(h.strip.wrappedTo).toBeNull()
    h.play(67, 69, 71, 72)
    h.step(1000)
    expect(h.attempts).toHaveLength(1)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.wraps).toBe(1)
    expect(h.strip.wrappedTo).toBeCloseTo(1) // bar 2 starts one whole note in
    expect(h.strip.cursor).toBeCloseTo(1)
  })

  it('seeking during a running attempt interrupts it; in Ready a tap on the loop start is ignored', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.session.seek(0)
    expect(h.session.engine.state.phase).toBe('ready')
    h.tap(60)
    h.session.seek(0)
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'seek' })
  })

  it('keeps a scored attempt running when the page is hidden', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.tap(60)
    h.session.suspend()
    expect(h.attempts).toHaveLength(0)
    expect(h.session.engine.state.phase).toBe('running')
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.125)
  })

  it('an open overlay pauses the attempt and keeps keys from the engine until it closes', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.tap(60)
    h.session.holdInput(true)
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'pause' })
    const before = h.session.engine.state.version
    h.play(62, 64)
    h.press(65)
    expect(h.session.engine.state.version).toBe(before)
    h.session.holdInput(false)
    h.session.restart()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('a disconnected input interrupts the attempt and the reconnect resets physical state', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.press(60)
    const port = { id: 'in-1', name: 'Piano', manufacturer: null, state: 'disconnected' as const, connection: 'closed' }
    h.midi.route({ kind: 'input-disconnected', port: port as never })
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'disconnect' })
    expect(h.session.ui.get().inputDisconnected).toBe(true)
    h.midi.route({ kind: 'input-reconnected', port: port as never })
    h.frames.flush()
    expect(h.session.ui.get().inputDisconnected).toBe(false)
    h.session.restart()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('Restart during a running attempt is a user restart (abandon after wrong notes)', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.tap(60, 61)
    h.session.restart()
    expect(h.attempts[0]).toMatchObject({ completion: 'abandoned', interruptReason: 'user-restart' })
    expect(h.abandons).toHaveLength(1)
  })

  it('disables scored practice with an explanation when the passage has no notes for the hand', () => {
    const score = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 4, midi: 48, hand: 'L' },
      ],
      bars: 2,
    })
    const h = harness(score, { hands: 'left', range: { fromOcc: 0, toOcc: 0 } })
    expect(h.session.ui.get().startEnabled).toBe(false)
    expect(h.session.ui.get().startReason).toMatch(/no notes/)
  })
})

describe('PracticeSession: one-hand accompaniment', () => {
  it('plays the other hand, waits at the learner gate and releases it on completion', async () => {
    const h = harness(twoHands, { hands: 'right', range: { fromOcc: 0, toOcc: 0 } })
    expect(h.strip.subdued).toBe('L')
    expect(h.strip.automatic.length).toBe(2)
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    // Ready: the transport holds at the first learner onset; the automatic C3 written there
    // sounds with the learner's press, not before.
    h.clock.advance(20)
    expect(h.backend.ons().map((c) => c.note)).not.toContain(48)
    h.step(3000)
    expect(h.backend.ons().map((c) => c.note)).not.toContain(43)
    h.tap(60)
    expect(h.backend.ons().map((c) => c.note)).toContain(48)
    expect(h.session.engine.state.phase).toBe('running')
    h.step(950)
    h.tap(62) // quarter = 1 s: the transport reaches beat 2 within the 120 ms grace
    h.step(1000)
    h.frames.flush()
    // G2 is written at the learner's beat 3: it waits for that press.
    expect(h.backend.ons().map((c) => c.note)).not.toContain(43)
    h.tap(64)
    expect(h.backend.ons().map((c) => c.note)).toContain(43)
  })

  it('a correct press long before its gate is "Too early": a soft flash and the amber marker', async () => {
    const h = harness(twoHands, { hands: 'right', range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.tap(60)
    h.step(200)
    h.tap(62) // gate is ~800 ms away
    expect(h.session.engine.state.lastWrongReason).toBe('early')
    expect(h.session.feedback.get()).toMatchObject({ visible: true, reason: 'early' })
    expect(h.strip.pulses).toBe(0) // no local "Wrong key" marker for a right pitch played early
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.strip.earlyMarker).toBe(true)
    expect(h.flash.hits).toHaveLength(1)
    expect(h.flash.hits[0]?.soft).toBe(true)
    // A wrong pitch afterwards is the full feedback: red marker, full flash.
    h.tap(70)
    expect(h.strip.earlyMarker).toBe(false)
    expect(h.strip.wrongMarker).toBe(true)
    expect(h.flash.hits.at(-1)?.soft).toBe(false)
    expect(h.strip.pulses).toBe(1)
  })

  it('the early marker clears when the group completes and on restart', async () => {
    const h = harness(twoHands, { hands: 'right', range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.tap(60)
    h.step(200)
    h.tap(62)
    expect(h.strip.earlyMarker).toBe(true)
    h.play(62)
    expect(h.strip.earlyMarker).toBe(false)
    h.step(200)
    h.tap(64)
    expect(h.strip.earlyMarker).toBe(true)
    h.session.restart()
    h.frames.flush()
    expect(h.strip.earlyMarker).toBe(false)
  })

  it('refuses graded one-hand practice on an unverified or echoing route', () => {
    const settings = testSettings({
      route: { ...DEFAULT_SETTINGS.route, outputId: 'out-1', outputVerified: true, echo: 'echo-detected' },
    })
    const h = harness(twoHands, { hands: 'right' }, { settings })
    expect(h.session.ui.get().startEnabled).toBe(false)
    expect(h.session.ui.get().startReason).toMatch(/echo/)
  })

  it('forwards human input to the MIDI backend guard', async () => {
    const h = harness(twoHands, { hands: 'right', range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.tap(60)
    expect(h.backend.human.map((e) => e.kind)).toEqual(['noteon', 'noteoff'])
  })

  it('Stop sound stops app playback and interrupts the accompanied attempt', async () => {
    const h = harness(twoHands, { hands: 'right', range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.tap(60)
    for (const owner of h.midi.owners) owner()
    h.frames.flush()
    expect(h.backend.calls.some((c) => c.op === 'stopSound')).toBe(true)
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted' })
  })
})

describe('PracticeSession: Preview', () => {
  it('Listen plays both parts without an engine attempt and moves the cursor with the transport', async () => {
    const h = harness(twoHands, { hands: 'none' })
    expect(h.session.ui.get().startAction).toBe('listen')
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get().activity).toBe('listening')
    h.step(1500)
    expect(h.strip.cursor).toBeGreaterThan(0.3)
    expect(
      h.backend
        .ons()
        .map((c) => c.note)
        .sort(),
    ).toEqual(expect.arrayContaining([48, 60, 62]))
    h.session.pause()
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(false)
    // A hand back on leaves Listen and returns to practice, without starting.
    h.session.setSelection({ hands: 'both' })
    h.frames.flush()
    expect(h.session.ui.get().activity).toBe('idle')
    expect(h.session.ui.get()).toMatchObject({ startAction: 'reading', playing: false })
    expect(h.attempts).toHaveLength(0)
  })

  it('both hands off is Listen mode at once: no targets, Start becomes Listen, nothing plays by itself', async () => {
    const h = harness(twoHands)
    expect(h.strip.targets.length).toBeGreaterThan(0)
    h.session.setSelection({ hands: 'none' })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({
      startAction: 'listen',
      startEnabled: true,
      playing: false,
      activity: 'idle',
    })
    expect(h.strip.targets).toEqual([])
    expect(h.backend.ons()).toHaveLength(0)
    await h.session.start()
    h.step(500)
    expect(h.session.ui.get()).toMatchObject({ activity: 'listening', playing: true })
    h.session.setSelection({ hands: 'right' })
    h.step(500)
    expect(h.session.ui.get()).toMatchObject({
      activity: 'idle',
      playing: false,
      hands: 'right',
      startAction: 'reading',
    })
    expect(h.strip.targets.length).toBeGreaterThan(0)
  })

  it('Listen plays both hands: there is no part filter (U12)', async () => {
    const h = harness(twoHands, { hands: 'none' })
    await h.session.start()
    h.step(3500)
    expect(h.backend.ons().map((c) => c.note)).toEqual(expect.arrayContaining([60, 48]))
  })
})

describe('PracticeSession: sound destination Auto (S4)', () => {
  function deviceSound() {
    const backend = Object.assign(new RecordingBackend(() => 0), { monitor: vi.fn(), dispose: vi.fn() })
    const load = vi.fn(async () => ({ createBrowserAudio: () => backend }) as unknown as BrowserAudioModule)
    return { backend, load }
  }

  it('plays Listen through this device when no piano output is there, with no note', async () => {
    const sound = deviceSound()
    const h = harness(twoHands, { hands: 'none' }, { deps: { loadBrowserAudio: sound.load, hasWebAudio: () => true } })
    h.midi.out = null // no Web MIDI, no permission, or nothing connected
    h.session.updateSettings(testSettings())
    expect(h.session.ui.get()).toMatchObject({ startAction: 'listen', startEnabled: true })
    await h.session.start()
    h.step(1500)
    expect(sound.load).toHaveBeenCalledOnce()
    expect(sound.backend.ons().map((c) => c.note)).toEqual(expect.arrayContaining([48, 60]))
    expect(h.session.ui.get()).toMatchObject({ activity: 'listening', soundStatus: null })
    // Back to practice and to Listen again: the device sound stays loaded (loaded once).
    h.session.setSelection({ hands: 'both' })
    h.frames.flush()
    h.session.setSelection({ hands: 'none' })
    await h.session.start()
    h.step(500)
    expect(sound.load).toHaveBeenCalledOnce()
    expect(h.session.ui.get().playing).toBe(true)
  })

  it('plays the one-hand accompaniment through this device without a piano, graded (P2)', async () => {
    const sound = deviceSound()
    const h = harness(twoHands, { hands: 'right' }, { deps: { loadBrowserAudio: sound.load, hasWebAudio: () => true } })
    h.midi.out = null
    h.session.updateSettings(testSettings())
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ startAction: 'reading', startEnabled: true, startReason: null })
    await h.session.start()
    h.step(100)
    expect(sound.load).toHaveBeenCalledOnce()
    h.tap(60)
    expect(sound.backend.ons().map((c) => c.note)).toContain(48) // the left hand at the first onset (B1)
    expect(h.backend.ons()).toHaveLength(0)
  })

  it('"Connected piano" plays nothing without an output and says why', () => {
    const sound = deviceSound()
    const h = harness(twoHands, { hands: 'none' }, { deps: { loadBrowserAudio: sound.load, hasWebAudio: () => true } })
    h.midi.out = null
    h.session.updateSettings(testSettings({ sound: { ...DEFAULT_SETTINGS.sound, destination: 'midi' } }))
    h.frames.flush()
    expect(h.session.ui.get().startEnabled).toBe(false)
    expect(h.session.ui.get().startReason).toMatch(/piano output is not connected/)
    expect(sound.load).not.toHaveBeenCalled()
  })

  it('uses the connected piano and never loads the sample bank when an output is there', async () => {
    const sound = deviceSound()
    const h = harness(twoHands, { hands: 'none' }, { deps: { loadBrowserAudio: sound.load, hasWebAudio: () => true } })
    await h.session.start()
    h.step(1500)
    expect(sound.load).not.toHaveBeenCalled()
    expect(h.backend.ons().length).toBeGreaterThan(0)
    expect(h.session.ui.get().soundStatus).toBeNull()
  })

  it('is disabled with a reason only when there is neither a piano nor device sound', () => {
    const h = harness(
      twoHands,
      { hands: 'none' },
      { deps: { loadBrowserAudio: deviceSound().load, hasWebAudio: () => false } },
    )
    h.midi.out = null
    h.session.updateSettings(testSettings())
    h.frames.flush()
    expect(h.session.ui.get().startEnabled).toBe(false)
    expect(h.session.ui.get().startReason).toMatch(/No piano is connected and this browser cannot play sound/)
  })

  it('one-hand practice with neither a piano nor device sound is disabled with a reason', () => {
    const h = harness(
      twoHands,
      { hands: 'right' },
      { deps: { loadBrowserAudio: deviceSound().load, hasWebAudio: () => false } },
    )
    h.midi.out = null
    h.session.updateSettings(testSettings())
    h.frames.flush()
    expect(h.session.ui.get().startEnabled).toBe(false)
    expect(h.session.ui.get().startReason).toMatch(/needs the piano or this device/)
  })

  it('a piano that connects while Auto uses this device stops it cleanly; the next Play uses the piano', async () => {
    const sound = deviceSound()
    const h = harness(twoHands, { hands: 'none' }, { deps: { loadBrowserAudio: sound.load, hasWebAudio: () => true } })
    const out = h.midi.out
    h.midi.out = null
    h.session.updateSettings(testSettings())
    await h.session.start()
    h.step(500)
    expect(h.session.ui.get().playing).toBe(true)
    h.midi.out = out
    h.midi.route({ kind: 'output-reconnected', port: { id: 'out-1' } as never })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ playing: false, activity: 'idle' })
    expect(sound.backend.calls.some((c) => c.op === 'cleanup')).toBe(true)
    await h.session.start()
    h.step(500)
    expect(h.backend.ons().length).toBeGreaterThan(0)
    expect(sound.load).toHaveBeenCalledOnce()
  })

  it('a piano that disconnects while Listen plays on it pauses; the next Play continues on this device', async () => {
    const sound = deviceSound()
    const h = harness(twoHands, { hands: 'none' }, { deps: { loadBrowserAudio: sound.load, hasWebAudio: () => true } })
    await h.session.start()
    h.step(500)
    h.midi.out = null
    h.midi.route({ kind: 'output-disconnected', port: { id: 'out-1' } as never })
    h.frames.flush()
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.session.ui.get().soundStatus).toMatch(/keep listening through this device/)
    await h.session.start()
    h.step(500)
    expect(sound.load).toHaveBeenCalledOnce()
    expect(h.session.ui.get()).toMatchObject({ playing: true, activity: 'listening' })
  })
})

describe('PracticeSession: Repeat mode (U10)', () => {
  it('is closed by default: reading, no loop on the strip, no loop editing; the loop is remembered', () => {
    const h = harness(melody, { range: { fromOcc: 1, toOcc: 1 } }, { options: { repeat: false } })
    expect(h.session.ui.get()).toMatchObject({ repeat: false, range: null, startAction: 'reading' })
    expect(h.session.loop).toEqual({ fromOcc: 1, toOcc: 1 })
    expect(h.strip.loop).toBeNull()
    expect(h.strip.loopEditable).toBe(false)
  })

  it('opening uses the remembered loop, or the given bar as a one-bar loop; Start is then scored', () => {
    const h = harness(melody)
    h.session.setRepeatMode(true, 1)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ repeat: true, range: { fromOcc: 1, toOcc: 1 }, startAction: 'scored' })
    expect(h.strip.loop).toEqual({ fromOcc: 1, toOcc: 1 })
    expect(h.strip.loopEditable).toBe(true)
    expect(h.saves.some((x) => x.patch.lastPassage?.fromOcc === 1)).toBe(true)
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 1 } })
    h.session.setRepeatMode(false)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ repeat: false, range: null, startAction: 'reading' })
    expect(h.strip.loop).toBeNull()
    expect(h.strip.loopEditable).toBe(false)
    h.session.setRepeatMode(true, 0)
    h.frames.flush()
    expect(h.session.ui.get().range).toEqual({ fromOcc: 0, toOcc: 1 })
  })

  it('the cursor repeat button shows outside Repeat mode, while playing only with the chrome revealed (U14)', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } }, { options: { repeat: false } })
    expect(h.strip.cursorAction).toBe(true) // not started yet
    expect(h.strip.cursorDraggable).toBe(true)
    await h.session.start()
    h.tap(60)
    expect(h.session.ui.get().playing).toBe(true)
    // Playing with the chrome revealed (the default): the button stays; the playhead is not draggable.
    expect(h.strip.cursorAction).toBe(true)
    expect(h.strip.cursorDraggable).toBe(false)
    // Focus mode: the button goes with the chrome.
    h.session.setChromeRevealed(false)
    expect(h.strip.cursorAction).toBe(false)
    h.session.setChromeRevealed(true)
    expect(h.strip.cursorAction).toBe(true)
    h.session.setChromeRevealed(false)
    h.session.pause()
    h.frames.flush()
    // Paused: the button shows even while the view still reports the chrome as receded.
    expect(h.strip.cursorAction).toBe(true)
    expect(h.strip.cursorDraggable).toBe(true)
    h.session.setChromeRevealed(true)
    // A fresh one-bar loop at the cursor's bar, not the remembered bars 1–2.
    h.session.repeatFrom(h.session.progress.get().occ)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({
      repeat: true,
      range: { fromOcc: 0, toOcc: 0 },
      startAction: 'scored',
      playing: false,
    })
    // Never in Repeat mode; the playhead is not draggable there either.
    expect(h.strip.cursorAction).toBe(false)
    expect(h.strip.cursorDraggable).toBe(false)
    h.session.setRepeatMode(false)
    h.frames.flush()
    expect(h.strip.cursorAction).toBe(true)
    expect(h.strip.cursorDraggable).toBe(true)
  })

  it('repeatAtCursor pauses what plays, then opens Repeat with a one-bar loop at the cursor bar', async () => {
    const h = harness(melody)
    await h.session.start()
    h.play(60, 62, 64, 65)
    h.step(1000)
    expect(h.session.progress.get().occ).toBe(1)
    expect(h.session.ui.get().playing).toBe(true)
    h.session.repeatAtCursor()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ repeat: true, range: { fromOcc: 1, toOcc: 1 }, playing: false })
    expect(h.strip.cursorAction).toBe(false)
  })

  it('repeatAtCursor while paused opens Repeat at the cursor bar', () => {
    const h = harness(melody)
    h.session.repeatAtCursor()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ repeat: true, range: { fromOcc: 0, toOcc: 0 } })
  })

  it('repeatAtCursor takes the bar the view reports under its cursor line (the strip while browsing)', () => {
    const h = harness(melody)
    expect(h.session.progress.get().occ).toBe(0)
    h.session.repeatAtCursor(1)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ repeat: true, range: { fromOcc: 1, toOcc: 1 } })
    expect(h.strip.loop).toEqual({ fromOcc: 1, toOcc: 1 })
  })

  it('without a piano input the hands are held in Listen, unsaved, and come back with the piano (U27)', () => {
    const h = harness(melody, { hands: 'right' })
    expect(h.session.ui.get()).toMatchObject({ hands: 'right', handsAvailable: true })
    h.session.setInputAvailable(false)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ hands: 'none', handsAvailable: false, startAction: 'listen' })
    // Not the learner's choice: the piece keeps its remembered hands.
    expect(h.saves.some((s) => s.patch.lastHands === 'none')).toBe(false)
    h.session.setInputAvailable(false) // again: nothing changes
    h.session.setInputAvailable(true)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ hands: 'right', handsAvailable: true, startAction: 'reading' })
    expect(h.saves.some((s) => s.patch.lastHands !== undefined)).toBe(false)
  })

  it('closing it during a scored attempt interrupts the attempt and returns to reading without starting', async () => {
    const h = harness(melody, { range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.play(67, 69)
    h.session.setRepeatMode(false)
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'mode-change' })
    expect(h.session.ui.get()).toMatchObject({
      activity: 'idle',
      playing: false,
      startAction: 'reading',
      interruption: null,
    })
    expect(h.session.engine.mode).toBe('reading')
    // Reading continues from the loop's start (bar 2), not from the top of the piece.
    expect(h.session.progress.get().occ).toBe(1)
  })

  it('clearing the loop leaves Repeat mode', () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    h.session.setSelection({ range: null })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ repeat: false, range: null })
    expect(h.session.loop).toBeNull()
  })
})

describe('PracticeSession: lead-in before the loop', () => {
  /** Two bars: right-hand quarters, left-hand whole notes C3 | G2 (the automatic part in one-hand practice). */
  const twoBars = buildScore({
    notes: [
      { at: 0, midi: 60 },
      { at: 1, midi: 62 },
      { at: 2, midi: 64 },
      { at: 3, midi: 65 },
      { at: 4, midi: 67 },
      { at: 5, midi: 69 },
      { at: 6, midi: 71 },
      { at: 7, midi: 72 },
      { at: 0, midi: 48, hand: 'L', dur: 4 },
      { at: 4, midi: 43, hand: 'L', dur: 4 },
    ],
    bars: 2,
    tempo: { bpm: 60 },
  })
  const loop = { fromOcc: 1, toOcc: 1 }

  /** Let musical time reach the attempt's gate `group` (20 ms steps). */
  function untilGate(h: Harness, group = 0): void {
    for (let i = 0; i < 500 && h.session.engine.state.transportGate < group; i++) h.step(20)
  }

  it('a seek before the loop keeps Repeat mode and the loop; Start reads toward it, unscored', async () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({
      repeat: true,
      range: loop,
      leadIn: true,
      activity: 'idle', // the main button reads Start
      playing: false,
      startAction: 'scored',
    })
    expect(h.session.loop).toEqual(loop)
    expect(h.strip.loop).toEqual(loop)
    expect(h.strip.targets).toEqual([0])
    // The lead-in is not a passage: the remembered loop is untouched.
    expect(h.saves.some((s) => s.patch.lastPassage !== undefined)).toBe(false)
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, activity: 'reading', playing: true, repeat: true })
    expect(h.session.engine.mode).toBe('reading')
    h.play(60, 62, 64)
    expect(h.session.ui.get().leadIn).toBe(true)
    expect(h.attempts).toHaveLength(0)
  })

  it('at the loop start the attempt takes over without a stop, and Repeat wraps to the loop start', async () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    await h.session.start()
    h.play(60, 62, 64)
    h.midi.cc(64, 127, h.clock.now) // the sustain pedal stays down into the loop
    h.play(65)
    // No Ready wait: the attempt is live while the music plays on toward the loop.
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.session.ui.get()).toMatchObject({ leadIn: false, activity: 'scored', playing: true, waiting: null })
    h.step(500)
    expect(h.strip.cursor).toBeGreaterThan(0.75)
    untilGate(h)
    expect(h.strip.cursor).toBeCloseTo(1)
    h.tap(67)
    expect(h.session.engine.state.phase).toBe('running')
    h.play(69, 71, 72)
    h.midi.cc(64, 0, h.clock.now)
    h.step(1000) // the tail finishes, then Repeat resets
    expect(h.attempts).toHaveLength(1) // nothing from the lead-in
    expect(h.attempts[0]).toMatchObject({ kind: 'scored', completion: 'completed', passed: true })
    expect(h.attempts[0]!.context.passage).toEqual(loop)
    // The clock started with the first press inside the loop.
    expect(h.attempts[0]!.completionTimeSec).toBeCloseTo(3)
    expect(h.session.ui.get().lastResult).toMatchObject({ passed: true, streak: 1 })
    // The next pass starts at the loop start, not at the lead-in.
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.targets).toEqual([4])
    h.frames.flush()
    expect(h.session.progress.get().position).toBeCloseTo(1)
    h.play(67, 69, 71, 72)
    expect(h.attempts).toHaveLength(2)
    expect(h.session.ui.get().lastResult).toMatchObject({ streak: 2 })
  })

  it('the accompaniment plays on into the loop with no stop at the hand-over', async () => {
    const h = harness(twoBars, { hands: 'right', range: loop })
    h.session.seek(0)
    await h.session.start()
    h.clock.advance(20)
    // The first onset waits for the first press (P9): the lead-in's bass sounds with it.
    expect(h.backend.ons().map((c) => c.note)).not.toContain(48)
    h.play(60)
    expect(h.backend.ons().map((c) => c.note)).toContain(48) // from the lead-in position, with the press
    h.play(62, 64, 65)
    expect(h.session.engine.state.phase).toBe('ready')
    const handOver = h.backend.calls.length
    const pressed = h.clock.now
    untilGate(h)
    h.tap(67)
    const after = h.backend.calls.slice(handOver)
    expect(after.some((c) => c.op === 'cleanup')).toBe(false)
    const g2 = after.find((c) => c.op === 'on' && c.note === 43)
    expect(g2).toBeDefined()
    expect(g2!.time).toBeGreaterThanOrEqual(pressed + 999) // in time at the loop start, not earlier
    expect(g2!.time).toBeLessThanOrEqual(h.clock.now + 1)
    expect(h.session.engine.state.phase).toBe('running')
  })

  it('with nothing to play before the loop the attempt is live at once and the lead-in is its introduction', async () => {
    const score = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 1, midi: 62 },
        { at: 4, midi: 67 },
        { at: 5, midi: 69 },
      ],
      bars: 2,
    })
    const h = harness(score, { range: loop })
    expect(h.session.seekPosition(rat(1, 2))).toBe(true)
    h.frames.flush()
    expect(h.session.ui.get().leadIn).toBe(true)
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.session.ui.get().leadIn).toBe(false)
    h.step(500)
    expect(h.strip.cursor).toBeCloseTo(0.625)
    untilGate(h)
    h.play(67, 69)
    h.step(2000)
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]!.context.passage).toEqual(loop)
  })

  it('Restart during a lead-in starts an attempt at the loop start', async () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    await h.session.start()
    h.play(60, 62)
    h.midi.on(61, h.clock.now) // a wrong note in the lead-in is not an abandon
    h.session.restart()
    h.midi.off(61, h.clock.now)
    h.frames.flush()
    expect(h.session.engine.mode).toBe('scored')
    h.step(400) // the wrong note's hint (one mistake, S5) fades before Ready
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.session.ui.get()).toMatchObject({ leadIn: false, repeat: true, range: loop })
    expect(h.strip.targets).toEqual([4])
    expect(h.attempts).toHaveLength(0)
    expect(h.abandons).toHaveLength(0)
    expect(h.session.progress.get().position).toBeCloseTo(1)
  })

  it('Pause and Resume in a lead-in behave like reading', async () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    await h.session.start()
    h.play(60, 62)
    h.session.pause()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({
      leadIn: true,
      playing: false,
      activity: 'reading',
      phase: 'paused', // the main button reads Resume
      interruption: null,
    })
    expect(h.attempts).toHaveLength(0)
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, playing: true })
    expect(h.strip.targets).toEqual([2])
    h.play(64, 65)
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('a seek into the loop drops the lead-in: the attempt starts at the loop start as before', async () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    h.frames.flush()
    expect(h.session.ui.get().leadIn).toBe(true)
    h.session.seek(1)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: false, repeat: true, range: loop })
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.targets).toEqual([4])
  })

  it('a seek before the loop during a running attempt interrupts it and sets up the lead-in', async () => {
    const h = harness(melody, { range: loop })
    await h.session.start()
    h.tap(67)
    h.session.seek(0)
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'seek' })
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, repeat: true, playing: false, interruption: null })
    expect(h.strip.targets).toEqual([0])
  })

  it('a speed change keeps a lead-in going; a hand change ends it', async () => {
    const h = harness(melody, { range: loop })
    h.session.seek(0)
    await h.session.start()
    h.play(60)
    h.session.setSelection({ multiplier: 0.5 })
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, playing: true, multiplier: 0.5 })
    h.play(62, 64, 65)
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.timeline.multiplier).toBe(0.5)

    const g = harness(melody, { range: loop })
    g.session.seek(0)
    await g.session.start()
    g.play(60)
    g.session.setSelection({ hands: 'right' })
    g.frames.flush()
    expect(g.session.ui.get()).toMatchObject({ leadIn: false, playing: false, repeat: true, range: loop })
  })

  it('the hand-over tells the engine the transport is already running into the first gate', async () => {
    const h = harness(melody, { range: loop })
    const reconfigure = vi.spyOn(h.session.engine, 'reconfigure')
    h.session.seek(0)
    await h.session.start()
    h.play(60, 62, 64, 65)
    expect(h.session.engine.mode).toBe('scored')
    const toScored = reconfigure.mock.calls.filter(([c]) => c.mode === 'scored')
    expect(toScored).toHaveLength(1)
    expect(toScored[0]![0]).toMatchObject({ runningStart: true })
    // A plain attempt at the loop start (the transport waits for the first press) does not.
    const g = harness(melody, { range: loop })
    const plain = vi.spyOn(g.session.engine, 'reconfigure')
    await g.session.start()
    expect(plain.mock.calls.every(([c]) => !c.runningStart)).toBe(true)
  })
})

describe('PracticeSession: lead-in from inside or after the loop', () => {
  /** Four bars of right-hand quarters; the loop is bars 2–3. */
  const fourBars = buildScore({
    notes: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86].map((midi, at) => ({ at, midi })),
    bars: 4,
    tempo: { bpm: 60 },
  })
  const loop = { fromOcc: 1, toOcc: 2 }
  const loopNotes = [67, 69, 71, 72, 74, 76, 77, 79]

  /** Let the music play on until the session wraps into the attempt (20 ms steps). */
  function untilScored(h: Harness): void {
    for (let i = 0; i < 500 && h.session.engine.mode !== 'scored'; i++) h.step(20)
  }

  it('a tap inside the loop moves the cursor there; Start reads to the loop end, wraps and the attempt is live', async () => {
    const h = harness(fourBars, { range: loop })
    h.session.seek(2)
    h.frames.flush()
    // The cursor and the stage follow at once: no jump to the loop start.
    expect(h.session.progress.get().position).toBeCloseTo(2)
    expect(h.strip.cursor).toBeCloseTo(2)
    expect(h.strip.targets).toEqual([8])
    expect(h.session.ui.get()).toMatchObject({
      repeat: true,
      range: loop,
      leadIn: true,
      activity: 'idle',
      playing: false,
      startAction: 'scored',
    })
    expect(h.session.loop).toEqual(loop)
    expect(h.saves.some((s) => s.patch.lastPassage !== undefined)).toBe(false)
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, activity: 'reading', playing: true })
    h.play(74, 76, 77, 79)
    // Read to the end of the loop's last onset: the music plays on to the loop end.
    expect(h.session.engine.mode).toBe('reading')
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, playing: true, finished: false })
    expect(h.strip.wraps).toBe(0)
    untilScored(h)
    // At the loop end the music wraps to the loop start (the strip pans there) and the attempt is live.
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.wraps).toBe(1)
    expect(h.strip.wrappedTo).toBeCloseTo(1)
    expect(h.strip.targets).toEqual([4])
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: false, activity: 'scored', playing: true, waiting: null })
    expect(h.session.progress.get().position).toBeCloseTo(1)
    h.play(...loopNotes)
    h.step(1000) // the tail finishes, then Repeat resets
    expect(h.attempts).toHaveLength(1) // nothing from the lead-in
    expect(h.attempts[0]).toMatchObject({ kind: 'scored', completion: 'completed', passed: true })
    expect(h.attempts[0]!.context.passage).toEqual(loop)
    expect(h.session.ui.get().lastResult).toMatchObject({ passed: true, streak: 1 })
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.targets).toEqual([4])
    expect(h.strip.wraps).toBe(2)
  })

  it('a tap after the loop reads to the end of the piece, then wraps to the loop start', async () => {
    const h = harness(fourBars, { hands: 'right', range: loop })
    h.session.seek(3)
    h.frames.flush()
    expect(h.session.progress.get().position).toBeCloseTo(3)
    expect(h.strip.targets).toEqual([12])
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, repeat: true, range: loop })
    await h.session.start()
    h.play(81, 83, 84)
    // Pause and Resume in the lead-in behave like reading.
    h.session.pause()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, playing: false, phase: 'paused' })
    await h.session.start()
    h.play(86)
    expect(h.session.engine.mode).toBe('reading')
    // Pausing while the music plays on to the wrap, then resuming, still wraps.
    h.step(200)
    h.session.pause()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, playing: false, finished: false })
    h.step(2000)
    expect(h.session.engine.mode).toBe('reading')
    await h.session.start()
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, playing: true })
    untilScored(h)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.wrappedTo).toBeCloseTo(1)
    expect(h.strip.targets).toEqual([4])
    h.play(...loopNotes)
    h.step(1000)
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ kind: 'scored', completion: 'completed', passed: true })
    expect(h.attempts[0]!.context.passage).toEqual(loop)
  })

  it('a tap on the loop start keeps the attempt at the loop start', async () => {
    const h = harness(fourBars, { range: loop })
    h.session.seek(2)
    h.frames.flush()
    expect(h.session.ui.get().leadIn).toBe(true)
    h.session.seek(1)
    h.frames.flush()
    expect(h.session.ui.get()).toMatchObject({ leadIn: false, repeat: true, range: loop })
    expect(h.session.progress.get().position).toBeCloseTo(1)
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.targets).toEqual([4])
    expect(h.strip.wraps).toBe(0)
  })

  it('a tap inside the loop during a running attempt interrupts it and moves there', async () => {
    const h = harness(fourBars, { range: loop })
    await h.session.start()
    h.play(67, 69)
    h.session.seek(2)
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'seek' })
    expect(h.session.ui.get()).toMatchObject({ leadIn: true, repeat: true, playing: false, interruption: null })
    expect(h.session.progress.get().position).toBeCloseTo(2)
    expect(h.strip.cursor).toBeCloseTo(2)
    expect(h.strip.targets).toEqual([8])
    // Restart from there is an attempt at the loop start, as from any lead-in.
    h.session.restart()
    h.step(20)
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.targets).toEqual([4])
    expect(h.attempts).toHaveLength(1)
  })
})

describe('PracticeSession: Listen speed', () => {
  it('a speed change while listening reschedules live', async () => {
    const h = harness(twoHands, { hands: 'none' })
    await h.session.start()
    h.step(500)
    h.session.setSelection({ multiplier: 2 })
    expect(h.session.ui.get().activity).toBe('listening')
  })
})

describe('PracticeSession: hints and labels', () => {
  it('Hint shows names through the strip opacity and fades them on completion', async () => {
    const h = harness(melody)
    await h.session.start()
    h.session.requestHint()
    h.frames.flush()
    expect(h.strip.opacity.get(0)).toBe(1)
    expect(h.strip.texts.get(0)).toBe('C4')
    h.tap(60)
    h.step(100)
    const mid = h.strip.opacity.get(0) ?? 0
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    h.step(400)
    expect(h.strip.opacity.has(0)).toBe(false)
  })

  it('persistent labels show everywhere and their exposure is recorded as assistance', async () => {
    const settings = testSettings({ labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' } })
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } }, { settings })
    expect(h.strip.opacity.size).toBe(8)
    await h.session.start()
    h.session.onVisibleLabels([0, 1, 2, 3])
    h.play(60, 62, 64, 65)
    const record = h.attempts[0]!
    expect(record.assistance.level).toBe('names')
    expect(record.assistance.persistentLabelNotes).toEqual([0, 1, 2, 3])
    expect(record.assistance.hintRequests).toBe(0)
    expect(record.passed).toBe(false)
  })

  it('label mode changes fade out and delay Ready until the fade finished', async () => {
    const all = testSettings({ labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' } })
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } }, { settings: all })
    const off = { ...all, labels: { ...all.labels, mode: 'off' as const } }
    h.session.updateSettings(off)
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('preparing')
    h.step(150)
    expect([...h.strip.opacity.values()].every((v) => v > 0 && v < 1)).toBe(true)
    h.step(200)
    h.frames.flush()
    expect(h.strip.opacity.size).toBe(0)
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('applying label settings interrupts a scored attempt before the labels change', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.tap(60)
    h.session.beforeApplyLabels({ ...DEFAULT_SETTINGS.labels, mode: 'all' })
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'setting-change' })
  })

  it('the keyboard guide follows the group and marks the attempt keyboard-assisted', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.session.setKeyboardVisible(true)
    h.frames.flush()
    expect(h.session.guide.get().keys).toEqual([{ midi: 60, state: 'target', hand: 'R', label: 'C4', held: false }])
    h.press(60)
    // The group advanced: D4 is the target, C4 still held.
    expect(h.session.guide.get().keys).toEqual([
      { midi: 60, state: 'held', hand: null, label: 'C4', held: true },
      { midi: 62, state: 'target', hand: 'R', label: 'D4', held: false },
    ])
    const emissions = h.session.guide.emissions
    h.frames.flush()
    expect(h.session.guide.emissions).toBe(emissions) // nothing changed, nothing published
    h.release(60)
    h.play(62, 64, 65)
    expect(h.attempts[0]!.assistance.keyboardShown).toBe(true)
  })

  it('the keyboard guide shows both hands whatever hands are selected (U20)', () => {
    for (const hands of ['both', 'right', 'left', 'none'] as const) {
      const h = harness(twoHands, { hands })
      h.session.setKeyboardVisible(true)
      h.frames.flush()
      expect(h.session.guide.get().keys.map((k) => [k.midi, k.state, k.hand])).toEqual([
        [48, 'target', 'L'],
        [60, 'target', 'R'],
      ])
    }
  })

  it('the keyboard guide shows what Listen sounds while it plays (U15)', async () => {
    const h = harness(twoHands, { hands: 'none' })
    h.session.setKeyboardVisible(true)
    h.frames.flush()
    await h.session.start()
    h.step(50)
    const keys = h.session.guide.get().keys
    expect(keys.map((k) => [k.midi, k.state, k.hand])).toEqual([
      [48, 'sounding', 'L'],
      [60, 'sounding', 'R'],
    ])
  })

  it('naming changes update the label texts without an interruption', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.tap(60)
    h.session.updateSettings(testSettings({ naming: { ...DEFAULT_SETTINGS.naming, system: 'fixed-do' } }))
    expect(h.strip.texts.get(1)).toBe('re4')
    expect(h.attempts).toHaveLength(0)
  })
})

describe('PracticeSession: lifecycle', () => {
  it('dispose stops a running attempt as a user stop and unsubscribes', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 1 } })
    await h.session.start()
    h.tap(60)
    h.session.dispose()
    expect(h.attempts[0]).toMatchObject({ completion: 'abandoned', interruptReason: 'user-stop' })
    expect(h.midi.subscribers).toBe(0)
    expect(h.midi.owners.size).toBe(0)
  })

  it('scored Ready waits for the strip (layout prepared)', async () => {
    const h = harness(melody, { range: { fromOcc: 0, toOcc: 0 } }, { attach: false })
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('preparing')
    expect(h.session.ui.get().waiting).toMatch(/Preparing/)
    h.session.attachStrip(h.strip)
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
  })
})

describe('PracticeSession: key feedback while nothing plays (U31) and the optional red flash (S5)', () => {
  const noteOf = (model: typeof melody, midi: number) => model.notes.findIndex((n) => n.midi === midi)

  it('before Start, a held target key reads as accepted and a release removes it; nothing is judged', () => {
    const h = harness(melody)
    expect(h.session.ui.get().playing).toBe(false)
    expect(h.strip.targets).toEqual([0])
    h.press(60)
    expect(h.strip.accepted).toEqual([0])
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.session.engine.state).toMatchObject({
      phase: 'paused',
      groupIndex: 0,
      acceptedPitches: [],
      wrongAttacks: 0,
    })
    h.release(60)
    expect(h.strip.accepted).toEqual([])
    expect(h.strip.targets).toEqual([0]) // no advance
    expect(h.attempts).toHaveLength(0)
  })

  it('a wrong key while paused tints the cursor only: no flash, pulse, cue, hint or record', () => {
    const h = harness(melody)
    h.press(61, 63)
    expect(h.strip.wrongMarker).toBe(true)
    expect(h.flash.hits).toHaveLength(0)
    expect(h.strip.pulses).toBe(0)
    expect(h.session.feedback.get()).toMatchObject({ visible: false, cue: null, pulse: 0 })
    expect(h.session.engine.state.hint).toBeNull()
    expect(h.session.engine.state.groupHasError).toBe(false)
    h.release(61)
    expect(h.strip.wrongMarker).toBe(true) // another wrong key is still held
    h.release(63)
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.attempts).toHaveLength(0)
    expect(h.abandons).toHaveLength(0)
  })

  it('after a pause, previews the current group with its already accepted pitches', async () => {
    const h = harness(twoHands)
    await h.session.start()
    h.frames.flush()
    h.play(60)
    h.session.pause()
    h.frames.flush()
    const c4 = noteOf(twoHands, 60)
    const c3 = noteOf(twoHands, 48)
    expect(h.strip.accepted).toEqual([c4])
    h.press(48)
    expect([...h.strip.accepted].sort()).toEqual([c4, c3].sort())
    h.press(60) // an accepted pitch again is still right
    expect(h.strip.wrongMarker).toBe(false)
    h.release(48, 60)
    expect(h.strip.accepted).toEqual([c4]) // the engine's own acceptance stays
    expect(h.session.engine.state.groupIndex).toBe(0)
    expect(h.session.engine.state.acceptedPitches).toEqual([60])
  })

  it('Start, a seek and Listen clear the preview; held keys never become attacks', async () => {
    const h = harness(melody)
    h.press(61)
    expect(h.strip.wrongMarker).toBe(true)
    await h.session.start()
    h.frames.flush()
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.session.engine.state.wrongAttacks).toBe(0)
    h.release(61)
    h.session.pause()
    h.frames.flush()

    h.press(62) // group 0 wants C4: wrong
    expect(h.strip.wrongMarker).toBe(true)
    h.session.seek(1)
    h.frames.flush()
    expect(h.strip.targets).toEqual([4])
    expect(h.strip.wrongMarker).toBe(false)
    expect(h.strip.accepted).toEqual([])
    h.release(62)

    h.press(67)
    expect(h.strip.accepted).toEqual([4])
    h.session.setSelection({ hands: 'none' })
    h.frames.flush()
    expect(h.strip.accepted).toEqual([])
    h.release(67)
    h.press(69)
    expect(h.strip.accepted).toEqual([])
    expect(h.strip.wrongMarker).toBe(false)
  })

  it('drops preview keys whose release never reached the session (an overlay was open)', () => {
    const h = harness(melody)
    h.press(60)
    expect(h.strip.accepted).toEqual([0])
    h.session.holdInput(true)
    h.release(60) // goes to the overlay, not the session
    h.session.holdInput(false)
    h.frames.flush()
    expect(h.strip.accepted).toEqual([])
  })

  it('the keyboard guide shows previewed keys as accepted or wrong', () => {
    const h = harness(melody)
    h.session.setKeyboardVisible(true)
    h.frames.flush()
    h.press(60)
    expect(h.session.guide.get().keys).toContainEqual(
      expect.objectContaining({ midi: 60, state: 'accepted', held: true }),
    )
    h.press(61)
    expect(h.session.guide.get().keys).toContainEqual(expect.objectContaining({ midi: 61, state: 'wrong', held: true }))
    h.release(60, 61)
    expect(h.session.guide.get().keys).toContainEqual(expect.objectContaining({ midi: 60, state: 'target' }))
  })

  it('with the red flash off, a wrong note keeps the tint, pulse and cue but never flashes', async () => {
    const settings = testSettings({ hints: { ...DEFAULT_SETTINGS.hints, damageFlash: false } })
    const h = harness(melody, {}, { settings })
    await h.session.start()
    h.frames.flush()
    h.midi.on(61, h.clock.now)
    h.frames.flush()
    expect(h.flash.hits).toHaveLength(0)
    expect(h.strip.pulses).toBe(1)
    expect(h.strip.wrongMarker).toBe(true)
    expect(h.session.feedback.get()).toMatchObject({ visible: true, reason: 'wrong', pulse: 1 })
    expect(h.session.engine.state.wrongAttacks).toBe(1)
  })

  it('turning the red flash off clears a flash in progress; on again flashes', async () => {
    const h = harness(melody)
    await h.session.start()
    h.frames.flush()
    h.midi.on(61, h.clock.now)
    h.frames.flush()
    expect(h.flash.hits).toHaveLength(1)
    const clears = h.flash.clears
    h.session.updateSettings(testSettings({ hints: { ...DEFAULT_SETTINGS.hints, damageFlash: false } }))
    expect(h.flash.clears).toBe(clears + 1)
    h.midi.on(63, h.clock.now)
    h.frames.flush()
    expect(h.flash.hits).toHaveLength(1)
    h.session.updateSettings(testSettings())
    h.midi.on(66, h.clock.now)
    h.frames.flush()
    expect(h.flash.hits).toHaveLength(2)
  })
})

describe('PracticeSession: teacher corrections after an attempt', () => {
  /** The melody with a tempo (one beat per second), so the music reaches each gate on time. */
  const timed: ScoreModel = buildScore({
    notes: [
      { at: 0, midi: 60 },
      { at: 1, midi: 62 },
      { at: 2, midi: 64 },
      { at: 3, midi: 65 },
      { at: 4, midi: 67 },
      { at: 5, midi: 69 },
      { at: 6, midi: 71 },
      { at: 7, midi: 72 },
    ],
    bars: 2,
    tempo: { bpm: 60 },
  })

  /** Bar 1 with a wrong key at D (group 1) and E 600 ms after the music reached it (group 2). */
  async function flawedPass(h: Harness): Promise<void> {
    await h.session.start()
    h.frames.flush()
    h.play(60)
    h.tap(61)
    h.play(62)
    h.step(1600)
    h.play(64, 65)
    h.step(1000) // the notated tail finishes; Repeat prepares the next pass
  }

  it('marks the wrong group and the late group on the score when the attempt completes', async () => {
    const h = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(h)
    expect(h.attempts).toHaveLength(1)
    // The wrong key was D♭ for a D: that is an accidental slip, named with the right note.
    expect(h.strip.corrections).toEqual([
      { notes: [1], kind: 'accidental', text: 'D♮4, not D♭4' },
      { notes: [2], kind: 'late', text: 'Too late' },
    ])
    expect(h.session.ui.get()).toMatchObject({ corrections: 2, lastResult: { passed: false } })
  })

  it('a clean pass leaves no marks', async () => {
    const h = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await h.session.start()
    h.play(60, 62, 64, 65)
    h.step(1000)
    expect(h.attempts).toHaveLength(1)
    expect(h.strip.corrections).toEqual([])
    expect(h.session.ui.get().corrections).toBe(0)
  })

  it('clears the marks when the result is dismissed', async () => {
    const h = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(h)
    h.session.dismissResult()
    expect(h.strip.corrections).toEqual([])
    expect(h.session.ui.get()).toMatchObject({ corrections: 0, lastResult: null })
  })

  it('clears the marks on a new Start', async () => {
    const h = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(h)
    expect(h.strip.corrections).toHaveLength(2)
    await h.session.start()
    h.frames.flush()
    expect(h.strip.corrections).toEqual([])
    expect(h.session.ui.get().corrections).toBe(0)
  })

  it('clears the marks on a seek, a Restart and a selection change', async () => {
    const seek = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(seek)
    seek.session.seek(0)
    seek.frames.flush()
    expect(seek.strip.corrections).toEqual([])
    expect(seek.session.ui.get().corrections).toBe(0)

    const restart = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(restart)
    restart.session.restart()
    expect(restart.strip.corrections).toEqual([])

    const speed = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(speed)
    speed.session.setSelection({ multiplier: 0.5 })
    speed.frames.flush()
    expect(speed.strip.corrections).toEqual([])
    expect(speed.session.ui.get().corrections).toBe(0)
  })

  it('in Repeat mode keeps the marks through the automatic restart until the first press of the next pass', async () => {
    const h = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(h)
    // The next pass is ready (Repeat started over by itself): the marks are still there.
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.strip.wraps).toBe(1)
    expect(h.strip.corrections).toHaveLength(2)
    h.step(2000)
    expect(h.strip.corrections).toHaveLength(2)
    expect(h.session.ui.get().corrections).toBe(2)
    const calls = h.strip.correctionCalls
    // The first press of the new pass, even a wrong key, clears them.
    h.tap(61)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.strip.corrections).toEqual([])
    expect(h.strip.correctionCalls).toBe(calls + 1)
    expect(h.session.ui.get()).toMatchObject({ corrections: 0, lastResult: null })
  })

  it('clears the marks when leaving Practice and hands them to a strip attached again', async () => {
    const h = harness(timed, { range: { fromOcc: 0, toOcc: 0 } })
    await flawedPass(h)
    const fresh = new FakeStrip()
    h.session.layoutChanging()
    h.session.attachStrip(fresh)
    expect(fresh.corrections).toHaveLength(2)
    h.session.dispose()
    expect(fresh.corrections).toEqual([])
  })
})
