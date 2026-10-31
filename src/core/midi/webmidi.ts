/**
 * Minimal structural view of the Web MIDI API (W3C Web MIDI, sysex disabled).
 *
 * The DOM lib's `MIDIAccess`, `MIDIInput` and `MIDIOutput` satisfy these shapes; tests and
 * injected polyfills (e.g. MIDIWeb Browser on iPad) only need to provide this much. Only the
 * members Pianissimo uses are listed. `clear()` is optional because several engines omit it.
 */

export type MidiPortType = 'input' | 'output'
export type MidiPortDeviceState = 'connected' | 'disconnected'

export interface MidiPortLike {
  readonly id: string
  readonly name: string | null
  readonly manufacturer: string | null
  readonly type: MidiPortType
  readonly state: MidiPortDeviceState
}

export interface MidiMessageEventLike {
  readonly data: Uint8Array | null
  /** DOMHighResTimeStamp in the performance.now() timebase. */
  readonly timeStamp: number
}

export interface MidiInputLike extends MidiPortLike {
  onmidimessage: ((ev: MidiMessageEventLike) => void) | null
}

export interface MidiOutputLike extends MidiPortLike {
  send(data: number[], timestamp?: number): void
  /** Drops messages queued with future timestamps. Feature-detect before use. */
  clear?: () => void
}

export interface MidiConnectionEventLike {
  readonly port: MidiPortLike | null
}

export interface MidiAccessLike {
  readonly inputs: ReadonlyMap<string, MidiInputLike>
  readonly outputs: ReadonlyMap<string, MidiOutputLike>
  onstatechange: ((ev: MidiConnectionEventLike) => void) | null
}

export interface MidiNavigatorLike {
  requestMIDIAccess?: (options?: { sysex?: boolean; software?: boolean }) => Promise<MidiAccessLike>
  readonly permissions?: PermissionsLike
}

/** The Permissions API subset used to read the MIDI permission state without prompting. */
export interface PermissionsLike {
  query(descriptor: { name: string; sysex?: boolean }): Promise<{ readonly state: string }>
}

/** True when the output supports `clear()` (spec: "Verify timestamp and clear behavior"). */
export function canClear(output: MidiOutputLike): output is MidiOutputLike & { clear: () => void } {
  return typeof output.clear === 'function'
}
