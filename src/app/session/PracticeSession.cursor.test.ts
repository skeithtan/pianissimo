import { describe, expect, it, vi } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { rat } from '../../core/music/rational'
import type { BrowserAudioModule } from '../../core/playback'
import { RecordingBackend } from '../../core/playback/testkit'
import { FakeStrip, harness as baseHarness, type Harness } from './testkit'

const melody = buildScore({
  notes: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, at) => ({ at, midi })),
  bars: 2,
})

class BrowsableStrip extends FakeStrip {
  browsing = false
  browsePosition: ReturnType<typeof rat> | null = null
  override isBrowsing(): boolean {
    return this.browsing
  }
  browsedPosition(): ReturnType<typeof rat> | null {
    return this.browsing ? this.browsePosition : null
  }
  returnToCurrent(): void {
    this.browsing = false
  }
}

type CursorHarness = Omit<Harness, 'strip'> & { strip: BrowsableStrip }

function harness(...args: Parameters<typeof baseHarness>): CursorHarness {
  const h = baseHarness(...args)
  const strip = new BrowsableStrip()
  h.session.attachStrip(strip)
  return { ...h, strip }
}

function browse(h: CursorHarness, position: ReturnType<typeof rat> | null): void {
  h.session.browseStarted()
  h.strip.browsing = true
  h.strip.browsePosition = position
}

function pendingSound() {
  const backend = Object.assign(new RecordingBackend(() => 0), { monitor: vi.fn(), dispose: vi.fn() })
  let resolve!: (module: BrowserAudioModule) => void
  const loadBrowserAudio = vi.fn(() => new Promise<BrowserAudioModule>((r) => (resolve = r)))
  return {
    backend,
    deps: { loadBrowserAudio, hasWebAudio: () => true },
    resolve: () => resolve({ createBrowserAudio: () => backend } as unknown as BrowserAudioModule),
  }
}

describe('Start at the visible cursor after browsing', () => {
  it.each(['both', 'right', 'none'] as const)('starts and resumes %s from the visible onset', async (hands) => {
    const h = harness(melody, { hands })
    for (const position of [rat(1, 2), rat(1, 4)]) {
      browse(h, position)
      const before = h.backend.ons().length
      await h.session.start()
      h.frames.flush()
      expect(h.strip.isBrowsing()).toBe(false)
      expect(h.strip.cursor).toBe(position.n / position.d)
      expect(h.session.progress.get().position).toBe(h.strip.cursor)
      const note = position.n / position.d === 0.5 ? 64 : 62
      if (hands === 'none')
        expect(
          h.backend
            .ons()
            .slice(before)
            .map((c) => c.note),
        ).toEqual([note])
      else h.tap(note)
      h.step(500)
      expect(h.strip.cursor).toBeCloseTo(position.n / position.d + 0.125)
      expect(h.session.progress.get().position).toBe(h.strip.cursor)
    }
    expect(h.attempts).toHaveLength(0)
  })

  it('starts a lead-in at the visible onset and keeps the scored loop', async () => {
    const loop = { fromOcc: 1, toOcc: 1 }
    const h = harness(melody, { range: loop })
    browse(h, rat(1, 4))
    await h.session.start()
    h.frames.flush()
    expect(h.strip.isBrowsing()).toBe(false)
    expect(h.strip.cursor).toBe(0.25)
    expect(h.session.ui.get()).toMatchObject({ repeat: true, range: loop, leadIn: true, playing: true })
    h.play(62, 64, 65)
    h.step(1000)
    expect(h.session.engine.mode).toBe('scored')
    expect(h.session.engine.state.phase).toBe('ready')
    expect(h.attempts).toHaveLength(0)
  })

  it('resumes following in page view without replacing its moving cursor position', async () => {
    const h = harness(melody, { hands: 'none' })
    h.session.seekPosition(rat(1, 2))
    await h.session.start()
    h.step(500)
    browse(h, null)
    await h.session.start()
    h.frames.flush()
    expect(h.strip.isBrowsing()).toBe(false)
    expect(h.strip.cursor).toBe(0.625)
    h.step(500)
    expect(h.strip.cursor).toBe(0.75)
  })

  it.each([false, true])('Listen honors an intra-loop cursor with an existing transport: %s', async (started) => {
    const loop = { fromOcc: 1, toOcc: 1 }
    const h = harness(melody, { hands: 'none', range: loop })
    if (started) {
      await h.session.start()
      h.step(2500)
    }
    browse(h, rat(5, 4))
    const before = h.backend.ons().length
    await h.session.start()
    h.frames.flush()
    expect(h.strip.isBrowsing()).toBe(false)
    expect(h.strip.cursor).toBe(1.25)
    expect(
      h.backend
        .ons()
        .slice(before)
        .map((c) => c.note),
    ).toEqual([69])
    expect(h.session.ui.get()).toMatchObject({ repeat: true, range: loop })
  })

  it.each([false, true])(
    'Listen keeps an outside-loop cursor at its range with an existing transport: %s',
    async (started) => {
      const h = harness(melody, { hands: 'none', range: { fromOcc: 1, toOcc: 1 } })
      if (started) {
        await h.session.start()
        h.step(1500)
      }
      browse(h, rat(1, 4))
      const before = h.backend.ons().length
      await h.session.start()
      h.frames.flush()
      expect(h.strip.isBrowsing()).toBe(false)
      expect(h.strip.cursor).toBe(1)
      expect(
        h.backend
          .ons()
          .slice(before)
          .map((c) => c.note),
      ).toEqual([67])
    },
  )

  it.each(['browse', 'seek'] as const)('takes the latest %s while browser sound loads', async (change) => {
    const sound = pendingSound()
    const h = harness(melody, { hands: 'none' }, { deps: sound.deps })
    h.midi.out = null
    browse(h, rat(1, 2))
    const starting = h.session.start()
    if (change === 'browse') browse(h, rat(1, 4))
    else h.session.seekPosition(rat(1, 4))
    sound.resolve()
    await starting
    h.frames.flush()
    expect(h.strip.isBrowsing()).toBe(false)
    expect(h.strip.cursor).toBe(0.25)
    expect(sound.backend.ons().map((c) => c.note)).toEqual([62])
    h.step(500)
    expect(h.strip.cursor).toBe(0.375)
  })

  it.each(['browse', 'seek'] as const)(
    'a %s during an output change replaces the saved Listen position',
    async (change) => {
      const sound = pendingSound()
      const h = harness(melody, { hands: 'none' }, { deps: sound.deps })
      h.session.seekPosition(rat(1))
      await h.session.start()
      h.step(500)
      h.session.pause()
      h.midi.out = null
      const starting = h.session.start()
      if (change === 'browse') browse(h, rat(1, 4))
      else h.session.seekPosition(rat(1, 4))
      sound.resolve()
      await starting
      h.frames.flush()
      expect(h.strip.isBrowsing()).toBe(false)
      expect(h.strip.cursor).toBe(0.25)
      expect(sound.backend.ons().map((c) => c.note)).toEqual([62])
    },
  )
})
