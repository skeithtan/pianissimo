/**
 * Step 4, echo test (spec "MIDI input, output, and pedal controls": keep keyboard input and
 * automatic output separate; if returned playback cannot be distinguished from human input,
 * disable graded accompaniment for that routing until it is corrected; Preview can run without
 * grading but must not forward received echoes). Uses `runEchoTest` (DECISIONS MI1).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { MidiService, MidiSnapshot } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import { echoSetting, runEchoTest, type EchoTestResult } from '../../core/midi/echo'
import { Button } from '../../ui/controls'
import { Callout, Help, Step } from './parts'
import type { StepStatus } from './status'
import styles from './connection.module.css'

export interface EchoClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
}

const realClock: EchoClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
}

export function EchoStep({
  index,
  status,
  snap,
  service,
  clock = realClock,
}: {
  index: number
  status: StepStatus
  snap: MidiSnapshot
  service: MidiService
  clock?: EchoClock
}) {
  const route = settings.value.route
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<EchoTestResult | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  const ready = snap.input?.connected === true && snap.output?.connected === true
  const outputKey = `${snap.output?.id ?? ''}:${route.outputChannel}`
  useEffect(() => setResult(null), [outputKey])

  const run = async () => {
    const adapter = service.adapter
    const output = adapter.output
    if (!output || running) return
    setRunning(true)
    setResult(null)
    const outcome = await runEchoTest(
      {
        send: (data, time) => output.send(data, time),
        subscribe: (fn) => adapter.subscribe(fn),
        now: () => clock.now(),
        setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      },
      { channel: route.outputChannel },
    ).catch(() => null)
    if (outcome) {
      const echo = echoSetting(outcome.verdict)
      if (echo) updateSettings({ route: { echo } })
    }
    if (!mounted.current) return
    setRunning(false)
    setResult(outcome)
  }

  return (
    <Step
      id="echo"
      index={index}
      title="Echo test"
      status={status}
      lead="Checks that notes the app plays do not come back as if you had played them."
    >
      {!ready ? (
        <Help>Choose a connected input and output first.</Help>
      ) : (
        <>
          <Help>Keep your hands off the keys and pedals. The piano plays three short notes.</Help>
          <div class={styles.actions}>
            <Button
              variant={route.echo === 'untested' ? 'primary' : 'secondary'}
              onClick={() => void run()}
              disabled={running}
              aria-busy={running}
            >
              {running ? 'Listening…' : route.echo === 'untested' ? 'Run echo test' : 'Run again'}
            </Button>
          </div>
          {running ? <div class={styles.progress} role="progressbar" aria-label="Echo test running" /> : null}
        </>
      )}
      {!running ? <Verdict result={result} stored={route.echo} ready={ready} /> : null}
    </Step>
  )
}

function Verdict({
  result,
  stored,
  ready,
}: {
  result: EchoTestResult | null
  stored: 'untested' | 'none' | 'echo-detected'
  ready: boolean
}) {
  if (result?.verdict === 'inconclusive') {
    return (
      <Callout tone="warning" title="Inconclusive — please run it again" live>
        <p>
          One test note came back at a different strength, which could have been a key you touched. The previous result
          is kept. Keep your hands away from the keys and run the test again.
        </p>
      </Callout>
    )
  }
  const interfered = result?.otherInput ? (
    <p>Other keys were played during the test. If you touched the piano, run it again with your hands off the keys.</p>
  ) : null
  const live = result !== null
  if (stored === 'echo-detected' && ready) {
    return (
      <Callout tone="danger" title="Echo detected" live={live}>
        <p>
          Notes the app plays come back from the piano
          {result?.latencyMs != null ? ` (after ${Math.round(result.latencyMs)} ms)` : ''}. They would look like your
          own playing, so graded one-hand practice is off for this route until it is fixed. Preview still works, and the
          app never sends returned notes back to the piano.
        </p>
        <p>
          To fix it, turn off MIDI Thru or echo on the piano or interface, or choose another output channel, then test
          again.
        </p>
        {interfered}
      </Callout>
    )
  }
  if (stored === 'none' && ready) {
    return (
      <Callout tone="success" title="No echo" live={live}>
        <p>
          The app’s notes do not come back on the input, so one-hand practice can grade you while the piano accompanies.
        </p>
        {interfered}
      </Callout>
    )
  }
  return null
}
