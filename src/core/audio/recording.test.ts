/**
 * Scores the follower on a real recording of the reference piece when one has been dropped into
 * the unpublished tests/fixtures/private/audio/ folder (its README says how); skipped otherwise.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES, REFERENCE_PIECE, fixtureExists, importBytes } from '../../../tests/unit/import/fixtures'
import { rat, toNumber } from '../music/rational'
import { type TruthOnset, evaluateAudio } from './evaluate'

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

describe.skipIf(!present)('the reference piece recording (private)', () => {
  it('reaches most of the listed onsets within 150 ms', async () => {
    const model = (await importBytes('reference.musicxml', new Uint8Array(readFileSync(REFERENCE_PIECE)))).package.model
    const wav = readWav(new Uint8Array(readFileSync(WAV)))
    const onsets = readOnsets(readFileSync(ONSETS, 'utf8'))
    expect(onsets.length).toBeGreaterThan(0)
    const ev = evaluateAudio(model, wav.samples, wav.sampleRate, onsets, [], { clock: () => performance.now() })
    const table = onsets.map(
      (o, i) => `${o.position.toFixed(3)}\t${o.time.toFixed(2)}\t${(ev.errors[i]! * 1000).toFixed(0)}`,
    )
    console.info(
      [
        `within 100 ms ${(ev.within100 * 100).toFixed(0)} %, within 150 ms ${(ev.within150 * 100).toFixed(0)} %,`,
        `ahead of the player ${(ev.ahead * 100).toFixed(0)} %,`,
        `median ${ev.medianAbsMs.toFixed(0)} ms, ${ev.msPerFrame.toFixed(3)} ms per frame`,
        'position\ttime\terror ms',
        ...table,
      ].join('\n'),
    )
    expect(ev.within150).toBeGreaterThanOrEqual(0.75)
  }, 300_000)
})
