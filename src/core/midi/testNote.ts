/**
 * "Play test note" (spec "MIDI input, output, and pedal controls": an explicit action to
 * confirm audible output — a visible output port is not proof the instrument can sound it).
 * Sends one note on the selected channel with performance.now()-timebase timestamps; the user
 * then confirms whether the piano itself sounded (`MidiRouteSettings.outputVerified`).
 */
import { noteOffBytes, noteOnBytes } from './decode'
import type { MidiOutputLike } from './webmidi'

export interface TestNoteOptions {
  /** 0-based channel under test. */
  readonly channel: number
  readonly note?: number
  readonly velocity?: number
  readonly durationMs?: number
}

/** Send the test note; false when the port rejected a message (e.g. it just disconnected). */
export function playTestNote(output: MidiOutputLike, now: number, opts: TestNoteOptions): boolean {
  const note = opts.note ?? 60
  const velocity = Math.max(1, Math.min(127, opts.velocity ?? 80))
  try {
    output.send(noteOnBytes(opts.channel, note, velocity), now)
    output.send(noteOffBytes(opts.channel, note, 64), now + (opts.durationMs ?? 700))
    return true
  } catch {
    return false
  }
}
