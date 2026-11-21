import { describe, expect, it } from 'vitest'
import { midiFile, noteAccuracy, scorePerformance, waveFile } from './performance'
import type { MidiInputEvent } from '../midi/types'

describe('performance recording', () => {
  it('matches chords in any order, including repeated pitches in consecutive groups', () => {
    const groups = [[60, 64], [60], [62, 65]]
    expect(scorePerformance(groups, [64, 60, 60, 65, 62])).toEqual({ expected: 5, played: 5, matched: 5 })
    expect(scorePerformance(groups, [64, 61, 60, 65])).toEqual({ expected: 5, played: 4, matched: 3 })
    expect(scorePerformance([[60], [62], [64]], [64, 62, 60]).matched).toBe(1)
    expect(noteAccuracy(scorePerformance(groups, []))).toBe(0)
    expect(noteAccuracy(scorePerformance([[60], [62]], [60, 61, 62]))).toBe(0.8)
  })
  it('writes timed key and pedal events, releasing held keys and pedals at Stop', async () => {
    const common = { channel: 2, seq: 1, portId: 'p' }
    const events: MidiInputEvent[] = [
      { ...common, kind: 'noteon', note: 60, velocity: 92, time: 120 },
      { ...common, kind: 'cc', controller: 64, value: 85, time: 320 },
      { ...common, kind: 'noteoff', note: 60, velocity: 19, time: 330 },
      { ...common, kind: 'noteon', note: 72, velocity: 51, time: 340 },
    ]
    const bytes = new Uint8Array(await midiFile(events, 100, 640).arrayBuffer())
    expect([...bytes.slice(0, 14)]).toEqual([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 244])
    expect(new DataView(bytes.buffer).getUint32(18)).toBe(bytes.length - 22)
    expect([...bytes.slice(29)]).toEqual([
      20, 146, 60, 92, 129, 72, 178, 64, 85, 10, 130, 60, 19, 10, 146, 72, 51, 130, 44, 130, 72, 0, 0, 178, 64, 0, 0,
      255, 47, 0,
    ])
  })
  it('writes a PCM WAV with the original channel order, rate and exact frame count', async () => {
    const bytes = await waveFile([new Int16Array([123, -321, 1, -1]).buffer], 8, 2, 48000).arrayBuffer()
    const v = new DataView(bytes)
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint32(40, true)).toBe(8)
    expect(v.getInt16(46, true)).toBe(-321)
  })
})
