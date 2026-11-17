/**
 * Scores the follower on a real recording of the reference piece when one has been dropped into
 * the unpublished tests/fixtures/private/audio/ folder (its README says how), through the same
 * chain as the app (worker, session rule, play-through cursor; DECISIONS P21); skipped otherwise.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES, REFERENCE_PIECE, fixtureExists, importBytes } from '../../../tests/unit/import/fixtures'
import { rat, toNumber } from '../music/rational'
import { buildTimeline } from '../engine'
import { PlayFollower } from '../engine/follow'
import type { ScoreModel } from '../model/score'
import type { TruthOnset } from './evaluate'
import { groupReached } from './groups'
import { createAudioFollower } from './index'

const AUDIO = resolve(FIXTURES, 'private/audio')
const WAV = resolve(AUDIO, 'reference-piece.wav')
const ONSETS = resolve(AUDIO, 'reference-piece.onsets.tsv')
const present = fixtureExists(REFERENCE_PIECE) && fixtureExists(WAV) && fixtureExists(ONSETS)

/** Decodes a RIFF WAVE file (PCM 16/24/32-bit or float 32-bit, any channel count averaged to mono). */
export function readWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAVE file')
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let at = 12
  while (at + 8 <= bytes.length) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      if (format === 0xfffe) format = view.getUint16(body + 24, true) // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      if (!channels || !sampleRate) throw new Error('WAVE data before fmt')
      const bytesPerSample = bits / 8
      const frames = Math.floor(size / (bytesPerSample * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) {
          const p = body + (i * channels + c) * bytesPerSample
          if (format === 3) sum += view.getFloat32(p, true)
          else if (bits === 16) sum += view.getInt16(p, true) / 32768
          else if (bits === 24)
            sum += ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) << 8) / 2147483648
          else if (bits === 32) sum += view.getInt32(p, true) / 2147483648
          else throw new Error(`Unsupported WAVE: format ${format}, ${bits} bits`)
        }
        samples[i] = sum / channels
      }
      return { sampleRate, samples }
    }
    at = body + size + (size & 1)
  }
  throw new Error('WAVE without data')
}

/** `position<TAB>seconds` per line (position in whole notes as a float or `n/d`); `#` starts a comment. */
export function readOnsets(text: string): TruthOnset[] {
  const out: TruthOnset[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const [p, t] = line.split(/\s+/)
    const position = p!.includes('/') ? toNumber(rat(Number(p!.split('/')[0]), Number(p!.split('/')[1]))) : Number(p)
    const time = Number(t)
    if (!Number.isFinite(position) || !Number.isFinite(time)) throw new Error(`Bad onset line: ${raw}`)
    out.push({ position, time })
  }
  return out.sort((a, b) => a.position - b.position)
}

describe('WAVE decoding', () => {
  it('reads 16-bit stereo PCM and averages the channels', () => {
    const frames = 4
    const bytes = new Uint8Array(44 + frames * 4)
    const view = new DataView(bytes.buffer)
    const put = (at: number, s: string) =>
      bytes.set(
        s.split('').map((c) => c.charCodeAt(0)),
        at,
      )
    put(0, 'RIFF')
    view.setUint32(4, 36 + frames * 4, true)
    put(8, 'WAVE')
    put(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 2, true)
    view.setUint32(24, 48000, true)
    view.setUint32(28, 48000 * 4, true)
    view.setUint16(32, 4, true)
    view.setUint16(34, 16, true)
    put(36, 'data')
    view.setUint32(40, frames * 4, true)
    const pcm = [
      [16384, -16384],
      [32767, 32767],
      [-32768, 0],
      [0, 0],
    ]
    pcm.forEach(([l, r], i) => {
      view.setInt16(44 + i * 4, l!, true)
      view.setInt16(46 + i * 4, r!, true)
    })
    const wav = readWav(bytes)
    expect(wav.sampleRate).toBe(48000)
    expect(Array.from(wav.samples).map((v) => Number(v.toFixed(4)))).toEqual([0, 1, -0.5, 0])
  })

  it('parses onset lists with fractions and comments', () => {
    expect(readOnsets('# position seconds\n1/4\t2.5\n0 1.0\n\n0.5\t3 # bar 2\n')).toEqual([
      { position: 0, time: 1 },
      { position: 0.25, time: 2.5 },
      { position: 0.5, time: 3 },
    ])
  })
})

