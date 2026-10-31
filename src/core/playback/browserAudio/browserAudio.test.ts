import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeAudioContext, asContext, type FakeBufferSource, type FakeGain } from '../fakeWebAudio'
import { BrowserAudioBackend } from './backend'
import { DECODED_BUDGET_BYTES, type FetchLike, SampleBank, monoTruncate, parseManifest } from './samples'

const SAMPLE_DIR = resolve(__dirname, '../../../../public/samples/salamander')

function bytesResponse(bytes: Uint8Array | null) {
  return Promise.resolve({
    ok: bytes !== null,
    status: bytes ? 200 : 404,
    arrayBuffer: () => Promise.resolve((bytes ?? new Uint8Array()).slice().buffer),
  })
}

/** Serves a small manifest and fixed-size files; `missing` names answer 404. */
function fakeFetch(samples: Record<string, number>, size = 1000, missing: readonly string[] = []) {
  const urls: string[] = []
  const fetch: FetchLike = (url) => {
    urls.push(url)
    if (url.endsWith('manifest.json')) {
      return bytesResponse(new TextEncoder().encode(JSON.stringify({ samples, extension: 'mp3' })))
    }
    const name = url.slice(url.lastIndexOf('/') + 1, -4)
    return bytesResponse(missing.includes(name) ? null : new Uint8Array(size))
  }
  return { fetch, urls }
}

const gainOf = (ctx: FakeAudioContext, src: FakeBufferSource): FakeGain =>
  ctx.gains.find((g) => src.connections.includes(g))!

describe('monoTruncate (decoded budget)', () => {
  it('averages channels into mono and fades only where a sample is cut', () => {
    const ctx = new FakeAudioContext(10)
    const src = ctx.createBuffer(2, 10, 10)
    src.getChannelData(0).fill(1)
    src.getChannelData(1).fill(0.5)
    const cut = monoTruncate(asContext(ctx), src as unknown as AudioBuffer, 6, 2)
    expect(cut.numberOfChannels).toBe(1)
    expect(Array.from(cut.getChannelData(0))).toEqual([0.75, 0.75, 0.75, 0.75, 0.375, 0])
    const whole = monoTruncate(asContext(ctx), src as unknown as AudioBuffer, 50, 2)
    expect(whole.length).toBe(10)
    expect(whole.getChannelData(0)[9]).toBe(0.75)
  })
})

