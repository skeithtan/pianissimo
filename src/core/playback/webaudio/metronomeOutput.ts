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

export function canSelectMetronomeOutput(): boolean {
  return (
    typeof AudioContext === 'function' &&
    typeof (AudioContext.prototype as Partial<SelectableContext>).setSinkId === 'function' &&
    typeof navigator.mediaDevices?.enumerateDevices === 'function'
  )
}

export async function listMetronomeOutputs(): Promise<readonly MediaDeviceInfo[]> {
  if (!canSelectMetronomeOutput()) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default')
}

/** Call from a user gesture to unlock audio. Only an explicit device needs its own context. */
export function metronomeAudioOutput(id: string | null): MetronomeOutput | Promise<MetronomeOutput> {
  const system = sharedAudioContext()
  const fallback = { context: system, deviceSelected: false }
  if (selected && (selected.id !== id || selected.context.state === 'closed')) {
    void selected.context.close().catch(() => undefined)
    selected = null
  }
  if (!id || !canSelectMetronomeOutput()) return fallback

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
    if (output.context.state === 'suspended') void output.context.resume().catch(() => undefined)
    return output.ready.then((ready) => {
      if (output !== selected) return fallback
      if (ready) return { context: output.context, deviceSelected: true }
      selected = null
      void output.context.close().catch(() => undefined)
      return fallback
    })
  } catch {
    // A restored device ID may be unavailable or no longer permitted on this browser.
  }
  return fallback
}
