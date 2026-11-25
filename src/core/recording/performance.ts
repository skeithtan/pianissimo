import type { MidiInputEvent } from '../midi/types'
import { ccBytes, noteOffBytes, noteOnBytes } from '../midi/decode'

export interface NoteScore {
  readonly expected: number
  readonly played: number
  readonly matched: number
}

/** The notes of a passage, in score order. */
type Groups = readonly (readonly number[])[]

const noteCount = (groups: Groups): number => groups.reduce((n, pitches) => n + pitches.length, 0)

/** Ordered pitch matches of all `groups` with the first j attacks, for every j. Notes within each
 * written chord may be played in any order.
 * previous[j] is the best match through the first j attacks before this score group.
 * For a chord ending at j, try its most recent distinct pitches, newest first. */
function bestMatches(groups: Groups, played: readonly number[]): Uint32Array {
  let previous = new Uint32Array(played.length + 1)
  let current = new Uint32Array(previous.length)
  for (const pitches of groups) {
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
  return previous
}

export function scorePerformance(groups: Groups, played: readonly number[]): NoteScore {
  const matched = bestMatches(groups, played)[played.length]!
  return { expected: noteCount(groups), played: played.length, matched }
}

/** The opening and the ending of a passage are this share of its onsets, and at least `MIN_EDGE`. */
const EDGE_SHARE = 0.05
const MIN_EDGE = 2
/** An end is reached when this share of its notes was matched. */
const EDGE_NOTES = 1 / 3

/**
 * Was the last `edge` of `groups` reached? Surely, when its notes add to the match. Where they can
 * be matched earlier just as well (an even accompaniment), only `benefit` of the doubt says so.
 */
function reachesEnd(groups: Groups, played: readonly number[], edge: number, benefit: boolean): boolean {
  const ending = groups.slice(groups.length - edge)
  const before = bestMatches(groups.slice(0, groups.length - edge), played)
  const after = bestMatches([...ending].reverse(), [...played].reverse())
  const n = played.length
  const need = Math.ceil(noteCount(ending) * EDGE_NOTES)
  let total = 0
  for (let j = 0; j <= n; j++) total = Math.max(total, before[j]! + after[n - j]!)
  if (total - before[n]! >= need) return true
  if (!benefit) return false
  for (let j = 0; j <= n; j++) if (after[n - j]! >= need && before[j]! + after[n - j]! === total) return true
  return false
}

/**
 * Was the passage played from its opening to its ending? Wrong and missed notes do not matter, only
 * how far the playing reached. Bulk deletion relies on it, so doubt counts as played through, unless
 * a quarter or more of the notes were not even attempted.
 */
export function playedThrough(groups: Groups, played: readonly number[]): boolean {
  const expected = noteCount(groups)
  if (played.length === 0 || played.length < expected / 2) return false
  const edge = Math.min(groups.length, Math.max(MIN_EDGE, Math.ceil(groups.length * EDGE_SHARE)))
  const benefit = played.length >= expected * 0.75
  return (
    reachesEnd(groups, played, edge, benefit) && reachesEnd([...groups].reverse(), [...played].reverse(), edge, benefit)
  )
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

/** The attacks of a Standard MIDI File of one track, in order: what `midiFile` writes, read back. */
export function midiNotes(file: ArrayBuffer): number[] {
  const bytes = new Uint8Array(file)
  const notes: number[] = []
  let at = 22
  let status = 0
  const length = () => {
    let value = 0
    for (let byte = 128; byte & 128 && at < bytes.length;) {
      byte = bytes[at++]!
      value = value * 128 + (byte & 127)
    }
    return value
  }
  while (at < bytes.length) {
    length()
    if (at >= bytes.length) break
    if (bytes[at]! & 128) status = bytes[at++]!
    if (status === 0xff) at++
    if (status >= 0xf0) {
      const skipped = length()
      at += skipped
    } else {
      const kind = status & 0xf0
      if (kind === 0x90 && (bytes[at + 1] ?? 0) > 0) notes.push(bytes[at]!)
      at += kind === 0xc0 || kind === 0xd0 ? 1 : 2
    }
  }
  return notes
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
