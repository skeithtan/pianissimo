/**
 * Playback goes on through loop changes and browsing (DECISIONS U94, U95): a loop changed while
 * Repeat plays keeps playing, and a browse of the strip while something plays holds the sound
 * until the finger lifts, then continues from the note under the fixed cursor line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { rat, type Rational } from '../../core/music/rational'
import type { MetronomeModule } from '../../core/playback'
import { FakeAudioContext } from '../../core/playback/fakeWebAudio'
import { resetSharedAudioContext, sharedAudioContext } from '../../core/playback/webaudio/context'
import { FakeStrip, harness as baseHarness, type Harness } from './testkit'

/** Three bars of quarters (one beat per second), the right hand over a left-hand whole note per bar. */
const threeBars = buildScore({
  notes: [
    ...[60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79].map((midi, at) => ({ at, midi })),
    { at: 0, midi: 48, hand: 'L' as const, dur: 4 },
    { at: 4, midi: 43, hand: 'L' as const, dur: 4 },
    { at: 8, midi: 41, hand: 'L' as const, dur: 4 },
  ],
  bars: 3,
  tempo: { bpm: 60 },
})

/** A strip that can be browsed: `browse` sets what the real strip reports before `onBrowse(true)`. */
class BrowsableStrip extends FakeStrip {
  browsing = false
  browsePosition: Rational | null = null
  returns = 0
  override isBrowsing(): boolean {
    return this.browsing
  }
  browsedPosition(): Rational | null {
    return this.browsing ? this.browsePosition : null
  }
  returnToCurrent(): void {
    if (this.browsing) this.returns++
    this.browsing = false
  }
}

type BrowseHarness = Omit<Harness, 'strip'> & { strip: BrowsableStrip }

function harness(...args: Parameters<typeof baseHarness>): BrowseHarness {
  const h = baseHarness(...args)
  const strip = new BrowsableStrip()
  h.session.attachStrip(strip)
  h.frames.flush()
  return { ...h, strip }
}

/** The finger goes down and drags the strip so that `position` sits under the cursor line (null: the page layout). */
function browse(h: BrowseHarness, position: Rational | null): void {
  h.strip.browsing = true
  h.strip.browsePosition = position
  h.session.browseStarted()
  h.frames.flush()
}

const ui = (h: BrowseHarness) => h.session.ui.get()
const notesSince = (h: BrowseHarness, from: number) =>
  h.backend
    .ons()
    .slice(from)
    .map((c) => c.note)

