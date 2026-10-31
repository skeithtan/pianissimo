/**
 * The app's MIDI connection owner: one lazily created `MidiAdapter`, the remembered route, and
 * a small framework-free state store that drives the shell's connection status.
 *
 * Spec "Delivery and device compatibility": request MIDI access through the browser's
 * permission flow, detect unavailable or denied access and provide a clear connection status.
 * Spec "MIDI input, output, and pedal controls": remember the route and its tested channel;
 * on disconnect stop scheduling and mark the attempt interrupted; reconnect, reset the tested
 * output state and require clean physical key and pedal state before restarting; Stop sound
 * confines cleanup to the app's output route.
 *
 * Access is never requested on creation. `connect()` is for an explicit user action (or a
 * Connection view opened while permission is already granted); `connectOnBoot()` asks for access
 * at first load and connects the remembered route, or the only piano present.
 */
import { ccBytes } from '../../core/midi/decode'
import {
  MidiAdapter,
  type MidiAccessStatus,
  type MidiPermissionState,
  type MidiPortInfo,
  type MidiRouteEvent,
} from '../../core/midi/adapter'
import { findRememberedPort, rememberRoute } from '../../core/midi/route'
import { CC_ALL_NOTES_OFF } from '../../core/midi/types'
import type { MidiRouteSettings } from '../../core/model/settings'
import type { ConnectionStatus, NoticeInput } from '../state'

/** Everything the Connection view and the status chip need, as one immutable snapshot. */
export interface MidiSnapshot {
  readonly access: MidiAccessStatus
  /** Explanation for unsupported / denied / error ('' otherwise). */
  readonly message: string
  /** Browser permission read without prompting; null until read. */
  readonly permission: MidiPermissionState | null
  readonly inputs: readonly MidiPortInfo[]
  readonly outputs: readonly MidiPortInfo[]
  /** Selected piano input (kept while it is disconnected so the view can name it). */
  readonly input: SelectedPort | null
  readonly output: SelectedPort | null
}

export interface SelectedPort {
  readonly id: string
  readonly name: string
  readonly connected: boolean
  /** How the port was found when restored from memory ('pick' = chosen by the user). */
  readonly matchedBy: 'id' | 'name' | 'pick'
}

/** Something that owns app sound (the practice session's transport + backend). */
export type SoundOwner = () => void

export interface StopSoundResult {
  /** All Notes Off went to the app's output channel. */
  readonly sent: boolean
  readonly outputName: string | null
  readonly channel: number
}

export interface MidiServiceDeps {
  readonly createAdapter: () => MidiAdapter
  readonly getRoute: () => MidiRouteSettings
  readonly setRoute: (route: MidiRouteSettings) => void
  readonly setStatus: (status: ConnectionStatus) => void
  readonly notify: (notice: NoticeInput) => void
  /** Explanation shown when Web MIDI is missing (features.ts). */
  readonly unsupportedDetail?: string | null
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
}

/** Route events arriving within this window produce one combined notice. */
export const ROUTE_NOTICE_COALESCE_MS = 250

const INITIAL: MidiSnapshot = {
  access: 'idle',
  message: '',
  permission: null,
  inputs: [],
  outputs: [],
  input: null,
  output: null,
}

/** True when the route names an input or output to reconnect to. */
export function hasRememberedRoute(route: MidiRouteSettings): boolean {
  return route.inputId !== null || route.inputName !== null || route.outputId !== null || route.outputName !== null
}

/** The shell's coarse connection status for a snapshot. */
export function connectionStatusFor(s: MidiSnapshot, unsupportedDetail?: string | null): ConnectionStatus {
  switch (s.access) {
    case 'unsupported': {
      const detail = unsupportedDetail ?? s.message
      return detail ? { state: 'unsupported', detail } : { state: 'unsupported' }
    }
    case 'denied':
      return { state: 'denied', detail: s.message }
    case 'requesting':
      return { state: 'connecting' }
    case 'idle':
      return { state: 'disconnected' }
    case 'error':
      return { state: 'disconnected', detail: s.message }
    case 'granted': {
      const input = s.input
      if (input?.connected) {
        const output = s.output?.connected ? { outputName: s.output.name } : {}
        return { state: 'connected', inputName: input.name, ...output }
      }
      return {
        state: 'disconnected',
        detail: input ? `${input.name} is disconnected.` : 'Choose your piano in Connection.',
      }
    }
  }
}