describe('SampleBank', () => {
  it('loads the manifest and samples, reporting transferred and decoded bytes', async () => {
    const ctx = new FakeAudioContext(48_000, { seconds: 8, channels: [0.2, 0.2] })
    const { fetch, urls } = fakeFetch({ C4: 60, Ds4: 63, Fs4: 66 }, 1000)
    const progress: number[] = []
    const bank = new SampleBank({
      context: asContext(ctx),
      baseUrl: '/base/samples/salamander/',
      fetch,
      onProgress: (s) => progress.push(s.loaded),
    })
    await bank.load()
    const stats = bank.stats()
    expect(urls[0]).toBe('/base/samples/salamander/manifest.json')
    expect(urls.slice(1).sort()).toEqual([
      '/base/samples/salamander/C4.mp3',
      '/base/samples/salamander/Ds4.mp3',
      '/base/samples/salamander/Fs4.mp3',
    ])
    expect(stats.status).toBe('ready')
    expect(stats.loaded).toBe(3)
    expect(stats.transferredBytes).toBe(
      3000 + JSON.stringify({ samples: { C4: 60, Ds4: 63, Fs4: 66 }, extension: 'mp3' }).length,
    )
    // Each cut to 5 s mono Float32.
    expect(stats.decodedBytes).toBe(3 * 5 * 48_000 * 4)
    expect(progress.at(-1)).toBe(3)
  })

  it('finds the nearest loaded sample within six semitones', async () => {
    const ctx = new FakeAudioContext()
    const bank = new SampleBank({ context: asContext(ctx), baseUrl: '/', fetch: fakeFetch({ C4: 60, Ds4: 63 }).fetch })
    expect(bank.nearest(60)).toBeNull()
    await bank.load()
    expect(bank.nearest(61)?.midi).toBe(60)
    expect(bank.nearest(62)?.midi).toBe(63)
    expect(bank.nearest(75)).toBeNull()
  })

  it('marks partial and complete failures (the synth covers the gaps)', async () => {
    const ctx = new FakeAudioContext()
    const partial = new SampleBank({
      context: asContext(ctx),
      baseUrl: '/',
      fetch: fakeFetch({ C4: 60, Ds4: 63 }, 10, ['Ds4']).fetch,
    })
    await partial.load()
    expect(partial.stats()).toMatchObject({ status: 'partial', loaded: 1, failed: 1, total: 2 })
    const broken: FetchLike = () => bytesResponse(null)
    const failed = new SampleBank({ context: asContext(ctx), baseUrl: '/', fetch: broken })
    await failed.load()
    expect(failed.stats().status).toBe('failed')
  })

  it('the shipped Salamander bank fits 8 MB transferred and 32 MiB decoded, even at 96 kHz', async () => {
    const manifestText = readFileSync(resolve(SAMPLE_DIR, 'manifest.json'), 'utf8')
    const manifest = parseManifest(manifestText)
    expect(Object.keys(manifest.samples)).toHaveLength(30)
    const fetch: FetchLike = (url) => {
      const file = url.slice(url.lastIndexOf('/') + 1)
      return bytesResponse(new Uint8Array(readFileSync(resolve(SAMPLE_DIR, file))))
    }
    for (const rate of [44_100, 48_000, 96_000]) {
      const ctx = new FakeAudioContext(rate, { seconds: 12, channels: [0.1, 0.1] })
      const bank = new SampleBank({ context: asContext(ctx), baseUrl: '/', fetch })
      await bank.load()
      const s = bank.stats()
      expect(s.status).toBe('ready')
      expect(s.decodedBytes).toBeLessThanOrEqual(DECODED_BUDGET_BYTES)
      expect(s.transferredBytes).toBeLessThanOrEqual(8_000_000)
      const onDisk = Object.keys(manifest.samples).reduce(
        (sum, n) => sum + statSync(resolve(SAMPLE_DIR, `${n}.mp3`)).size,
        0,
      )
      expect(s.transferredBytes).toBe(onDisk + Buffer.byteLength(manifestText))
    }
  })

  it('rejects a malformed manifest', () => {
    expect(() => parseManifest('{"samples":{"../x":60},"extension":"mp3"}')).toThrow()
    expect(() => parseManifest('{"samples":{"C4":"60"},"extension":"mp3"}')).toThrow()
    expect(() => parseManifest('[]')).toThrow()
  })
})

