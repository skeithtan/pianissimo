/**
 * Web MIDI adapter: feature detection, permission request, port lists, one selected input
 * and one selected output, disconnect/reconnect handling.
 *
 * Spec "Delivery and device compatibility" and "MIDI input, output, and pedal controls":
 * request access through the browser's permission flow (sysex disabled), detect unavailable
 * or denied access with a clear status, list inputs and outputs separately, and never
 * trigger Bluetooth pairing from the website (pairing is the OS/browser's job).
 *
 * The input handler only decodes and pushes events synchronously to subscribers (after
 * updating `physical`), in arrival order; it does no rendering, storage or parsing.
 */
import { MidiDecoder } from './decode'
import { PhysicalState, addListener } from './physical'
import type { MidiInputEvent } from './types'
import type {
  MidiAccessLike,
  MidiConnectionEventLike,
  MidiInputLike,
  MidiMessageEventLike,
  MidiNavigatorLike,
  MidiOutputLike,
  MidiPortLike,
  MidiPortType,
  PermissionsLike,
} from './webmidi'

export type MidiAccessStatus = 'unsupported' | 'idle' | 'requesting' | 'denied' | 'granted' | 'error'

/** Browser permission state for MIDI before asking; 'unknown' when it cannot be read (e.g. Safari). */
export type MidiPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown'

export const MIDI_UNSUPPORTED_EXPLANATION =
  'This browser does not provide Web MIDI, so Pianissimo cannot hear or play your piano. ' +
  'On a computer, use desktop Chrome. On iPad, Safari and Home Screen shortcuts lack Web MIDI: ' +
  'open Pianissimo in MIDIWeb Browser. Score viewing and browser-sound playback still work here.'

export const MIDI_DENIED_EXPLANATION =
  'MIDI access was blocked. Allow MIDI devices for this site in the browser’s site settings, ' + 'then try again.'

export const MIDI_BLUETOOTH_HINT =
  'Bluetooth MIDI pianos are paired in the system or browser settings, not by this website. ' +
  'Pair the piano there; it then appears in the lists below.'

export interface MidiPortInfo {
  readonly id: string
  readonly name: string
  readonly manufacturer: string
  readonly type: MidiPortType
  readonly state: 'connected' | 'disconnected'
}

/**
 * Route changes of the selected ports. On `input-reconnected` the adapter has already reset
 * `physical`; consumers must also reset their own physical-state assumptions (held keys,
 * pedals) and require a clean state before restarting (spec: disconnect handling).
 */
export type MidiRouteEvent =
  | { readonly kind: 'input-disconnected'; readonly port: MidiPortInfo }
  | { readonly kind: 'input-reconnected'; readonly port: MidiPortInfo }
  | { readonly kind: 'output-disconnected'; readonly port: MidiPortInfo }
  | { readonly kind: 'output-reconnected'; readonly port: MidiPortInfo }

export interface MidiAdapterEnv {
  readonly navigator?: MidiNavigatorLike | undefined
  /** Monotonic clock in the performance.now() timebase (fallback for missing timestamps). */
  readonly now?: () => number
}

/** True when `navigator.requestMIDIAccess` exists (Chrome, MIDIWeb; not Safari). */
export function isWebMidiSupported(nav: MidiNavigatorLike | undefined = globalNavigator()): boolean {
  return !!nav && typeof nav.requestMIDIAccess === 'function'
}

function globalNavigator(): MidiNavigatorLike | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as unknown as MidiNavigatorLike)
}

function info(p: MidiPortLike): MidiPortInfo {
  return {
    id: p.id,
    name: p.name ?? p.id,
    manufacturer: p.manufacturer ?? '',
    type: p.type,
    state: p.state,
  }
}

interface Selection {
  id: string
  name: string
  lost: boolean
}

export class MidiAdapter {
  /** Physical key/pedal state of the selected input; reset on (re)connection. */
  readonly physical = new PhysicalState()