describe('Loop changes while Repeat plays keep playing (U94)', () => {
  it('Listen: a grown loop plays on from where it was', async () => {
    const h = harness(threeBars, { hands: 'none', range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.step(1500)
    const before = h.backend.ons().length
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    h.frames.flush()
    expect(ui(h)).toMatchObject({ activity: 'listening', playing: true, range: { fromOcc: 1, toOcc: 2 } })
    // The next onset after the cursor (bar 2, beat 3), not the loop start.
    expect(h.session.progress.get().position).toBeCloseTo(1.5)
    h.step(1000)
    h.step(1000)
    h.step(500)
    // The music runs past the old loop end into bar 3 instead of wrapping to bar 2.
    expect(notesSince(h, before)).toEqual(expect.arrayContaining([71, 72, 74]))
    expect(notesSince(h, before)).not.toContain(67)
    expect(h.session.progress.get().position).toBeGreaterThan(2)
  })

  it('Listen: a loop shrunk behind the cursor plays on from its start', async () => {
    const h = harness(threeBars, { hands: 'none', range: { fromOcc: 1, toOcc: 2 } })
    await h.session.start()
    h.step(5000)
    expect(h.session.progress.get().position).toBeGreaterThan(2)
    const before = h.backend.ons().length
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 1 } })
    h.frames.flush()
    expect(ui(h)).toMatchObject({ activity: 'listening', playing: true, range: { fromOcc: 1, toOcc: 1 } })
    expect(h.session.progress.get().position).toBeCloseTo(1)
    expect(notesSince(h, before).slice(0, 2)).toEqual(expect.arrayContaining([43, 67]))
  })

  it('a running attempt ends as a range change and a lead-in plays on from the cursor inside the grown loop', async () => {
    const h = harness(threeBars, { hands: 'right', range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.play(67, 69)
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    h.frames.flush()
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'range-change' })
    expect(ui(h)).toMatchObject({ leadIn: true, activity: 'reading', playing: true, interruption: null })
    expect(h.session.engine.state.position).toEqual(rat(3, 2))
    // The lead-in reads to the new loop end, then wraps into the attempt at the loop start.
    h.play(71, 72, 74, 76, 77, 79)
    h.step(1000)
    h.step(1000)
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h)).toMatchObject({ leadIn: false, playing: true })
    expect(h.attempts).toHaveLength(1)
  })

  it('a running attempt past the shrunk loop starts the next attempt at the loop start, still playing', async () => {
    const h = harness(threeBars, { hands: 'right', range: { fromOcc: 1, toOcc: 2 } })
    await h.session.start()
    h.frames.flush()
    const loopStart = [...h.strip.targets]
    h.play(67, 69, 71, 72, 74)
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 1 } })
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'range-change' })
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h)).toMatchObject({ leadIn: false, playing: true, interruption: null })
    expect(h.strip.targets).toEqual(loopStart)
    h.play(67, 69, 71, 72)
    h.step(1000)
    expect(h.attempts[1]).toMatchObject({ kind: 'scored', completion: 'completed', passed: true })
  })

  it('an attempt waiting at Ready waits at the new loop start', async () => {
    const h = harness(threeBars, { hands: 'right', range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    h.session.setSelection({ range: { fromOcc: 0, toOcc: 1 } })
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h)).toMatchObject({ leadIn: false, playing: true })
    expect(h.session.engine.state.position).toEqual(rat(0))
    expect(h.attempts).toHaveLength(0)
  })

  it('a lead-in reading toward the loop goes on toward the moved loop', async () => {
    const h = harness(threeBars, { hands: 'right', range: { fromOcc: 1, toOcc: 1 } })
    h.session.seek(0)
    await h.session.start()
    h.play(60)
    h.session.setSelection({ range: { fromOcc: 2, toOcc: 2 } })
    h.frames.flush()
    expect(ui(h)).toMatchObject({ leadIn: true, playing: true, range: { fromOcc: 2, toOcc: 2 } })
    expect(h.session.engine.state.position).toEqual(rat(1, 4))
    h.play(62, 64, 65, 67, 69, 71, 72)
    expect(h.session.engine.mode).toBe('scored')
    expect(h.attempts).toHaveLength(0)
  })

  it('while paused a loop change only moves the loop', async () => {
    const h = harness(threeBars, { hands: 'right', range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.play(67, 69)
    h.session.pause()
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    h.frames.flush()
    expect(ui(h)).toMatchObject({ leadIn: false, playing: false, range: { fromOcc: 1, toOcc: 2 } })

    const l = harness(threeBars, { hands: 'none', range: { fromOcc: 1, toOcc: 1 } })
    await l.session.start()
    l.step(1500)
    l.session.pause()
    const before = l.backend.ons().length
    l.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    l.step(1000)
    expect(ui(l).playing).toBe(false)
    expect(notesSince(l, before)).toEqual([])
  })

  it('a loop changed during a browse hold decides where playback goes on, and the strip follows again', async () => {
    const h = harness(threeBars, { hands: 'none', range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.step(1500)
    // A handle drag that scrolled the strip: browsing begins, then the loop is committed.
    browse(h, rat(5, 2))
    expect(ui(h).playing).toBe(true)
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    h.frames.flush()
    expect(h.strip.browsing).toBe(false)
    expect(h.session.progress.get().position).toBeCloseTo(1.5)
    // The release that follows finds nothing to continue.
    await h.session.browseReleased()
    h.frames.flush()
    expect(h.session.progress.get().position).toBeCloseTo(1.5)
    expect(ui(h)).toMatchObject({ playing: true, activity: 'listening' })
  })
})

describe('Keep time: a loop change while playing (U94)', () => {
  let clicks = 0
  beforeEach(() => {
    clicks = 0
    resetSharedAudioContext()
    sharedAudioContext(() => new FakeAudioContext() as unknown as AudioContext)
  })
  afterEach(() => resetSharedAudioContext())

  it('starts a new attempt at the loop start whose count-in starts over', async () => {
    class WebAudioMetronome {
      click(): void {
        clicks++
      }
      cancel(): void {}
      setVolume(): void {}
    }
    const h = harness(
      threeBars,
      { hands: 'right', range: { fromOcc: 1, toOcc: 1 } },
      {
        options: { rhythm: true },
        deps: { loadMetronome: async () => ({ WebAudioMetronome }) as unknown as MetronomeModule },
      },
    )
    await h.session.start()
    h.frames.flush()
    h.step(5000)
    expect(h.session.engine.state.phase).toBe('running')
    h.tap(67)
    h.session.setSelection({ range: { fromOcc: 1, toOcc: 2 } })
    h.frames.flush()
    expect(h.attempts[0]).toMatchObject({ completion: 'interrupted', interruptReason: 'range-change' })
    expect(ui(h)).toMatchObject({ playing: true, leadIn: false })
    const counted = clicks
    // Ready once the hint shown for the interrupted attempt has faded: the count-in starts over.
    h.step(1000)
    expect(h.session.engine.state.phase).toBe('ready')
    expect(ui(h)).toMatchObject({ playing: true, countIn: 4 })
    expect(clicks).toBeGreaterThan(counted)
  })
})

describe('Browsing while playing holds, the release continues (U95)', () => {
  it('reading continues from the browsed note', async () => {
    const h = harness(threeBars, { hands: 'right' })
    await h.session.start()
    h.play(60, 62)
    browse(h, rat(2))
    expect(h.session.engine.state.phase).toBe('paused')
    expect(ui(h).playing).toBe(true)
    // Nothing moves while the finger is down.
    expect(h.session.engine.state.position).toEqual(rat(1, 2))
    await h.session.browseReleased()
    h.frames.flush()
    expect(h.strip.browsing).toBe(false)
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.engine.state.position).toEqual(rat(2))
    expect(ui(h)).toMatchObject({ activity: 'reading', playing: true })
    expect(h.attempts).toHaveLength(0)
  })

  it('Repeat continues as a lead-in from the browsed note, or at Ready at the loop start', async () => {
    const h = harness(threeBars, { hands: 'right', range: { fromOcc: 1, toOcc: 1 } })
    await h.session.start()
    h.play(67, 69)
    browse(h, rat(1, 4))
    await h.session.browseReleased()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ leadIn: true, activity: 'reading', playing: true })
    expect(h.session.engine.state.position).toEqual(rat(1, 4))
    expect(h.attempts).toHaveLength(0)

    browse(h, rat(1))
    await h.session.browseReleased()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ leadIn: false, activity: 'scored', playing: true })
    expect(h.session.engine.state.phase).toBe('ready')
  })

  it('Restart loop skips a paused lead-in and returns the browsed score to the loop start', async () => {
    const h = harness(threeBars, { hands: 'right', range: { fromOcc: 1, toOcc: 1 } })
    h.session.seekPosition(rat(5, 4))
    expect(ui(h).canRestartLoop).toBe(false)
    await h.session.start()
    h.play(69)
    h.session.pause()
    h.frames.flush()
    browse(h, rat(2))
    expect(ui(h)).toMatchObject({ playing: false, leadIn: true, canRestartLoop: true })

    h.session.restartLoop()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ phase: 'ready', playing: true, leadIn: false, canRestartLoop: false })
    expect(h.session.progress.get().position).toBe(1)
    expect(h.strip.browsing).toBe(false)
    expect(h.attempts).toHaveLength(0)
  })

  it('Listen holds its sound while the finger is down, then plays from the browsed note', async () => {
    const h = harness(threeBars, { hands: 'none' })
    await h.session.start()
    h.step(1000)
    browse(h, rat(2))
    const held = h.backend.ons().length
    h.step(1000)
    expect(notesSince(h, held)).toEqual([])
    expect(ui(h)).toMatchObject({ activity: 'listening', playing: true })
    await h.session.browseReleased()
    h.frames.flush()
    expect(notesSince(h, held).slice(0, 2)).toEqual(expect.arrayContaining([41, 74]))
    expect(h.session.progress.get().position).toBeCloseTo(2)
  })

  it('play-through continues from the browsed note', async () => {
    const h = harness(threeBars, { hands: 'right' })
    h.session.setPlayThrough(true)
    await h.session.start()
    h.frames.flush()
    h.tap(60)
    browse(h, rat(2))
    expect(ui(h)).toMatchObject({ playing: true, phase: 'paused' })
    await h.session.browseReleased()
    h.frames.flush()
    expect(ui(h)).toMatchObject({ playing: true, phase: 'running' })
    expect(h.session.progress.get().position).toBeCloseTo(2)
  })

  it('a browse while paused changes nothing at the release', async () => {
    const h = harness(threeBars, { hands: 'right' })
    await h.session.start()
    h.play(60, 62)
    h.session.pause()
    browse(h, rat(2))
    await h.session.browseReleased()
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    expect(h.strip.browsing).toBe(true)
    expect(h.session.engine.state.position).toEqual(rat(1, 2))
  })

  it('Pause during the hold cancels the continuation', async () => {
    const h = harness(threeBars, { hands: 'right' })
    await h.session.start()
    h.play(60, 62)
    browse(h, rat(2))
    // The main button reads Pause during the hold: pressing it pauses for good.
    h.session.togglePlay()
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    await h.session.browseReleased()
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
    expect(h.session.engine.state.phase).toBe('paused')
    expect(h.session.engine.state.position).toEqual(rat(1, 2))
  })

  it('an overlay during the hold cancels the continuation', async () => {
    const h = harness(threeBars, { hands: 'none' })
    await h.session.start()
    h.step(1000)
    browse(h, rat(2))
    h.session.holdInput(true)
    await h.session.browseReleased()
    h.frames.flush()
    expect(ui(h).playing).toBe(false)
  })

  it('scrolling the page layout while playing pauses nothing', async () => {
    const h = harness(threeBars, { hands: 'none' })
    await h.session.start()
    h.step(1000)
    const before = h.backend.ons().length
    browse(h, null)
    h.step(1000)
    expect(notesSince(h, before)).toEqual([64])
    expect(ui(h)).toMatchObject({ activity: 'listening', playing: true })
    await h.session.browseReleased()
    h.step(1000)
    expect(notesSince(h, before)).toEqual([64, 65])
  })

  it('a seek while reading plays keeps playing from the new note', async () => {
    const h = harness(threeBars, { hands: 'right' })
    await h.session.start()
    h.play(60, 62)
    expect(h.session.seekPosition(rat(2))).toBe(true)
    h.frames.flush()
    expect(h.session.engine.state.phase).toBe('running')
    expect(h.session.engine.state.position).toEqual(rat(2))
    expect(ui(h).playing).toBe(true)
  })
})
