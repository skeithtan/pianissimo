/**
 * Step 2, playback to the piano (spec "MIDI input, output, and pedal controls"): list outputs
 * separately, choose one and the piano's receive channel, then Play test notes followed by
 * "Did the piano sound?" — a visible output port is not proof the instrument can sound it.
 * The test notes are the echo probe (`runEchoTest`, DECISIONS MI1 / C11): the same tap checks
 * that the app's notes do not come back on the input as if the learner had played them. If they
 * do, graded one-hand practice is off for the route until it is fixed; Preview still works and
 * never forwards returned notes. Physical-piano playback is required for one-hand practice and
 * Preview; browser sound is an explicit alternative that never silently replaces the piano.
 *
 * Below the test: accompaniment level (scales only app-generated velocity), score pedals in
 * one-hand practice (sent only when verified to affect the automatic part alone; default off)
 * and Stop sound (stuck-note recovery on the app's output route only).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { MidiService, MidiSnapshot, StopSoundResult } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import { openSettings } from '../../app/navigation'
import { echoSetting, runEchoTest, type EchoTestResult } from '../../core/midi/echo'
import type { MidiRouteSettings } from '../../core/model/settings'
import { Button, Slider, Toggle } from '../../ui/controls'
import { Callout, Help, PortList, Step } from './parts'
import { channelLabel, type StepStatus } from './status'
import styles from './connection.module.css'

export interface EchoClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
}

const realClock: EchoClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
}

type TestState = 'idle' | 'asking' | 'heard' | 'silent' | 'failed'

const percent = (v: number): string => `${Math.round(v * 100)}%`

export function PlaybackStep({
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
  const { route, sound } = settings.value
  const [test, setTest] = useState<TestState>('idle')
  const [listening, setListening] = useState(false)
  const [echo, setEcho] = useState<EchoTestResult | null>(null)
  const [stopped, setStopped] = useState<StopSoundResult | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  const granted = snap.access === 'granted'
  const connected = snap.output?.connected === true
  const inputConnected = snap.input?.connected === true

  // The answer and the echo result belong to the whole route (input, output, channel): a
  // different route forgets them, and a probe that finishes after a change is not stored.
  const routeKey = `${snap.input?.id ?? ''}:${snap.output?.id ?? ''}:${route.outputChannel}`
  const currentRoute = useRef(routeKey)
  currentRoute.current = routeKey
  useEffect(() => {
    setTest('idle')
    setEcho(null)
  }, [routeKey])

  const play = () => {
    const adapter = service.adapter
    const output = adapter.output
    if (!output || listening) return
    const startedOn = routeKey
    const checkEcho = inputConnected
    setEcho(null)
    setListening(true)
    setTest('asking')
    runEchoTest(
      {
        send: (data, time) => output.send(data, time),
        subscribe: (fn) => adapter.subscribe(fn),
        now: () => clock.now(),
        setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      },
      { channel: route.outputChannel },
    ).then(
      (result) => {
        if (currentRoute.current !== startedOn) return
        if (checkEcho) {
          const setting = echoSetting(result.verdict)
          if (setting) updateSettings({ route: { echo: setting } })
        }
        if (!mounted.current) return
        setListening(false)
        setEcho(result)
      },
      () => {
        if (!mounted.current) return
        setListening(false)
        setTest('failed')
      },
    )
  }
  const answer = (heard: boolean) => {
    updateSettings({ route: { outputVerified: heard } })
    setTest(heard ? 'heard' : 'silent')
  }
  const stop = () => setStopped(service.stopSound())

  return (
    <Step
      id="playback"
      index={index}
      title="Playback to the piano"
      status={status}
      lead="The piano plays the hand you are not playing, and both hands in Preview."
    >
      {!granted ? (
        <Help>Allow MIDI access first.</Help>
      ) : (
        <PortList
          label="MIDI outputs"
          name="midi-output"
          ports={snap.outputs}
          selected={snap.output}
          rememberedName={route.outputName}
          onSelect={(id) => service.selectOutput(id)}
          none="No output (both-hands practice only)"
        />
      )}
      {granted && snap.outputs.length === 0 ? (
        <Help>No MIDI output found. For 5-pin sockets, connect the interface’s MIDI Out to the piano’s MIDI In.</Help>
      ) : null}

      {snap.output ? (
        <>
          <div class={styles.testRow}>
            <label class={styles.select}>
              <span class={styles.inlineLabel}>Receive channel</span>
              <select
                value={String(route.outputChannel)}
                onChange={(e) => service.setOutputChannel(Number((e.currentTarget as HTMLSelectElement).value))}
              >
                {Array.from({ length: 16 }, (_, ch) => (
                  <option key={ch} value={String(ch)}>
                    {ch + 1}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              icon="sound"
              onClick={play}
              disabled={!connected || listening}
              aria-busy={listening}
            >
              {listening ? 'Playing…' : 'Play test notes'}
            </Button>
          </div>
          <Help>
            Keep your hands off the keys: the piano plays three short notes while the app listens for them coming back.
          </Help>
        </>
      ) : null}

      <TestFeedback state={test} route={route} connected={connected} onAnswer={answer} />
      <EchoFeedback result={echo} route={route} connected={connected} inputConnected={inputConnected} />

      <Help>
        One-hand practice and Preview need the piano itself to play. If it cannot, they stay off. Browser sound (
        <button type="button" class={styles.linkButton} onClick={openSettings}>
          Settings → Sound
        </button>
        ) is a separate choice and never replaces the piano without you choosing it.
        {sound.destination === 'browser'
          ? ' It is selected now, so Preview and accompaniment play through this device instead.'
          : ''}
      </Help>

      <div class={styles.options}>
        <Slider
          label="Accompaniment level"
          min={0}
          max={1}
          step={0.05}
          value={route.accompanimentLevel}
          format={percent}
          onChange={(accompanimentLevel) => updateSettings({ route: { accompanimentLevel } })}
        />
        <Help>Scales how hard the app plays its notes. Your own keys are never changed.</Help>

        <Toggle
          label="Send score pedals in one-hand practice"
          description="Off by default. Turn on only if you checked that the app’s pedal presses affect just the part the piano plays."
          checked={route.automaticPedalsInHandPractice}
          onChange={(automaticPedalsInHandPractice) => updateSettings({ route: { automaticPedalsInHandPractice } })}
        />
        <Help>
          While you play one hand, your own feet control the shared pedals, so two pedal sources never fight over the
          same sound. Preview always plays the score’s pedals.
        </Help>
      </div>

      <div class={styles.stopRow}>
        <Button variant="danger" icon="stop" onClick={stop} disabled={!connected}>
          Stop sound
        </Button>
        <Help>
          Silences notes the app left sounding, on {channelLabel(route.outputChannel)} of the app’s output only.
        </Help>
      </div>
      {stopped ? (
        <Callout tone={stopped.sent ? 'success' : 'warning'} live>
          <p>
            {stopped.sent
              ? `Sent “all notes off” to ${stopped.outputName} on ${channelLabel(stopped.channel)}.`
              : 'Nothing could be sent: the output is not connected.'}
          </p>
        </Callout>
      ) : null}
    </Step>
  )
}

/** The audible half of the test: the question, then what the answer means. */
function TestFeedback({
  state,
  route,
  connected,
  onAnswer,
}: {
  state: TestState
  route: MidiRouteSettings
  connected: boolean
  onAnswer: (heard: boolean) => void
}) {
  if (state === 'failed') {
    return (
      <Callout tone="warning" title="The test notes could not be sent" live>
        <p>The output may have just disconnected. Check the cable or Bluetooth link and try again.</p>
      </Callout>
    )
  }
  if (state === 'asking') {
    return (
      <div class={styles.question} role="group" aria-labelledby="connection-heard-question">
        <p id="connection-heard-question" class={styles.questionText}>
          Did the piano itself play three short notes?
        </p>
        <div class={styles.actions}>
          <Button variant="primary" icon="check" onClick={() => onAnswer(true)}>
            Yes, I heard them
          </Button>
          <Button onClick={() => onAnswer(false)}>No sound</Button>
        </div>
      </div>
    )
  }
  if (state === 'silent') {
    return (
      <Callout tone="warning" title="The piano did not sound" live>
        <ul class={styles.list}>
          <li>Try another receive channel — many pianos listen on channel 1. Some use 2 or 3 for a second voice.</li>
          <li>Check the cable direction: the interface’s MIDI Out must go to the piano’s MIDI In.</li>
          <li>Turn the piano’s volume up and check that it accepts MIDI on this channel.</li>
          <li>A port in this list is not proof the piano can play what the app sends. Only the sound confirms it.</li>
        </ul>
      </Callout>
    )
  }
  if (route.outputVerified && connected) {
    return (
      <Callout
        tone="success"
        title={`The piano sounds on ${channelLabel(route.outputChannel)}`}
        live={state === 'heard'}
      >
        <p>
          {route.echo === 'none'
            ? 'Accompaniment and Preview play on the piano, and its notes do not come back as if you had played them, so one-hand practice can grade you. '
            : 'Accompaniment and Preview play on the piano. '}
          Choosing another output or channel needs a new test.
        </p>
      </Callout>
    )
  }
  return null
}

