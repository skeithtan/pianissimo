import { describe, expect, it } from 'vitest'
import { MidiDecoder, ccBytes, noteOffBytes, noteOnBytes } from './decode'
import type { MidiInputEvent } from './types'

function decodeAll(chunks: ReadonlyArray<readonly number[]>, dec = new MidiDecoder()): MidiInputEvent[] {
  const out: MidiInputEvent[] = []
  chunks.forEach((bytes, i) => dec.decode(bytes, 100 + i, 'in-1', (ev) => out.push(ev)))
  return out
}

describe('MidiDecoder (spec "MIDI input, output, and pedal controls")', () => {
  it('decodes Note On, Note Off, velocity, channel, time and port', () => {
    const [on, off] = decodeAll([
      [0x93, 60, 100],
      [0x83, 60, 40],
    ])
    expect(on).toEqual({ kind: 'noteon', seq: 1, channel: 3, note: 60, velocity: 100, time: 100, portId: 'in-1' })
    expect(off).toEqual({ kind: 'noteoff', seq: 2, channel: 3, note: 60, velocity: 40, time: 101, portId: 'in-1' })
  })

  it('treats Note On with velocity 0 as a release', () => {
    const [ev] = decodeAll([[0x90, 64, 0]])
    expect(ev).toMatchObject({ kind: 'noteoff', note: 64, velocity: 0 })
  })

  it('keeps continuous controller values (pedals)', () => {
    const evs = decodeAll([
      [0xb0, 64, 0],
      [0xb0, 64, 37],
      [0xb0, 66, 127],
      [0xb0, 67, 90],
    ])
    expect(evs.map((e) => (e.kind === 'cc' ? [e.controller, e.value] : null))).toEqual([
      [64, 0],
      [64, 37],
      [66, 127],
      [67, 90],
    ])
  })

  it('issues one monotonically increasing seq per event across calls', () => {
    const dec = new MidiDecoder()
    const evs = decodeAll(
      [
        [0x90, 60, 90],
        [0x80, 60, 0],
        [0xb0, 64, 127],
        [0x90, 62, 1],
      ],
      dec,
    )
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(dec.lastSeq).toBe(4)
    expect(decodeAll([[0x90, 61, 50]], dec)[0]!.seq).toBe(5)
  })

  it('decodes several messages in one buffer, including running status, in order', () => {
    const evs = decodeAll([[0x90, 60, 90, 64, 80, 60, 0, 0xb0, 64, 127]])
    expect(evs.map((e) => `${e.kind}${e.kind === 'cc' ? e.controller : e.note}`)).toEqual([
      'noteon60',
      'noteon64',
      'noteoff60',
      'cc64',
    ])
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('skips real-time bytes anywhere, SysEx, system common, aftertouch, program change and pitch bend', () => {
    const evs = decodeAll([
      [0xf8, 0x90, 0xfe, 60, 90],
      [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7, 0x90, 61, 91],
      [0xf2, 0x10, 0x20, 0x90, 62, 92],
      [0xa0, 60, 10, 0xc0, 5, 0xd0, 20, 0xe0, 0, 64],
    ])
    expect(evs.map((e) => (e.kind === 'noteon' ? e.note : -1))).toEqual([60, 61, 62])
  })

  it('drops a truncated or interrupted message and stray data bytes without inventing events', () => {
    expect(decodeAll([[0x90, 60]])).toEqual([])
    expect(decodeAll([[0x40, 0x40]])).toEqual([])
    const evs = decodeAll([[0x90, 60, 0x80, 61, 0]])
    expect(evs.map((e) => `${e.kind}${e.kind === 'cc' ? '' : e.note}`)).toEqual(['noteoff61'])
  })

  it('builds output bytes with channel and 7-bit masking', () => {
    expect(noteOnBytes(15, 60, 100)).toEqual([0x9f, 60, 100])
    expect(noteOffBytes(1, 60)).toEqual([0x81, 60, 0])
    expect(ccBytes(2, 64, 127)).toEqual([0xb2, 64, 127])
    expect(noteOnBytes(0, 200, 200)).toEqual([0x90, 200 & 0x7f, 200 & 0x7f])
  })
})