describe('BrowserAudioBackend', () => {
  const make = (samples: Record<string, number> = { C4: 60 }) => {
    const ctx = new FakeAudioContext()
    let now = 0
    const be = new BrowserAudioBackend({
      context: asContext(ctx),
      clock: () => now,
      baseUrl: '/',
      fetch: fakeFetch(samples).fetch,
    })
    return { ctx, be, setNow: (t: number) => (now = t) }
  }

  it('plays the synth fallback until samples load, then repitched samples', async () => {
    const { ctx, be } = make()
    be.noteOn(60, 100, 0)
    expect(ctx.oscillators).toHaveLength(1)
    expect(ctx.sources).toHaveLength(0)
    await be.load()
    be.noteOn(62, 100, 0)
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0]!.playbackRate.value).toBeCloseTo(2 ** (2 / 12))
    expect(be.stats().loaded).toBe(1)
  })

  it('schedules against the context clock from performance.now() times', async () => {
    const { ctx, be, setNow } = make()
    await be.load()
    ctx.currentTime = 10
    setNow(5000)
    be.noteOn(60, 100, 5250)
    expect(ctx.sources[0]!.startAt).toBeCloseTo(10.25)
    be.noteOn(64, 100, 4000)
    expect(ctx.sources[1]!.startAt).toBe(10)
  })

  it('keeps an overlapping same-pitch note until its own release; a re-strike damps the old voice', async () => {
    const { ctx, be } = make()
    await be.load()
    be.noteOn(60, 100, 0)
    be.noteOn(60, 100, 500)
    const [first, second] = ctx.sources
    expect(gainOf(ctx, first!).gain.releasedAt()).toBeCloseTo(0.5)
    be.noteOff(60, 600)
    expect(gainOf(ctx, second!).gain.releasedAt()).toBeNull()
    be.noteOff(60, 1000)
    expect(gainOf(ctx, second!).gain.releasedAt()).toBeCloseTo(1)
  })

  it('holds released notes while sustain is down and releases them on pedal up', async () => {
    const { ctx, be } = make()
    await be.load()
    be.controlChange(64, 127, 0)
    be.noteOn(60, 100, 0)
    be.noteOff(60, 500)
    const g = gainOf(ctx, ctx.sources[0]!)
    expect(g.gain.releasedAt()).toBeNull()
    be.controlChange(64, 0, 2000)
    expect(g.gain.releasedAt()).toBeCloseTo(2)
  })

  it('sostenuto holds only notes keyed when it went down; soft pedal lowers new attacks', async () => {
    const { ctx, be } = make()
    await be.load()
    be.noteOn(60, 127, 0)
    be.controlChange(66, 127, 100)
    be.noteOn(62, 127, 200)
    be.noteOff(60, 300)
    be.noteOff(62, 300)
    expect(gainOf(ctx, ctx.sources[0]!).gain.releasedAt()).toBeNull()
    expect(gainOf(ctx, ctx.sources[1]!).gain.releasedAt()).toBeCloseTo(0.3)
    be.controlChange(66, 0, 1000)
    expect(gainOf(ctx, ctx.sources[0]!).gain.releasedAt()).toBeCloseTo(1)
    be.controlChange(67, 127, 1000)
    be.noteOn(64, 127, 1100)
    const loud = gainOf(ctx, ctx.sources[0]!).gain.calls[0]![1]!
    const soft = gainOf(ctx, ctx.sources[2]!).gain.calls[0]![1]!
    expect(soft).toBeLessThan(loud)
  })

  it('cleanup kills voices that have not started and fades sounding ones, leaving monitored input alone', async () => {
    const { ctx, be } = make()
    await be.load()
    ctx.currentTime = 1
    be.noteOn(60, 100, 0)
    be.noteOn(62, 100, 3000)
    be.monitor({ kind: 'noteon', seq: 1, channel: 0, note: 64, velocity: 90, time: 0, portId: 'in' })
    be.cleanup()
    const [sounding, future, monitored] = ctx.sources
    expect(gainOf(ctx, sounding!).gain.releasedAt()).toBe(1)
    expect(gainOf(ctx, future!).disconnected).toBe(true)
    expect(gainOf(ctx, monitored!).gain.releasedAt()).toBeNull()
    be.stopSound()
    expect(gainOf(ctx, monitored!).gain.releasedAt()).toBe(1)
  })

  it('releases a monitored key on its note-off', async () => {
    const { ctx, be } = make()
    await be.load()
    be.monitor({ kind: 'noteon', seq: 1, channel: 0, note: 60, velocity: 90, time: 0, portId: 'in' })
    be.monitor({ kind: 'noteoff', seq: 2, channel: 0, note: 60, velocity: 0, time: 0, portId: 'in' })
    expect(gainOf(ctx, ctx.sources[0]!).gain.releasedAt()).toBe(0)
  })

  it('applies the master volume and disconnects on dispose', () => {
    const { ctx, be } = make()
    const master = ctx.gains[0]!
    expect(master.gain.value).toBe(0.8)
    be.setVolume(2)
    expect(master.gain.value).toBe(1)
    be.dispose()
    expect(master.disconnected).toBe(true)
  })
})
