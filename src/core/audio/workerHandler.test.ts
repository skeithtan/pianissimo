import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { ZERO, toNumber } from '../music/rational'
import { perform } from './evaluate'
import { attackGroups } from './index'
import type { FollowerResponse } from './protocol'
import { renderNotes } from './testkit'
import { createFollowerWorkerHandler } from './workerHandler'

async function setup() {
  const model = (await importFixture('unequal-rhythms.musicxml')).package.model
  const perf = perform(model, model.tempo, { factor: 1 })
  const audio = renderNotes(perf.notes, { sampleRate: 44100 })
  const groups = attackGroups(model)
  const posted: FollowerResponse[] = []
  const handle = createFollowerWorkerHandler((r) => posted.push(r))
  /** Feeds the audio from one time to another in 512-sample blocks, as the worklet does. */
  const feed = (from: number, to: number) => {
    const end = Math.min(Math.round(to * 44100), audio.length)
    for (let s = Math.round(from * 44100); s + 512 <= end; s += 512) {
      handle({ type: 'samples', samples: audio.subarray(s, s + 512), sampleRate: 44100 })
    }
  }
  const estimates = () => posted.filter((r) => r.type === 'estimate') as { position: number; confidence: number }[]
  return { model, perf, audio, groups, posted, handle, feed, estimates }
}

describe('follower worker handler', () => {
  it('ignores samples before configuration and posts each group once as it is heard', async () => {
    const { model, perf, groups, posted, handle, feed, estimates } = await setup()
    feed(0, 1)
    expect(posted).toEqual([])
    handle({ type: 'configure', model, position: null })
    feed(0, Infinity)
    const est = estimates()
    // One message per attack, in order, at the groups' own positions: nothing while notes ring.
    expect(est.map((e) => e.position)).toEqual(groups.map((g) => toNumber(g.position)))
    expect(est.length).toBe(perf.onsets.length)
    expect(est.every((e) => e.confidence > 0.5)).toBe(true)
  })

  it('pauses, listens afresh on resume and restarts at a position', async () => {
    const { model, perf, groups, handle, feed, estimates, posted } = await setup()
    handle({ type: 'configure', model, position: null })
    const half = perf.onsets[4]!.time - 0.1
    feed(0, half)
    expect(estimates().length).toBe(4)
    handle({ type: 'pause' })
    feed(half, half + 1)
    expect(estimates().length).toBe(4)
    // Resume at a later group: what sounds when the stream comes back is not an attack.
    posted.length = 0
    const g = 6
    handle({ type: 'reset', position: groups[g]!.position })
    handle({ type: 'resume' })
    feed(perf.onsets[g]!.time - 0.4, Infinity)
    const est = estimates()
    expect(est[0]!.position).toBe(toNumber(groups[g]!.position))
    expect(est.length).toBe(groups.length - g)
  })

  it('a resume without a pause does not make it deaf for a moment', async () => {
    const { model, perf, handle, feed, estimates } = await setup()
    handle({ type: 'configure', model, position: ZERO })
    feed(0, perf.onsets[0]!.time - 0.02)
    handle({ type: 'resume' })
    feed(perf.onsets[0]!.time - 0.02, perf.onsets[1]!.time - 0.05)
    expect(estimates().length).toBe(1)
  })

  it('reports a failure as an error instead of throwing', async () => {
    const { audio, handle, posted } = await setup()
    handle({ type: 'configure', model: null as never, position: ZERO })
    handle({ type: 'samples', samples: audio.subarray(0, 512), sampleRate: 44100 })
    expect(posted.length).toBe(1)
    expect(posted[0]!.type).toBe('error')
  })
})
