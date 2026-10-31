/**
 * Step 6, accompaniment options (spec "MIDI input, output, and pedal controls"): the
 * accompaniment level scales only app-generated velocity; score pedals in one-hand practice are
 * sent only when verified to affect the automatic part alone (default off); graded
 * accompaniment needs a verified, echo-free route; Stop sound recovers stuck notes on the app's
 * output route only.
 */
import { useState } from 'preact/hooks'
import type { MidiService, MidiSnapshot, StopSoundResult } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import { Button, Slider, Toggle } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { Callout, Help, Step } from './parts'
import { channelLabel, playbackReadiness, type StepStatus } from './status'
import styles from './connection.module.css'

const percent = (v: number): string => `${Math.round(v * 100)}%`

export function PlaybackStep({
  index,
  status,
  snap,
  service,
}: {
  index: number
  status: StepStatus
  snap: MidiSnapshot
  service: MidiService
}) {
  const { route, sound } = settings.value
  const readiness = playbackReadiness(snap, route)
  const [stopped, setStopped] = useState<StopSoundResult | null>(null)
  const stop = () => setStopped(service.stopSound())

  return (
    <Step
      id="playback"
      index={index}
      title="Accompaniment"
      status={status}
      lead="How the piano plays the part you are not playing."
    >
      <div class={styles.readiness}>
        <p class={styles.readinessTitle}>
          {readiness.graded
            ? 'One-hand practice: the piano plays the other hand and you are graded.'
            : readiness.pianoPlayback
              ? 'Preview plays on the piano. Graded one-hand practice needs an echo-free route.'
              : 'The piano cannot play for the app yet. Both-hands practice still works.'}
        </p>
        <ul class={styles.checks} aria-label="What graded accompaniment needs">
          {readiness.items.map((item) => (
            <li key={item.id} data-ok={item.ok ? '' : undefined}>
              <span class={styles.checkIcon} aria-hidden="true">
                {item.ok ? <Icon name="check" size={16} /> : <span class={styles.pillRing} />}
              </span>
              <span>
                <span class="visually-hidden">{item.ok ? 'Done: ' : 'To do: '}</span>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
        {sound.destination === 'browser' ? (
          <Help>
            Browser sound is selected in Settings → Sound, so Preview and accompaniment play through this device
            instead.
          </Help>
        ) : null}
      </div>

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
        While you play one hand, your own feet control the shared pedals, so two pedal sources never fight over the same
        sound. Preview always plays the score’s pedals.
      </Help>

      <div class={styles.stopRow}>
        <Button variant="danger" icon="stop" onClick={stop} disabled={!snap.output?.connected}>
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
