import { sharedAudioContext } from './context'

interface SelectableContext extends AudioContext {
  setSinkId(deviceId: string): Promise<void>
}

interface MetronomeOutput {
  readonly context: AudioContext
  readonly deviceSelected: boolean
}

let selected: { readonly id: string; readonly context: SelectableContext; readonly ready: Promise<boolean> } | null =
  null
/** A device that could not be selected: system audio until the configured device changes. */
let failed: string | null = null

export function canSelectMetronomeOutput(): boolean {
  return (
    typeof AudioContext === 'function' &&
    typeof (AudioContext.prototype as Partial<SelectableContext>).setSinkId === 'function' &&
    typeof navigator.mediaDevices?.enumerateDevices === 'function'
  )
}

export interface MetronomeOutputList {
  /** Outputs that can be selected (they have an ID), without the browser's "default" entry. */
  readonly outputs: readonly MediaDeviceInfo[]
  /**
   * The browser lists outputs without IDs or names until the site may see media devices (Chrome
   * before any media permission): `requestMetronomeOutputAccess` can reveal them.
   */
  readonly hidden: boolean
}

export async function listMetronomeOutputs(): Promise<MetronomeOutputList> {
  if (!canSelectMetronomeOutput()) return { outputs: [], hidden: false }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audiooutput')
  return {
    outputs: devices.filter((device) => device.deviceId && device.deviceId !== 'default'),
    hidden: devices.some((device) => !device.deviceId || !device.label),
  }
}

type PickerMediaDevices = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> }

/** The browser has its own audio output picker (`selectAudioOutput`), which needs no microphone. */
export function hasAudioOutputPicker(): boolean {
  return typeof (navigator.mediaDevices as PickerMediaDevices | undefined)?.selectAudioOutput === 'function'
}

/**
 * Ask to see the audio outputs. Call only from a tap. Where the browser has its own output picker
 * this opens it and resolves with the chosen output; otherwise it asks for the microphone once,
 * stops it at once (only the permission is needed), and resolves with null. Rejects when refused.
 */
export async function requestMetronomeOutputAccess(): Promise<MediaDeviceInfo | null> {
  const media: PickerMediaDevices = navigator.mediaDevices
  if (typeof media.selectAudioOutput === 'function') return media.selectAudioOutput()
  const stream = await media.getUserMedia({ audio: true })
  for (const track of stream.getTracks()) track.stop()
  return null
}

/**
 * Call from a user gesture to unlock audio. Only an explicit device needs its own context.
 * Overlapping calls for one device share its request. A device that fails is not tried again
 * (no new context per Start) until a call names another one.
 */
export function metronomeAudioOutput(id: string | null): MetronomeOutput | Promise<MetronomeOutput> {
  const system = sharedAudioContext()
  const fallback = { context: system, deviceSelected: false }
  if (selected && (selected.id !== id || selected.context.state === 'closed')) {
    void selected.context.close().catch(() => undefined)
    selected = null
  }
  if (failed !== id) failed = null
  if (!id || id === failed || !canSelectMetronomeOutput()) return fallback

  try {
    if (!selected) {
      const context = new AudioContext({ latencyHint: 'interactive' }) as SelectableContext
      const ready = Promise.resolve()
        .then(() => context.setSinkId(id))
        .then(
          () => true,
          () => false,
        )
      selected = { id, context, ready }
    }
    const output = selected
    if (output.context.state !== 'running' && output.context.state !== 'closed') {
      void output.context.resume().catch(() => undefined)
    }
    return output.ready.then((ready) => {
      // Overtaken by another device (or closed): that request decides; this caller gets system audio.
      if (output !== selected) return fallback
      if (ready) return { context: output.context, deviceSelected: true }
      selected = null
      failed = output.id
      void output.context.close().catch(() => undefined)
      return fallback
    })
  } catch {
    // A restored device ID may be unavailable or no longer permitted on this browser.
    failed = id
  }
  return fallback
}