/** The session's acceptance rule for microphone estimates (`PracticeSession.#onMicEstimate`). */
const MIC_CONFIDENCE = 0.5

/**
 * Plays `samples` through the chain the app uses: 512-sample blocks into a follower, an estimate
 * whenever the group heard last changes (the worker), and the session's rule: confidence of at
 * least MIC_CONFIDENCE and not behind the current group, then `PlayFollower.audioReached` over
 * the both-hands timeline. Returns when the cursor released each timeline group (NaN: never).
 */
function sessionReach(
  model: ScoreModel,
  samples: Float32Array,
  sampleRate: number,
): { reached: Float64Array; msPerFrame: number } {
  const timeline = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
  const cursor = new PlayFollower(timeline, { startGroup: 0 }, 0)
  const follower = createAudioFollower(model)
  const reached = new Float64Array(timeline.groups.length).fill(NaN)
  const block = 512
  let frames = 0
  const t0 = performance.now()
  for (let s = 0; s + block <= samples.length; s += block) {
    const est = follower.push(samples.subarray(s, s + block), sampleRate, s / sampleRate)
    frames += est.frames
    if (!est.moved || est.confidence < MIC_CONFIDENCE) continue
    const now = (s + block) / sampleRate
    const current = cursor.state.groupIndex
    const g = groupReached(timeline, est.position)
    if (current === null || g < current) continue
    cursor.audioReached(g, now)
    cursor.drainEvents()
    for (let k = current; k <= g && k < reached.length; k++) if (Number.isNaN(reached[k]!)) reached[k] = now
  }
  return { reached, msPerFrame: (performance.now() - t0) / Math.max(1, frames) }
}

/** Fractional bar number (1-based) of a whole-note position, from the model's bar occurrences. */
function barOf(model: ScoreModel): (position: number) => number {
  const bars = model.occurrences.map((o) => [toNumber(o.start), toNumber(o.duration)] as const)
  return (position) => {
    let i = 0
    while (i + 1 < bars.length && bars[i + 1]![0] <= position + 1e-9) i++
    return i + 1 + (position - bars[i]![0]) / bars[i]![1]
  }
}

/**
 * What the learner sees: every 100 ms from the first listed onset to the last, the bar of the
 * group the cursor released last minus the bar of the onset the player first played last.
 */
function barDistance(
  reached: Float64Array,
  onsets: readonly { group: number; time: number }[],
  barOfGroup: (group: number) => number,
): number[] {
  const played = [...onsets].sort((a, b) => a.time - b.time)
  const released = [...reached.entries()].filter(([, t]) => !Number.isNaN(t)).sort((a, b) => a[1] - b[1])
  const out: number[] = []
  let i = 0
  let j = 0
  let player = -1
  let cursor = -1
  for (let t = played[0]!.time; t <= played.at(-1)!.time + 1e-9; t += 0.1) {
    while (i < played.length && played[i]!.time <= t) player = Math.max(player, played[i++]!.group)
    while (j < released.length && released[j]![1] <= t) cursor = Math.max(cursor, released[j++]![0])
    out.push(barOfGroup(Math.max(cursor, 0)) - (cursor < 0 ? 0.01 : 0) - barOfGroup(player))
  }
  return out
}

