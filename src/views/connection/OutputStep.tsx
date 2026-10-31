/**
 * Step 3, playback to the piano (spec "MIDI input, output, and pedal controls"): list outputs
 * separately, choose one and the piano's receive channel, then an explicit Play test note
 * followed by "Did the piano sound?" — a visible output port is not proof the instrument can
 * sound it. Physical-piano playback is required for one-hand practice and Preview; browser
 * sound is an explicit alternative that never silently replaces the piano.
 */
import { useEffect, useState } from 'preact/hooks'
import type { MidiService, MidiSnapshot } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import { openSettings } from '../../app/navigation'
import { playTestNote } from '../../core/midi/testNote'
import { Button } from '../../ui/controls'
import { Callout, Help, PortList, Step } from './parts'
import { channelLabel, type StepStatus } from './status'
import styles from './connection.module.css'

type TestState = 'idle' | 'asking' | 'heard' | 'silent' | 'failed'

export function OutputStep({
  index,
  status,
  snap,
  service,
  now = () => performance.now(),
}: {
  index: number
  status: StepStatus
  snap: MidiSnapshot
  service: MidiService
  now?: () => number
}) {
  const route = settings.value.route
  const [test, setTest] = useState<TestState>('idle')
  const granted = snap.access === 'granted'
  const connected = snap.output?.connected === true
  const outputKey = `${snap.output?.id ?? ''}:${route.outputChannel}`

  // A different output or channel is a new route: forget the previous answer.
  useEffect(() => setTest('idle'), [outputKey])

  const play = () => {
    const output = service.adapter.output
    if (!output) return
    setTest(playTestNote(output, now(), { channel: route.outputChannel }) ? 'asking' : 'failed')
  }
  const answer = (heard: boolean) => {
    updateSettings({ route: { outputVerified: heard } })
    setTest(heard ? 'heard' : 'silent')
  }

  return (
    <Step
      id="output"
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
          <Button variant="primary" icon="sound" onClick={play} disabled={!connected}>
            Play test note
          </Button>
        </div>
      ) : null}

      <TestFeedback
        state={test}
        verified={route.outputVerified}
        channel={route.outputChannel}
        connected={connected}
        onAnswer={answer}
      />

      <Help>
        One-hand practice and Preview need the piano itself to play. If it cannot, they stay off. Browser sound (
        <button type="button" class={styles.linkButton} onClick={openSettings}>
          Settings → Sound
        </button>
        ) is a separate choice and never replaces the piano without you choosing it.
      </Help>
    </Step>
  )
}

function TestFeedback({
  state,
  verified,
  channel,
  connected,
  onAnswer,
}: {
  state: TestState
  verified: boolean
  channel: number
  connected: boolean
  onAnswer: (heard: boolean) => void
}) {
  if (state === 'failed') {
    return (
      <Callout tone="warning" title="The test note could not be sent" live>
        <p>The output may have just disconnected. Check the cable or Bluetooth link and try again.</p>
      </Callout>
    )
  }
  if (state === 'asking') {
    return (
      <div class={styles.question} role="group" aria-labelledby="connection-heard-question">
        <p id="connection-heard-question" class={styles.questionText}>
          Did the piano itself play a note?
        </p>
        <div class={styles.actions}>
          <Button variant="primary" icon="check" onClick={() => onAnswer(true)}>
            Yes, I heard it
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
          <li>Try another receive channel — many pianos listen on channel 1; some use 2 or 3 for a second voice.</li>
          <li>Check the cable direction: the interface’s MIDI Out must go to the piano’s MIDI In.</li>
          <li>Turn the piano’s volume up and check that it accepts MIDI on this channel.</li>
          <li>A port in this list is not proof the piano can play what the app sends; only the sound is.</li>
        </ul>
      </Callout>
    )
  }
  if (verified && connected) {
    return (
      <Callout tone="success" title={`The piano sounds on ${channelLabel(channel)}`} live={state === 'heard'}>
        <p>Accompaniment and Preview play on the piano. Choosing another output or channel needs a new test.</p>
      </Callout>
    )
  }
  return null
}