export class MidiService {
  private adapterValue: MidiAdapter | null = null
  private state: MidiSnapshot = INITIAL
  private readonly stateListeners = new Set<(s: MidiSnapshot) => void>()
  private readonly routeListeners = new Set<(ev: MidiRouteEvent) => void>()
  private readonly soundOwners = new Set<SoundOwner>()
  private readonly deps: MidiServiceDeps
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private pendingNotice: { lost: Set<string>; back: Set<string>; output: boolean; timer: unknown } | null = null
  private matched: { input: SelectedPort['matchedBy']; output: SelectedPort['matchedBy'] } = {
    input: 'pick',
    output: 'pick',
  }
  /** Set once the first `connect()` finished: later hot-plug selections are announced. */
  private announce = false
  /** A selected port was reported disconnected and has not come back yet. */
  private lostFlags = { input: false, output: false }

  constructor(deps: MidiServiceDeps) {
    this.deps = deps
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** The adapter, created on first use. Creating it never requests access. */
  get adapter(): MidiAdapter {
    if (!this.adapterValue) {
      const adapter = this.deps.createAdapter()
      this.adapterValue = adapter
      adapter.onStatus(() => this.refresh())
      adapter.onPortsChanged(() => this.handlePortsChanged())
      adapter.onRoute((ev) => this.handleRoute(ev))
      this.refresh()
    }
    return this.adapterValue
  }

  /** The adapter if something already created it, without creating one. */
  peek(): MidiAdapter | null {
    return this.adapterValue
  }

  get snapshot(): MidiSnapshot {
    return this.state
  }

  /** Called with every new snapshot. Returns an unsubscribe function. */
  subscribe(fn: (s: MidiSnapshot) => void): () => void {
    this.stateListeners.add(fn)
    return () => {
      this.stateListeners.delete(fn)
    }
  }

  /**
   * Selected-port disconnect/reconnect events, delivered synchronously (before any notice).
   * Works before the adapter exists. The practice session uses it to stop scheduling and
   * interrupt an attempt on `input-disconnected` / `output-disconnected`, and on
   * `input-reconnected` to reset its physical-state assumptions and wait for
   * `adapter.physical.isClean()` before Ready.
   */
  onRoute(fn: (ev: MidiRouteEvent) => void): () => void {
    this.routeListeners.add(fn)
    return () => {
      this.routeListeners.delete(fn)
    }
  }

  /** Read the permission without prompting (so the view can explain prompt/denied up front). */
  async readPermission(): Promise<MidiPermissionState> {
    const permission = await this.adapter.permission()
    this.publish({ ...this.state, permission })
    return permission
  }

  /**
   * Request access (from a user action) and select the remembered route if its ports are
   * present. Resolves with the access status; never rejects.
   */
  async connect(): Promise<MidiAccessStatus> {
    const adapter = this.adapter
    const status = await adapter.request()
    if (status === 'granted') {
      this.applyRemembered()
      this.announce = true
      this.publish({ ...this.state, permission: 'granted' })
    } else if (status === 'denied') {
      this.publish({ ...this.state, permission: 'denied' })
    }
    return status
  }

  /**
   * Boot (user, 2026-10-31): ask for MIDI access at first load instead of waiting for the
   * Connection setup. Unsupported browsers skip it; a denied permission shows in the chip. With
   * access, the remembered route is reselected; without one, the only input present (and the only
   * output, if any) is the piano: it is chosen and remembered, so a single piano just works. The
   * output still needs its playback and echo tests before one-hand grading (S4). Returns true
   * when access was obtained.
   */
  async connectOnBoot(): Promise<boolean> {
    if (this.adapter.status === 'unsupported') return false
    if ((await this.connect()) !== 'granted') return false
    this.selectOnlyPorts()
    return true
  }

  /** With nothing remembered for a side, a single present port on that side is the piano. */
  private selectOnlyPorts(): void {
    const adapter = this.adapterValue
    if (!adapter || adapter.status !== 'granted') return
    const route = this.deps.getRoute()
    if (!adapter.selectedInput && route.inputId === null && route.inputName === null) {
      const inputs = adapter.inputs().filter((p) => p.state === 'connected')
      if (inputs.length === 1) this.selectInput(inputs[0]!.id)
    }
    if (!adapter.selectedOutput && route.outputId === null && route.outputName === null) {
      const outputs = adapter.outputs().filter((p) => p.state === 'connected')
      if (outputs.length === 1) this.selectOutput(outputs[0]!.id)
    }
  }

  /** Choose the piano input (null = none) and remember it. */
  selectInput(id: string | null): boolean {
    const adapter = this.adapter
    if (!adapter.selectInput(id)) return false
    this.matched = { ...this.matched, input: 'pick' }
    this.lostFlags = { ...this.lostFlags, input: false }
    this.remember()
    return true
  }

  /** Choose the playback output (null = none) and remember it; a new output needs a new test. */
  selectOutput(id: string | null): boolean {
    const adapter = this.adapter
    if (!adapter.selectOutput(id)) return false
    this.matched = { ...this.matched, output: 'pick' }
    this.lostFlags = { ...this.lostFlags, output: false }
    this.remember()
    return true
  }

  /** Set the 0-based receive channel for app playback; a new channel needs a new test. */
  setOutputChannel(channel: number): void {
    if (!Number.isInteger(channel) || channel < 0 || channel > 15)
      throw new RangeError(`Invalid MIDI channel ${channel}`)
    const route = this.deps.getRoute()
    if (route.outputChannel === channel) return
    this.deps.setRoute(rememberRoute(route, this.selectedInfo('input'), this.selectedInfo('output'), channel))
  }

  /**
   * Register the owner of app sound (the practice session's `transport.stopSound`). Stop sound
   * runs every owner, then sends All Notes Off on the app channel. Returns an unregister function.
   */
  registerSoundOwner(owner: SoundOwner): () => void {
    this.soundOwners.add(owner)
    return () => {
      this.soundOwners.delete(owner)
    }
  }

  /**
   * Stuck-note recovery (spec: "Provide Stop sound … confine cleanup to the app's output
   * route"): owners release their notes and pedals, then CC 123 goes to the selected output on
   * the app's channel only. Never other channels, Local Control or patch changes.
   */
  stopSound(): StopSoundResult {
    for (const owner of [...this.soundOwners]) {
      try {
        owner()
      } catch (error) {
        console.error('Stop sound owner failed', error)
      }
    }
    const channel = this.deps.getRoute().outputChannel
    const output = this.adapterValue?.output ?? null
    if (!output) return { sent: false, outputName: null, channel }
    try {
      output.send(ccBytes(channel, CC_ALL_NOTES_OFF, 0), this.now())
      return { sent: true, outputName: output.name ?? output.id, channel }
    } catch {
      return { sent: false, outputName: output.name ?? output.id, channel }
    }
  }

  /** Detach everything (tests). */
  dispose(): void {
    if (this.pendingNotice) this.clearTimer(this.pendingNotice.timer)
    this.pendingNotice = null
    this.adapterValue?.dispose()
    this.adapterValue = null
    this.stateListeners.clear()
    this.routeListeners.clear()
    this.soundOwners.clear()
    this.state = INITIAL
  }

  // -------------------------------------------------------------------------------------------

  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now()
  }