describe.skipIf(!present)('the reference piece recording (private)', () => {
  it('the play-through cursor follows the whole recording, start to finish', async () => {
    const model = (await importBytes('reference.musicxml', new Uint8Array(readFileSync(REFERENCE_PIECE)))).package.model
    const wav = readWav(new Uint8Array(readFileSync(WAV)))
    const onsets = readOnsets(readFileSync(ONSETS, 'utf8'))
    expect(onsets.length).toBeGreaterThan(500)
    const timeline = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    const { reached, msPerFrame } = sessionReach(model, wav.samples, wav.sampleRate)
    // Lag of the cursor behind each listed onset's first attack (negative: ahead of the player).
    const lags = onsets.map((o) => reached[groupReached(timeline, o.position)]! - o.time)
    const share = (ok: (lag: number) => boolean) => lags.filter(ok).length / lags.length
    const onTime = share((l) => Math.abs(l) <= 0.15)
    const soon = share((l) => l >= -0.15 && l <= 0.5)
    const ahead = share((l) => l < -0.15)
    const worstLag = Math.max(...lags.map((l) => (Number.isNaN(l) ? Infinity : l)))
    const mostAhead = -Math.min(...lags)
    const last = timeline.groups.length - 1
    const lastOnset = onsets.find((o) => groupReached(timeline, o.position) === last)!
    const end = reached[last]! - lastOnset.time
    const bar = barOf(model)
    const distance = barDistance(
      reached,
      onsets.map((o) => ({ group: groupReached(timeline, o.position), time: o.time })),
      (g) => bar(toNumber(timeline.groups[g]!.position)),
    )
    const near = (bars: number) => distance.filter((d) => Math.abs(d) <= bars).length / distance.length
    const behind = -Math.min(...distance)
    const before = Math.max(...distance)
    const offSeconds = distance.filter((d) => Math.abs(d) > 1).length / 10
    console.info(
      [
        `on time (±150 ms) ${(onTime * 100).toFixed(1)} %, within -150..+500 ms ${(soon * 100).toFixed(1)} %,`,
        `ahead ${(ahead * 100).toFixed(1)} % (at most ${mostAhead.toFixed(1)} s), worst lag ${worstLag.toFixed(1)} s,`,
        `last group ${end.toFixed(2)} s after its attack, ${msPerFrame.toFixed(3)} ms per frame;`,
        `within a quarter bar of the player ${(near(0.25) * 100).toFixed(1)} % of the time, within a bar`,
        `${(near(1) * 100).toFixed(1)} %, at most ${behind.toFixed(2)} bars behind and ${before.toFixed(2)} ahead,`,
        `${offSeconds.toFixed(1)} s more than a bar off`,
        'position\ttime\tlag ms',
        ...onsets.map((o, i) => `${o.position.toFixed(3)}\t${o.time.toFixed(2)}\t${(lags[i]! * 1000).toFixed(0)}`),
      ].join('\n'),
    )
    // Reaches the end, no earlier than the last attack and soon after it.
    expect(end).toBeGreaterThanOrEqual(-0.15)
    expect(end).toBeLessThanOrEqual(1)
    // Never stuck: every listed onset is reached, none more than 16 s late (DECISIONS P21: the
    // worst, 14.7 s, is at 0:41, bar 7.9, where the player hesitated over soft notes).
    expect(worstLag).toBeLessThanOrEqual(16)
    // Never far ahead (measured 8.1 s at 5:07, bar 52.3, in a long hesitation; README "Limits").
    expect(mostAhead).toBeLessThanOrEqual(9)
    // Measured 53.5 %, 67.7 % and 4.2 %.
    expect(onTime).toBeGreaterThanOrEqual(0.51)
    expect(soon).toBeGreaterThanOrEqual(0.65)
    expect(ahead).toBeLessThanOrEqual(0.05)
    // In bars, as the learner sees it. Measured: within a quarter bar 83.7 % of the time, within a
    // bar 99.2 %, at most 1.38 bars behind (2:13) and 1.25 ahead (1:27), 2.9 s more than a bar off.
    expect(near(0.25)).toBeGreaterThanOrEqual(0.81)
    expect(near(1)).toBeGreaterThanOrEqual(0.98)
    expect(behind).toBeLessThanOrEqual(1.6)
    expect(before).toBeLessThanOrEqual(1.4)
    expect(offSeconds).toBeLessThanOrEqual(5)
  }, 300_000)
})
