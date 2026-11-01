/**
 * Route memory (spec: "Remember the route and its tested channel/pedal behavior").
 * Port ids are stable in Chrome for USB devices but may change for Bluetooth devices and
 * across browsers, so a remembered port is found by id first, then by name.
 */
import type { MidiRouteSettings } from '../model/settings'
import type { MidiAdapter, MidiPortInfo } from './adapter'

export interface PortMatch {
  readonly port: MidiPortInfo
  readonly by: 'id' | 'name'
}

/** Find a remembered port by id, then by name (connected ports preferred). */
export function findRememberedPort(
  ports: readonly MidiPortInfo[],
  id: string | null,
  name: string | null,
): PortMatch | null {
  if (id !== null) {
    const byId = ports.find((p) => p.id === id)
    if (byId && (byId.state === 'connected' || name === null)) return { port: byId, by: 'id' }
  }
  if (name !== null) {
    const named = ports.filter((p) => p.name === name)
    const best = named.find((p) => p.state === 'connected') ?? named[0]
    if (best) return { port: best, by: best.id === id ? 'id' : 'name' }
  }
  if (id !== null) {
    const byId = ports.find((p) => p.id === id)
    if (byId) return { port: byId, by: 'id' }
  }
  return null
}

/**
 * Record a selected route. Choosing a different output or channel clears the output
 * verification and echo result; choosing a different input clears the echo result too. The
 * echo result belongs to the whole tested route (input + output + channel), while the test note
 * only proves the output and channel.
 */
export function rememberRoute(
  route: MidiRouteSettings,
  input: MidiPortInfo | null,
  output: MidiPortInfo | null,
  outputChannel: number = route.outputChannel,
): MidiRouteSettings {
  const sameOutput =
    output !== null &&
    (output.id === route.outputId || output.name === route.outputName) &&
    outputChannel === route.outputChannel
  const sameInput =
    input === null
      ? route.inputId === null && route.inputName === null
      : input.id === route.inputId || input.name === route.inputName
  return {
    ...route,
    inputId: input?.id ?? null,
    inputName: input?.name ?? null,
    outputId: output?.id ?? null,
    outputName: output?.name ?? null,
    outputChannel,
    outputVerified: sameOutput ? route.outputVerified : false,
    echo: sameOutput && sameInput ? route.echo : 'untested',
  }
}

/**
 * Graded accompaniment needs a verified output whose echo test found no returning notes
 * (spec: if returned playback cannot be distinguished from human input, disable graded
 * accompaniment for that routing). Preview may still run without grading.
 */
export function gradedAccompanimentAllowed(route: MidiRouteSettings): boolean {
  return route.outputId !== null && route.outputVerified && route.echo === 'none'
}

export interface RestoredRoute {
  readonly input: PortMatch | null
  readonly output: PortMatch | null
}

/**
 * Select the remembered input and output on a granted adapter (by id, then by name). A port
 * found only by name may be a different device with the same name, so the caller should keep
 * `outputVerified`/`echo` only when the output matched by id or the user re-confirms.
 */
export function applyRememberedRoute(adapter: MidiAdapter, route: MidiRouteSettings): RestoredRoute {
  const input = findRememberedPort(adapter.inputs(), route.inputId, route.inputName)
  const output = findRememberedPort(adapter.outputs(), route.outputId, route.outputName)
  if (input) adapter.selectInput(input.port.id)
  if (output) adapter.selectOutput(output.port.id)
  return { input, output }
}
