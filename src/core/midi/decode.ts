/**
 * MIDI byte decoding for the input path (spec "MIDI input, output, and pedal controls":
 * Note On, Note Off, velocity, timestamps, channels and controller messages; Note On with
 * zero velocity is a release; continuous pedal values are preserved).
 *
 * Runs inside `onmidimessage`, so it allocates only the emitted event objects. Web MIDI
 * delivers one message per event, but a buffer holding several messages (with running
 * status) is also decoded, which some polyfills and BLE bridges produce. System real-time
 * (clock, active sensing), system common and SysEx bytes are skipped.
 */
import type { MidiInputEvent } from './types'

export type MidiEventSink = (ev: MidiInputEvent) => void

/** Data bytes following a channel-voice status nibble (0x8..0xE). */
const CHANNEL_DATA_LENGTH = [2, 2, 2, 2, 1, 1, 2] as const
/** Data bytes following system common statuses 0xF1..0xF6. */
const SYSTEM_COMMON_LENGTH: Readonly<Record<number, number>> = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf6: 0 }

/**
 * Stateful decoder owning the monotonically increasing `seq` counter. One decoder per
 * adapter, so sequence numbers are unique across ports and reconnections.
 */
export class MidiDecoder {
  private seq = 0

  /** Last sequence number issued (0 before the first event). */
  get lastSeq(): number {
    return this.seq
  }

  /**
   * Decode every message in `data` and push each event to `sink` synchronously, in order.
   * Returns the number of events emitted.
   */
  decode(data: ArrayLike<number>, time: number, portId: string, sink: MidiEventSink): number {
    let emitted = 0
    let status = 0
    let i = 0
    const n = data.length
    while (i < n) {
      const b = data[i]!
      if (b >= 0xf8) {
        i++ // real-time bytes may interleave anywhere
        continue
      }
      if (b === 0xf0) {
        i++
        while (i < n && data[i] !== 0xf7) i++
        i++
        status = 0
        continue
      }
      if (b >= 0xf0) {
        i += 1 + (SYSTEM_COMMON_LENGTH[b] ?? 0)
        status = 0
        continue
      }
      if (b >= 0x80) {
        status = b
        i++
        continue
      }
      if (status === 0) {
        i++ // stray data byte without status
        continue
      }
      const kind = status >> 4
      const len = CHANNEL_DATA_LENGTH[kind - 8] ?? 2
      const d1 = b
      let d2 = 0
      i++
      if (len === 2) {
        while (i < n && data[i]! >= 0xf8) i++ // real-time bytes may sit between data bytes
        if (i >= n) break // truncated message
        if (data[i]! >= 0x80) continue // a new status interrupts this message: drop it
        d2 = data[i]!
        i++
      }
      const channel = status & 0x0f
      if (kind === 0x9) {
        this.seq++
        sink(
          d2 === 0
            ? { kind: 'noteoff', seq: this.seq, channel, note: d1, velocity: 0, time, portId }
            : { kind: 'noteon', seq: this.seq, channel, note: d1, velocity: d2, time, portId },
        )
        emitted++
      } else if (kind === 0x8) {
        this.seq++
        sink({ kind: 'noteoff', seq: this.seq, channel, note: d1, velocity: d2, time, portId })
        emitted++
      } else if (kind === 0xb) {
        this.seq++
        sink({ kind: 'cc', seq: this.seq, channel, controller: d1, value: d2, time, portId })
        emitted++
      }
      // Poly/channel aftertouch, program change and pitch bend are not used.
    }
    return emitted
  }
}

/** Status byte helpers for output. Channel is 0-based. */
export const noteOnBytes = (channel: number, note: number, velocity: number): number[] => [
  0x90 | (channel & 0x0f),
  note & 0x7f,
  velocity & 0x7f,
]
export const noteOffBytes = (channel: number, note: number, velocity = 0): number[] => [
  0x80 | (channel & 0x0f),
  note & 0x7f,
  velocity & 0x7f,
]
export const ccBytes = (channel: number, controller: number, value: number): number[] => [
  0xb0 | (channel & 0x0f),
  controller & 0x7f,
  value & 0x7f,
]