/** The echo half: only what needs attention; a clean route is folded into the success text. */
function EchoFeedback({
  result,
  route,
  connected,
  inputConnected,
}: {
  result: EchoTestResult | null
  route: MidiRouteSettings
  connected: boolean
  inputConnected: boolean
}) {
  if (!connected) return null
  if (result?.verdict === 'inconclusive') {
    return (
      <Callout tone="warning" title="Echo check inconclusive — please play the test notes again" live>
        <p>
          One test note came back at a different strength, which could have been a key you touched. The previous result
          is kept. Keep your hands away from the keys and play them again.
        </p>
      </Callout>
    )
  }
  if (route.echo === 'echo-detected') {
    return (
      <Callout tone="danger" title="Echo detected" live={result !== null}>
        <p>
          Notes the app plays come back from the piano
          {result?.latencyMs != null ? ` (after ${Math.round(result.latencyMs)} ms)` : ''}. They would look like your
          own playing, so graded one-hand practice is off for this route until it is fixed. Preview still works, and the
          app never sends returned notes back to the piano.
        </p>
        <p>
          To fix it, turn off MIDI Thru or echo on the piano or interface, or choose another output channel, then play
          the test notes again.
        </p>
        {result?.otherInput ? (
          <p>Other keys were played during the test. If you touched the piano, play them again with your hands off.</p>
        ) : null}
      </Callout>
    )
  }
  if (route.echo === 'untested' && route.outputVerified) {
    return (
      <Callout tone="info" title="Echo not checked yet" live={result !== null}>
        <p>
          Graded one-hand practice needs to know that the app’s notes do not come back from the piano.{' '}
          {inputConnected
            ? 'Play the test notes again with your hands off the keys.'
            : 'Connect the piano input, then play the test notes again.'}
        </p>
      </Callout>
    )
  }
  return null
}