  private readonly nav: MidiNavigatorLike | undefined
  private readonly now: () => number
  private readonly decoder = new MidiDecoder()
  private access: MidiAccessLike | null = null
  private pending: Promise<MidiAccessStatus> | null = null
  private statusValue: MidiAccessStatus
  private message: string
  private input: MidiInputLike | null = null
  private inSel: Selection | null = null
  private outSel: Selection | null = null
  private readonly subscribers: Array<(ev: MidiInputEvent) => void> = []
  private readonly portListeners: Array<() => void> = []
  private readonly routeListeners: Array<(ev: MidiRouteEvent) => void> = []
  private readonly statusListeners: Array<(s: MidiAccessStatus) => void> = []

  constructor(env: MidiAdapterEnv = {}) {
    this.nav = 'navigator' in env ? env.navigator : globalNavigator()
    this.now = env.now ?? (() => performance.now())
    const supported = isWebMidiSupported(this.nav)
    this.statusValue = supported ? 'idle' : 'unsupported'
    this.message = supported ? '' : MIDI_UNSUPPORTED_EXPLANATION
  }

  get status(): MidiAccessStatus {
    return this.statusValue
  }

  /** Human-readable explanation for the current status ('' when nothing to explain). */
  get statusMessage(): string {
    return this.message
  }

