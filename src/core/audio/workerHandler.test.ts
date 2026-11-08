import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import type { ScoreModel } from '../model/score'
import { ZERO, rat, toNumber } from '../music/rational'
import { perform } from './evaluate'
import type { FollowerResponse } from './protocol'
import { renderNotes } from './testkit'
import { createFollowerWorkerHandler } from './workerHandler'

async function setup() {
  const model = (await importFixture('unequal-rhythms.musicxml')).package.model
  const perf = perform(model, model.tempo, { factor: 1 })
  const audio = renderNotes(perf.notes, { sampleRate: 44100 })
  const posted: FollowerResponse[] = []
  const handle = createFollowerWorkerHandler((r) => posted.push(r))
  const feed = (from: number, to: number, block = 441) => {
    for (let s = from; s + block <= Math.min(to, audio.length); s += block) {
      handle({ type: 'samples', samples: audio.subarray(s, s + block), sampleRate: 44100 })
    }
  }
  const estimates = () => posted.filter((r) => r.type === 'estimate') as { position: number; confidence: number }[]
  return { model, perf, audio, posted, handle, feed, estimates }
}

describe('follower worker handler', () => {
  it('ignores samples before configuration and estimates every 20 ms of audio afterwards', async () => {
    const { model, audio, posted, handle, feed, estimates } = await setup()
    feed(0, 44100)
    expect(posted).toEqual([])
    handle({ type: 'configure', model, tempo: model.tempo, multiplier: 1, position: null })
    feed(0, audio.length)
    const est = estimates()
    expect(est.length).toBeGreaterThan(audio.length / 882 - 2)
    expect(est.length).toBeLessThanOrEqual(audio.length / 882)
    const end = toNumber(model.totalDuration)
    expect(est[est.length - 1]!.position).toBeGreaterThan(end * 0.9)
    // Confident while the music sounds (the silent tail after the last release is not).
    expect(est[Math.floor(est.length / 2)]!.confidence).toBeGreaterThan(0.5)
    // Monotone apart from small jitter: it never runs ahead of the audio by more than a bar.
    for (let i = 1; i < est.length; i++) expect(est[i]!.position - est[i - 1]!.position).toBeLessThan(1)
  })

  it('pauses, resumes and restarts at a position', async () => {
    const { model, perf, audio, handle, feed, estimates, posted } = await setup()
    handle({ type: 'configure', model, tempo: model.tempo, multiplier: 1, position: null })
    const half = Math.floor(audio.length / 2)
    feed(0, half)
    const before = estimates().length
    expect(before).toBeGreaterThan(0)
    handle({ type: 'pause' })
    feed(half, half + 44100)
    expect(estimates().length).toBe(before)
    handle({ type: 'resume' })
    // Restart at the onset the second half of the audio begins near.
    const onset = perf.onsets.find((o) => o.time * 44100 >= half)!
    posted.length = 0
    handle({ type: 'reset', position: rat(Math.round(onset.position * 1e6), 1e6) })
    feed(Math.round(onset.time * 44100) - 4410, audio.length)
    const est = estimates()
    expect(est.length).toBeGreaterThan(10)
    expect(est[0]!.position).toBeGreaterThanOrEqual(onset.position - 0.26)
    expect(est[est.length - 1]!.position).toBeGreaterThan(est[0]!.position)
  })

  it('rebuilds at another speed without losing the position', async () => {
    const { model, audio, handle, feed, estimates, posted } = await setup()
    handle({ type: 'configure', model, tempo: model.tempo, multiplier: 1, position: null })
    feed(0, Math.floor(audio.length / 2))
    const at = estimates()[estimates().length - 1]!.position
    posted.length = 0
    handle({ type: 'configure', model, tempo: model.tempo, multiplier: 0.8, position: rat(Math.round(at * 1e6), 1e6) })
    feed(Math.floor(audio.length / 2), audio.length)
    const est = estimates()
    expect(est.length).toBeGreaterThan(10)
    expect(est[est.length - 1]!.position).toBeGreaterThan(at)
  })

  it('reports a score without a tempo as an error instead of throwing', async () => {
    const { model, audio, handle, posted } = await setup()
    const untimed = { ...model, tempo: { ...model.tempo, segments: [] } } as ScoreModel
    handle({ type: 'configure', model: untimed, tempo: untimed.tempo, multiplier: 1, position: ZERO })
    handle({ type: 'samples', samples: audio.subarray(0, 441), sampleRate: 44100 })
    expect(posted).toEqual([{ type: 'error', message: expect.stringMatching(/tempo/) }])
  })
})
