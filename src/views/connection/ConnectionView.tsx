/**
 * Connection and Pedal Setup (spec "Main user journey" step 3; "MIDI input, output, and pedal
 * controls"; "Delivery and device compatibility"): three independent setup steps
 * (DECISIONS C11) — the piano (MIDI access, input with a live key/pedal test), playback to the
 * piano (output, test notes that double as the echo probe, accompaniment options) and the hint
 * pedal — with the remembered route and a clear exit.
 *
 * It is the content of the Connection modal (`ConnectionModal`, over whichever view is current;
 * the modal's header carries the title). Lazily loaded from `app/views.ts`. MIDI input only
 * reaches the live panel and the hint-pedal flow, both rendered at most once per animation frame.
 */
import { useEffect } from 'preact/hooks'
import { getMidiService, type MidiService, type MidiSnapshot } from '../../app/services'
import { getFeatures, type FeatureReport } from '../../app/features'
import { closeConnection } from '../../app/navigation'
import { settings } from '../../app/state'
import type { MidiRouteSettings } from '../../core/model/settings'
import { Button } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { HintPedalStep } from './HintPedalStep'
import { LivePanel } from './LivePanel'
import { PianoStep } from './PianoStep'
import { useMidiSnapshot } from './parts'
import { PlaybackStep, type EchoClock } from './PlaybackStep'
import { STEP_ORDER, channelLabel, stepStatuses, type StepId, type StepStatus } from './status'
import styles from './connection.module.css'

/** The registered screen (no props): the app's MIDI service and this browser's features. */
export function ConnectionView() {
  return <ConnectionSetup />
}

/** The setup page; tests inject the service, feature report and the test-note clock. */
export function ConnectionSetup({
  service = getMidiService(),
  features = getFeatures(),
  clock,
}: {
  service?: MidiService
  features?: FeatureReport
  clock?: EchoClock
}) {
  const snap = useMidiSnapshot(service)
  const current = settings.value
  const statuses = stepStatuses(snap, current)

  // Read the permission without prompting. When it is already granted no prompt can appear,
  // so connect straight away (DECISIONS C2); otherwise wait for the Allow button.
  useEffect(() => {
    if (service.adapter.status === 'unsupported') return
    let live = true
    void service.readPermission().then((permission) => {
      if (live && permission === 'granted' && service.adapter.status === 'idle') void service.connect()
    })
    return () => {
      live = false
    }
  }, [service])

  const index = (id: StepId) => STEP_ORDER.indexOf(id) + 1
  return (
    <div class={styles.page}>
      <header class={styles.hero}>
        <p class={styles.intro}>
          Connect your piano and make sure the app can play it. Each step works on its own. Everything is remembered on
          this device.
        </p>
        <RouteMemory snap={snap} route={current.route} />
      </header>

      <div class={styles.layout}>
        <PianoStep index={index('piano')} status={statuses.piano} snap={snap} service={service} features={features} />
        <LivePanel snap={snap} service={service} />
        <PlaybackStep
          index={index('playback')}
          status={statuses.playback}
          snap={snap}
          service={service}
          {...(clock ? { clock } : {})}
        />
        <HintPedalStep index={index('pedal')} status={statuses.pedal} snap={snap} service={service} />
      </div>

      <footer class={styles.done}>
        <p>{doneSummary(statuses)}</p>
        <div class={styles.actions}>
          <Button variant="primary" icon="check" onClick={closeConnection}>
            Done
          </Button>
        </div>
      </footer>
    </div>
  )
}

function doneSummary(statuses: Readonly<Record<StepId, StepStatus>>): string {
  if (statuses.piano.tone !== 'done')
    return 'You can come back here any time from the connection status at the top of the screen.'
  if (statuses.playback.tone === 'done')
    return 'Your piano is ready for both-hands and one-hand practice, with the piano playing the other hand.'
  return 'Your piano is ready for both-hands practice. One-hand practice needs playback to the piano, or browser sound in Settings → Sound.'
}

/** "Remembered: Piano → Piano, channel 1" and whether it is connected now. */
function RouteMemory({ snap, route }: { snap: MidiSnapshot; route: MidiRouteSettings }) {
  if (route.inputName === null && route.outputName === null) return null
  const parts = [
    route.inputName ?? 'no input',
    route.outputName ? `${route.outputName}, ${channelLabel(route.outputChannel)}` : 'no output',
  ]
  const connected = snap.input?.connected === true
  const state =
    snap.access !== 'granted'
      ? 'Reconnects once MIDI access is allowed.'
      : connected
        ? 'Connected now.'
        : 'Not connected — it is picked up automatically when the piano is available.'
  return (
    <p class={styles.memory} data-connected={connected ? '' : undefined}>
      <Icon name={connected ? 'check' : 'plug'} size={18} />
      <span>
        <strong>Remembered:</strong> {parts.join(' → ')}. {state}
      </span>
    </p>
  )
}
