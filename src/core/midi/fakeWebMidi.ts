/**
 * In-memory Web MIDI fakes for unit tests: ports, access with statechange, and an output
 * that records sent bytes with timestamps. Not imported by app code.
 */
import type {
  MidiAccessLike,
  MidiConnectionEventLike,
  MidiInputLike,
  MidiMessageEventLike,
  MidiNavigatorLike,
  MidiOutputLike,
  MidiPortDeviceState,
} from './webmidi'

export class FakeInput implements MidiInputLike {
  readonly type = 'input' as const
  state: MidiPortDeviceState = 'connected'
  onmidimessage: ((ev: MidiMessageEventLike) => void) | null = null
  constructor(
    public id: string,
    public name: string | null,
    public manufacturer: string | null = 'Fake',
  ) {}

  /** Deliver raw bytes as one MIDIMessageEvent. */
  emit(bytes: number[], timeStamp: number): void {
    this.onmidimessage?.({ data: Uint8Array.from(bytes), timeStamp })
  }
}

export interface SentMessage {
  readonly data: readonly number[]
  readonly time: number | undefined
}

export class FakeOutput implements MidiOutputLike {
  readonly type = 'output' as const
  state: MidiPortDeviceState = 'connected'
  readonly sent: SentMessage[] = []
  clears = 0
  clear?: () => void
  constructor(
    public id: string,
    public name: string | null,
    withClear = false,
    public manufacturer: string | null = 'Fake',
  ) {
    if (withClear) this.clear = () => void this.clears++
  }

  send(data: number[], timestamp?: number): void {
    if (this.state !== 'connected') throw new Error('InvalidStateError: port disconnected')
    this.sent.push({ data: [...data], time: timestamp })
  }
}

export class FakeAccess implements MidiAccessLike {
  readonly inputs = new Map<string, FakeInput>()
  readonly outputs = new Map<string, FakeOutput>()
  onstatechange: ((ev: MidiConnectionEventLike) => void) | null = null

  addInput(p: FakeInput): FakeInput {
    this.inputs.set(p.id, p)
    this.onstatechange?.({ port: p })
    return p
  }

  addOutput(p: FakeOutput): FakeOutput {
    this.outputs.set(p.id, p)
    this.onstatechange?.({ port: p })
    return p
  }

  setState(p: FakeInput | FakeOutput, state: MidiPortDeviceState): void {
    p.state = state
    this.onstatechange?.({ port: p })
  }
}

export function fakeNavigator(
  access: FakeAccess,
  outcome: 'grant' | 'deny' | 'fail' = 'grant',
): MidiNavigatorLike & { calls: Array<{ sysex?: boolean } | undefined> } {
  const calls: Array<{ sysex?: boolean } | undefined> = []
  return {
    calls,
    requestMIDIAccess(options) {
      calls.push(options)
      if (outcome === 'deny') {
        const e = new Error('Permission denied')
        e.name = 'NotAllowedError'
        return Promise.reject(e)
      }
      if (outcome === 'fail') return Promise.reject(new Error('boom'))
      return Promise.resolve(access)
    },
  }
}
