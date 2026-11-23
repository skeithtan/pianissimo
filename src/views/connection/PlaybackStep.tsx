import { msg } from '../../i18n/messages'
/**
 * Step 2, playback to the piano (spec "MIDI input, output, and pedal controls"): list outputs
 * separately, choose one and the piano's receive channel, then Play test notes followed by
 * "Did the piano sound?" — a visible output port is not proof the instrument can sound it.
 * The test notes are the echo probe (`runEchoTest`, DECISIONS MI1 / C11): the same tap checks
 * that the app's notes do not come back on the input as if the learner had played them. If they
 * do, graded one-hand practice is off for the route until it is fixed; Listen still works and
 * never forwards returned notes. Physical-piano playback is required for one-hand practice and
 * Listen; browser sound is an explicit alternative that never silently replaces the piano.
 *
 * Below the test: score pedals in one-hand practice (sent only when verified to affect the automatic part alone; default off)
 * and Stop sound (stuck-note recovery on the app's output route only).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { MidiService, MidiSnapshot, StopSoundResult } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import type { EchoTestResult } from '../../core/midi/echo'
import type { MidiRouteSettings } from '../../core/model/settings'
import { Button, Toggle } from '../../ui/controls'
import { Callout, Help, PortList, Step } from './parts'
import { channelLabel, type StepStatus } from './status'
import { playTestNotes, testedRoute, type EchoClock } from './testNotes'
import styles from './connection.module.css'

type TestState = 'idle' | 'asking' | 'heard' | 'silent' | 'failed'

export function PlaybackStep({
  index,
  status,
  snap,
  service,
  clock,
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
  const routeKey = testedRoute(service)
  useEffect(() => {
    setTest('idle')
    setEcho(null)
  }, [routeKey])

  const play = () => {
    if (!service.adapter.output || listening) return
    setEcho(null)
    setListening(true)
    setTest('asking')
    playTestNotes(service, clock).then(
      (result) => {
        if (!mounted.current) return
        setListening(false)
        if (result) setEcho(result)
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
      title={msg('Playback to the piano')}
      status={status}
      lead={msg('The piano plays the hand you are not playing, and the score in Listen.')}
    >
      {!granted ? (
        <Help>{msg('Allow MIDI access first.')}</Help>
      ) : (
        <PortList
          label={msg('MIDI outputs')}
          name="midi-output"
          ports={snap.outputs}
          selected={snap.output}
          rememberedName={route.outputName}
          onSelect={(id) => service.selectOutput(id)}
          none={msg('No output (both-hands practice only)')}
        />
      )}
      {granted && snap.outputs.length === 0 ? (
        <Help>
          {msg('No MIDI output found. For 5-pin sockets, connect the interface’s MIDI Out to the piano’s MIDI In.')}
        </Help>
      ) : null}

      {snap.output ? (
        <>
          <div class={styles.testRow}>
            <label class={styles.select}>
              <span class={styles.inlineLabel}>{msg('Receive channel')}</span>
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
              {listening ? msg('Playing…') : msg('Play test notes')}
            </Button>
          </div>
          <Help>
            {msg(
              'Keep your hands off the keys: the piano plays three short notes while the app listens for them coming back.',
            )}
          </Help>
        </>
      ) : null}

      <TestFeedback state={test} route={route} connected={connected} onAnswer={answer} />
      <EchoFeedback result={echo} route={route} connected={connected} inputConnected={inputConnected} />

      <Help>
        {msg(
          'One-hand practice and Listen need the piano itself to play. If it cannot, they stay off. Browser sound, under Sound below, is a separate choice and never replaces the piano without you choosing it.',
        )}
        {sound.destination === 'browser'
          ? msg(' It is selected now, so Listen and accompaniment play through this device instead.')
          : ''}
      </Help>

      <div class={styles.options}>
        <Toggle
          label={msg('Send score pedals in one-hand practice')}
          description={msg(
            'Off by default. Turn on only if you checked that the app’s pedal presses affect just the part the piano plays.',
          )}
          checked={route.automaticPedalsInHandPractice}
          onChange={(automaticPedalsInHandPractice) => updateSettings({ route: { automaticPedalsInHandPractice } })}
        />
        <Help>
          {msg(
            'While you play one hand, your own feet control the shared pedals, so two pedal sources never fight over the same sound. Listen always plays the score’s pedals.',
          )}
        </Help>
      </div>

      <div class={styles.stopRow}>
        <Button variant="danger" icon="stop" onClick={stop} disabled={!connected}>
          {msg('Stop sound')}
        </Button>
        <Help>
          {msg('Silences notes the app left sounding, on')} {channelLabel(route.outputChannel)}{' '}
          {msg('of the app’s output only.')}
        </Help>
      </div>
      {stopped ? (
        <Callout tone={stopped.sent ? 'success' : 'warning'} live>
          <p>
            {stopped.sent
              ? msg('Sent “all notes off” to {0} on {1}.', stopped.outputName, channelLabel(stopped.channel))
              : msg('Nothing could be sent: the output is not connected.')}
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
      <Callout tone="warning" title={msg('The test notes could not be sent')} live>
        <p>{msg('The output may have just disconnected. Check the cable or Bluetooth link and try again.')}</p>
      </Callout>
    )
  }
  if (state === 'asking') {
    return (
      <div class={styles.question} role="group" aria-labelledby="connection-heard-question">
        <p id="connection-heard-question" class={styles.questionText}>
          {msg('Did the piano itself play three short notes?')}
        </p>
        <div class={styles.actions}>
          <Button variant="primary" icon="check" onClick={() => onAnswer(true)}>
            {msg('Yes, I heard them')}
          </Button>
          <Button onClick={() => onAnswer(false)}>{msg('No sound')}</Button>
        </div>
      </div>
    )
  }
  if (state === 'silent') {
    return (
      <Callout tone="warning" title={msg('The piano did not sound')} live>
        <ul class={styles.list}>
          <li>
            {msg('Try another receive channel — many pianos listen on channel 1. Some use 2 or 3 for a second voice.')}
          </li>
          <li>{msg('Check the cable direction: the interface’s MIDI Out must go to the piano’s MIDI In.')}</li>
          <li>{msg('Turn the piano’s volume up and check that it accepts MIDI on this channel.')}</li>
          <li>
            {msg('A port in this list is not proof the piano can play what the app sends. Only the sound confirms it.')}
          </li>
        </ul>
      </Callout>
    )
  }
  if (route.outputVerified && connected) {
    return (
      <Callout
        tone="success"
        title={msg('The piano sounds on {0}', channelLabel(route.outputChannel))}
        live={state === 'heard'}
      >
        <p>
          {route.echo === 'none'
            ? msg(
                'Accompaniment and Listen play on the piano, and its notes do not come back as if you had played them, so one-hand practice can grade you. ',
              )
            : msg('Accompaniment and Listen play on the piano. ')}
          {msg('Choosing another output or channel needs a new test.')}
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
      <Callout tone="warning" title={msg('Echo check inconclusive — please play the test notes again')} live>
        <p>
          {msg(
            'One test note came back at a different strength, which could have been a key you touched. The previous result is kept. Keep your hands away from the keys and play them again.',
          )}
        </p>
      </Callout>
    )
  }
  if (route.echo === 'echo-detected') {
    return (
      <Callout tone="danger" title={msg('Echo detected')} live={result !== null}>
        <p>
          {msg('Notes the app plays come back from the piano')}
          {result?.latencyMs != null ? msg(' (after {0} ms)', Math.round(result.latencyMs)) : ''}
          {msg(
            '. They would look like your own playing, so graded one-hand practice is off for this route until it is fixed. Listen still works, and the app never sends returned notes back to the piano.',
          )}
        </p>
        <p>
          {msg(
            'To fix it, turn off MIDI Thru or echo on the piano or interface, or choose another output channel, then play the test notes again.',
          )}
        </p>
        {result?.otherInput ? (
          <p>
            {msg(
              'Other keys were played during the test. If you touched the piano, play them again with your hands off.',
            )}
          </p>
        ) : null}
      </Callout>
    )
  }
  if (route.echo === 'untested' && route.outputVerified) {
    return (
      <Callout tone="info" title={msg('Echo not checked yet')} live={result !== null}>
        <p>
          {msg('Graded one-hand practice needs to know that the app’s notes do not come back from the piano.')}{' '}
          {inputConnected
            ? msg('Play the test notes again with your hands off the keys.')
            : msg('Connect the piano input, then play the test notes again.')}
        </p>
      </Callout>
    )
  }
  return null
}
