import type { MidiInputEvent } from '../midi/types'
import { ccBytes, noteOffBytes, noteOnBytes } from '../midi/decode'

export interface NoteScore {
  readonly expected: number
  readonly played: number
  readonly matched: number
}

/** Ordered pitch matches. Notes within each written chord may be played in any order.
 * previous[j] is the best match through the first j attacks before this score group.
 * For a chord ending at j, try its most recent distinct pitches, newest first. */
export function scorePerformance(groups: readonly (readonly number[])[], played: readonly number[]): NoteScore {
  let previous = new Uint32Array(played.length + 1)
  let current = new Uint32Array(previous.length)
  let expected = 0
  for (const pitches of groups) {
    expected += pitches.length
    const last = new Map<number, number>()
    for (let j = 0; j < played.length; j++) {
      let best = Math.max(previous[j + 1]!, current[j]!)
      const note = played[j]!
      if (pitches.includes(note)) {
        last.delete(note)
        last.set(note, j)
        let count = last.size
        for (const at of last.values()) best = Math.max(best, previous[at]! + count--)
      }
      current[j + 1] = best
    }
    const swap = previous
    previous = current
    current = swap
  }
  return { expected, played: played.length, matched: previous[played.length]! }
}

export function noteAccuracy(s: NoteScore): number {
  return s.expected + s.played ? (2 * s.matched) / (s.expected + s.played) : 0
}

/** Standard MIDI File, format 0. A tick is one millisecond at 500 PPQ and 120 BPM. */
export function midiFile(events: readonly MidiInputEvent[], start: number, end: number): Blob {
  const track: number[] = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20]
  let tick = 0
  const delta = (time: number) => {
    const next = Math.max(tick, Math.round(time - start))
    let n = next - tick
    const bytes = [n & 127]
    while ((n = Math.floor(n / 128)) > 0) bytes.unshift((n & 127) | 128)
    track.push(...bytes)
    tick = next
  }
  const held = new Set<number>()
  const pedals = new Set<number>()
  for (const e of events) {
    delta(e.time)
    if (e.kind === 'cc') {
      track.push(...ccBytes(e.channel, e.controller, e.value))
      const id = e.channel * 128 + e.controller
      if ([64, 66, 67].includes(e.controller)) {
        if (e.value > 0) pedals.add(id)
        else pedals.delete(id)
      }
    } else {
      const id = e.channel * 128 + e.note
      if (e.kind === 'noteon') {
        held.add(id)
        track.push(...noteOnBytes(e.channel, e.note, e.velocity))
      } else {
        held.delete(id)
        track.push(...noteOffBytes(e.channel, e.note, e.velocity))
      }
    }
  }
  for (const id of held) {
    delta(end)
    track.push(...noteOffBytes(id >> 7, id & 127, 0))
  }
  for (const id of pedals) {
    delta(end)
    track.push(...ccBytes(id >> 7, id & 127, 0))
  }
  delta(end)
  track.push(0xff, 0x2f, 0)
  const size = track.length
  return new Blob(
    [
      new Uint8Array([
        77,
        84,
        104,
        100,
        0,
        0,
        0,
        6,
        0,
        0,
        0,
        1,
        1,
        244,
        77,
        84,
        114,
        107,
        size >>> 24,
        size >>> 16,
        size >>> 8,
        size,
      ]),
      new Uint8Array(track),
    ],
    { type: 'audio/midi' },
  )
}

export function waveFile(pcm: readonly BlobPart[], bytes: number, channels: number, rate: number): Blob {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const tag = (offset: number, text: string) =>
    new Uint8Array(header, offset, text.length).set(new TextEncoder().encode(text))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, bytes, true)
  return new Blob([header, ...pcm], { type: 'audio/wav' })
}
