/**
 * The test notes (DECISIONS MI1, C11): the echo probe on the selected output, heard by the learner
 * and watched for on the input. Shared by the piano setup and the first one-hand Start (U149).
 */
import type { MidiService } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import { echoSetting, runEchoTest, type EchoTestResult } from '../../core/midi/echo'

export interface EchoClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
}

const realClock: EchoClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
}

/** The route (input, output, channel) an answer and an echo result belong to. */
export function testedRoute(service: MidiService): string {
  const { input, output } = service.snapshot
  return `${input?.id ?? ''}:${output?.id ?? ''}:${settings.peek().route.outputChannel}`
}

/**
 * Play the test notes and store the echo result with the route (only with the input connected; an
 * inconclusive one keeps the previous value). Null when there is no output, or the route changed
 * meanwhile. Rejects when the output refused the notes.
 */
export async function playTestNotes(
  service: MidiService,
  clock: EchoClock = realClock,
): Promise<EchoTestResult | null> {
  const adapter = service.adapter
  const output = adapter.output
  if (!output) return null
  const startedOn = testedRoute(service)
  const checkEcho = service.snapshot.input?.connected === true
  const result = await runEchoTest(
    {
      send: (data, time) => output.send(data, time),
      subscribe: (fn) => adapter.subscribe(fn),
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    },
    { channel: settings.peek().route.outputChannel },
  )
  if (testedRoute(service) !== startedOn) return null
  const setting = checkEcho ? echoSetting(result.verdict) : null
  if (setting) updateSettings({ route: { echo: setting } })
  return result
}