  private selectedInfo(kind: 'input' | 'output'): MidiPortInfo | null {
    const adapter = this.adapterValue
    if (!adapter) return null
    const live = kind === 'input' ? adapter.selectedInput : adapter.selectedOutput
    if (live) return live
    const sel = this.state[kind]
    return sel ? { id: sel.id, name: sel.name, manufacturer: '', type: kind, state: 'disconnected' } : null
  }

  /** Store the current selection in settings (verification cleared when the output changed). */
  private remember(): void {
    const route = this.deps.getRoute()
    this.deps.setRoute(rememberRoute(route, this.selectedInfo('input'), this.selectedInfo('output')))
    this.refresh()
  }

  /** Select remembered ports that are present but not selected yet (by id, then by name). */
  private applyRemembered(): boolean {
    const adapter = this.adapterValue
    if (!adapter || adapter.status !== 'granted') return false
    const route = this.deps.getRoute()
    let changed = false
    if (!adapter.selectedInput && (route.inputId !== null || route.inputName !== null)) {
      const match = findRememberedPort(adapter.inputs(), route.inputId, route.inputName)
      if (match && match.port.state === 'connected' && adapter.selectInput(match.port.id)) {
        this.matched = { ...this.matched, input: match.by }
        changed = true
      }
    }
    if (!adapter.selectedOutput && (route.outputId !== null || route.outputName !== null)) {
      const match = findRememberedPort(adapter.outputs(), route.outputId, route.outputName)
      if (match && match.port.state === 'connected' && adapter.selectOutput(match.port.id)) {
        this.matched = { ...this.matched, output: match.by }
        changed = true
      }
    }
    if (changed) {
      // Keep the stored names; refresh ids (Bluetooth ports may come back with a new id).
      // Matching by name keeps the tested verification and echo result (DECISIONS C3).
      const input = adapter.selectedInput
      const output = adapter.selectedOutput
      this.deps.setRoute({
        ...route,
        ...(input ? { inputId: input.id, inputName: input.name } : {}),
        ...(output ? { outputId: output.id, outputName: output.name } : {}),
      })
    }
    this.refresh()
    return changed
  }