  /**
   * Request MIDI access (sysex disabled) through the browser permission flow. Call from a
   * user action. Resolves with the new status; never rejects.
   */
  request(): Promise<MidiAccessStatus> {
    if (this.statusValue === 'unsupported' || this.access) return Promise.resolve(this.statusValue)
    this.pending ??= this.doRequest().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  /**
   * Read the MIDI permission without prompting (Permissions API, sysex false). Lets the
   * connection view say "allow MIDI when asked" (prompt) or explain a block (denied) up front.
   */
  async permission(): Promise<MidiPermissionState> {
    if (this.statusValue === 'unsupported') return 'unknown'
    const perms: PermissionsLike | undefined = this.nav?.permissions
    if (!perms || typeof perms.query !== 'function') return 'unknown'
    try {
      const { state } = await perms.query({ name: 'midi', sysex: false })
      return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private async doRequest(): Promise<MidiAccessStatus> {
    this.setStatus('requesting', '')
    try {
      const access = await this.nav!.requestMIDIAccess!({ sysex: false })
      this.access = access
      access.onstatechange = this.handleStateChange
      this.setStatus('granted', '')
      this.emitPorts()
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'SecurityError' || name === 'NotAllowedError') {
        this.setStatus('denied', MIDI_DENIED_EXPLANATION)
      } else {
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        this.setStatus('error', `MIDI could not be started (${detail}).`)
      }
    }
    return this.statusValue
  }

  inputs(): MidiPortInfo[] {
    return this.access ? [...this.access.inputs.values()].map(info) : []
  }

  outputs(): MidiPortInfo[] {
    return this.access ? [...this.access.outputs.values()].map(info) : []
  }

  get selectedInput(): MidiPortInfo | null {
    const p = this.inSel && this.access?.inputs.get(this.inSel.id)
    return p ? info(p) : null
  }

  get selectedOutput(): MidiPortInfo | null {
    const p = this.outSel && this.access?.outputs.get(this.outSel.id)
    return p ? info(p) : null
  }

  /** The selected output when connected (for the MIDI output backend), else null. */
  get output(): MidiOutputLike | null {
    if (!this.outSel || this.outSel.lost) return null
    const p = this.access?.outputs.get(this.outSel.id)
    return p && p.state === 'connected' ? p : null
  }

  /** Select the piano input (null = none). Resets physical state. */
  selectInput(id: string | null): boolean {
    this.detachInput()
    this.physical.reset()
    if (id === null) {
      this.inSel = null
      return true
    }
    const port = this.access?.inputs.get(id)
    if (!port) return false
    this.inSel = { id, name: port.name ?? id, lost: port.state !== 'connected' }
    this.attachInput(port)
    return true
  }

  /** Select the automatic-playback output (null = none). */
  selectOutput(id: string | null): boolean {
    if (id === null) {
      this.outSel = null
      return true
    }
    const port = this.access?.outputs.get(id)
    if (!port) return false
    this.outSel = { id, name: port.name ?? id, lost: port.state !== 'connected' }
    return true
  }

  /** Decoded input events, pushed synchronously and in order. Each event is emitted once. */
  subscribe(fn: (ev: MidiInputEvent) => void): () => void {
    return addListener(this.subscribers, fn)
  }

  onPortsChanged(fn: () => void): () => void {
    return addListener(this.portListeners, fn)
  }

  onRoute(fn: (ev: MidiRouteEvent) => void): () => void {
    return addListener(this.routeListeners, fn)
  }

  onStatus(fn: (s: MidiAccessStatus) => void): () => void {
    return addListener(this.statusListeners, fn)
  }

  /** Last `seq` issued, for diagnostics (lost/duplicated event checks). */
  get lastSeq(): number {
    return this.decoder.lastSeq
  }

  dispose(): void {
    this.detachInput()
    if (this.access) this.access.onstatechange = null
    this.access = null
    this.subscribers.length = 0
    this.portListeners.length = 0
    this.routeListeners.length = 0
    this.statusListeners.length = 0
  }

  private readonly handleMessage = (ev: MidiMessageEventLike): void => {
    const data = ev.data
    if (!data || data.length === 0) return
    let t = ev.timeStamp
    if (!(t > 0)) t = this.now()
    else if (t > this.now() + 1000) t = this.now() // foreign timebase (e.g. epoch ms)
    this.decoder.decode(data, t, this.input ? this.input.id : '', this.dispatch)
  }

  private readonly dispatch = (ev: MidiInputEvent): void => {
    this.physical.apply(ev)
    const subs = this.subscribers
    for (let i = 0; i < subs.length; i++) subs[i]!(ev)
  }

  private attachInput(port: MidiInputLike): void {
    this.input = port
    port.onmidimessage = this.handleMessage
  }

  private detachInput(): void {
    if (this.input && this.input.onmidimessage === this.handleMessage) this.input.onmidimessage = null
    this.input = null
  }

  private readonly handleStateChange = (ev: MidiConnectionEventLike): void => {
    const port = ev.port
    if (port) {
      if (port.type === 'input') this.updateInput(port)
      else this.updateOutput(port)
    }
    this.emitPorts()
  }

  private updateInput(port: MidiPortLike): void {
    const sel = this.inSel
    if (!sel) return
    if (port.state === 'disconnected' && port.id === sel.id && !sel.lost) {
      sel.lost = true
      this.detachInput()
      this.physical.reset()
      this.emitRoute({ kind: 'input-disconnected', port: info(port) })
    } else if (port.state === 'connected' && sel.lost && (port.id === sel.id || port.name === sel.name)) {
      const live = this.access?.inputs.get(port.id)
      if (!live) return
      sel.id = port.id
      sel.lost = false
      this.physical.reset()
      this.attachInput(live)
      this.emitRoute({ kind: 'input-reconnected', port: info(live) })
    }
  }

  private updateOutput(port: MidiPortLike): void {
    const sel = this.outSel
    if (!sel) return
    if (port.state === 'disconnected' && port.id === sel.id && !sel.lost) {
      sel.lost = true
      this.emitRoute({ kind: 'output-disconnected', port: info(port) })
    } else if (port.state === 'connected' && sel.lost && (port.id === sel.id || port.name === sel.name)) {
      if (!this.access?.outputs.get(port.id)) return
      sel.id = port.id
      sel.lost = false
      this.emitRoute({ kind: 'output-reconnected', port: info(port) })
    }
  }

  private setStatus(s: MidiAccessStatus, message: string): void {
    this.statusValue = s
    this.message = message
    for (const fn of this.statusListeners) fn(s)
  }

  private emitPorts(): void {
    for (const fn of this.portListeners) fn()
  }

  private emitRoute(ev: MidiRouteEvent): void {
    for (const fn of this.routeListeners) fn(ev)
  }
}
