import { msg } from '../../i18n/messages'
/**
 * The piano setup (spec "Main user journey" step 3; "MIDI input, output, and pedal
 * controls"; "Delivery and device compatibility"): three independent setup steps
 * (DECISIONS C11) — the piano (MIDI access, input with a live key/pedal test), playback to the
 * piano (output, test notes that double as the echo probe, accompaniment options) and the hint
 * pedal — with the remembered route.
 *
 * It is the Piano section of Settings → Piano and sound (U143), lazily loaded from `app/views.ts` and
 * mounted only while that tab is shown. MIDI input only reaches the live panel and the hint-pedal
 * flow, both rendered at most once per animation frame.
 */
import { useEffect } from 'preact/hooks'
import { getMidiService, type MidiService, type MidiSnapshot } from '../../app/services'
import { getFeatures, type FeatureReport } from '../../app/features'
import { settings } from '../../app/state'
import type { MidiRouteSettings } from '../../core/model/settings'
import { Icon } from '../../ui/icons'
import { HintPedalStep } from './HintPedalStep'
import { LivePanel } from './LivePanel'
import { PianoStep } from './PianoStep'
import { useMidiSnapshot } from './parts'
import { PlaybackStep } from './PlaybackStep'
import { STEP_ORDER, channelLabel, stepStatuses, type StepId } from './status'
import type { EchoClock } from './testNotes'
import styles from './connection.module.css'

/** The registered screen (no props): the app's MIDI service and this browser's features. */
export function ConnectionView() {
  return <ConnectionSetup />
}

/** The setup; tests inject the service, feature report and the test-note clock. */
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
          {msg(
            'Connect your piano and make sure the app can play it. Each step works on its own. Everything is remembered on this device.',
          )}
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
    </div>
  )
}

/** "Remembered: Piano → Piano, channel 1" and whether it is connected now. */
function RouteMemory({ snap, route }: { snap: MidiSnapshot; route: MidiRouteSettings }) {
  if (route.inputName === null && route.outputName === null) return null
  const parts = [
    route.inputName ?? msg('no input'),
    route.outputName ? `${route.outputName}, ${channelLabel(route.outputChannel)}` : msg('no output'),
  ]
  const connected = snap.input?.connected === true
  const state =
    snap.access !== 'granted'
      ? msg('Reconnects once MIDI access is allowed.')
      : connected
        ? msg('Connected now.')
        : msg('Not connected — it is picked up automatically when the piano is available.')
  return (
    <p class={styles.memory} data-connected={connected ? '' : undefined}>
      <Icon name={connected ? 'check' : 'plug'} size={18} />
      <span>
        <strong>{msg('Remembered:')}</strong> {parts.join(' → ')}. {state}
      </span>
    </p>
  )
}