  private handlePortsChanged(): void {
    const before = this.adapterValue?.selectedInput
    const selected = this.applyRemembered()
    const after = this.adapterValue?.selectedInput
    if (selected && this.announce && !before && after) {
      this.deps.notify({ kind: 'success', text: `Piano connected: ${after.name}.` })
    }
  }

  private handleRoute(ev: MidiRouteEvent): void {
    for (const fn of [...this.routeListeners]) {
      try {
        fn(ev)
      } catch (error) {
        console.error('MIDI route listener failed', error)
      }
    }
    const route = this.deps.getRoute()
    switch (ev.kind) {
      case 'input-disconnected':
        this.lostFlags = { ...this.lostFlags, input: true }
        break
      case 'output-disconnected':
        this.lostFlags = { ...this.lostFlags, output: true }
        break
      case 'input-reconnected':
        this.lostFlags = { ...this.lostFlags, input: false }
        if (route.inputId !== ev.port.id) this.deps.setRoute({ ...route, inputId: ev.port.id })
        break
      case 'output-reconnected':
        this.lostFlags = { ...this.lostFlags, output: false }
        if (route.outputId !== ev.port.id) this.deps.setRoute({ ...route, outputId: ev.port.id })
        break
    }
    this.refresh()
    this.queueNotice(ev)
  }

  /** One notice per burst: a USB piano's input and output usually change together. */
  private queueNotice(ev: MidiRouteEvent): void {
    const p = (this.pendingNotice ??= {
      lost: new Set(),
      back: new Set(),
      output: false,
      timer: this.setTimer(() => this.flushNotice(), ROUTE_NOTICE_COALESCE_MS),
    })
    const name = ev.port.name
    if (ev.kind === 'input-disconnected' || ev.kind === 'output-disconnected') {
      p.back.delete(name)
      p.lost.add(name)
      if (ev.kind === 'output-disconnected') p.output = true
    } else {
      p.lost.delete(name)
      p.back.add(name)
    }
  }

  private flushNotice(): void {
    const p = this.pendingNotice
    this.pendingNotice = null
    if (!p) return
    const list = (names: Set<string>) => [...names].join(', ')
    if (p.lost.size > 0) {
      const playback = p.output ? ' App playback stopped.' : ''
      this.deps.notify({
        kind: 'warning',
        text: `Piano disconnected (${list(p.lost)}).${playback} Reconnect it to continue; an attempt in progress is interrupted.`,
      })
    }
    if (p.back.size > 0) {
      this.deps.notify({
        kind: 'success',
        text: `Piano reconnected (${list(p.back)}). Release all keys and pedals before starting again.`,
      })
    }
  }

  private refresh(): void {
    const adapter = this.adapterValue
    if (!adapter) return
    const inputs = adapter.inputs()
    const outputs = adapter.outputs()
    this.publish({
      ...this.state,
      access: adapter.status,
      message: adapter.statusMessage,
      inputs,
      outputs,
      input: this.selection('input', inputs),
      output: this.selection('output', outputs),
    })
  }

  private selection(kind: 'input' | 'output', ports: readonly MidiPortInfo[]): SelectedPort | null {
    const adapter = this.adapterValue!
    const live = kind === 'input' ? adapter.selectedInput : adapter.selectedOutput
    const prev = this.state[kind]
    const matchedBy = this.matched[kind]
    const lost = this.lostFlags[kind]
    if (live) {
      const connected = kind === 'input' ? live.state === 'connected' && !lost : adapter.output !== null
      return { id: live.id, name: live.name, connected, matchedBy }
    }
    // The selected port vanished from the browser's list: keep naming it as disconnected.
    if (prev && lost && !ports.some((p) => p.id === prev.id && p.state === 'connected')) {
      return { ...prev, connected: false }
    }
    return null
  }

  private publish(next: MidiSnapshot): void {
    this.state = next
    this.deps.setStatus(connectionStatusFor(next, this.deps.unsupportedDetail))
    for (const fn of [...this.stateListeners]) fn(next)
  }
}
