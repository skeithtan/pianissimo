/**
 * Connection and Pedal Setup (spec "Main user journey" step 3; "MIDI input, output, and pedal
 * controls"; "Delivery and device compatibility"): a calm checklist of independent steps —
 * access, input with a live key/pedal test, output with a confirmed test note, echo test, hint
 * pedal, accompaniment options — with the remembered route and a clear exit.
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
import { AccessStep } from './AccessStep'
import { EchoStep } from './EchoStep'
import { HintPedalStep } from './HintPedalStep'
import { InputStep } from './InputStep'
import { LivePanel } from './LivePanel'
import { OutputStep } from './OutputStep'
import { StatusPill, stepAnchor, useMidiSnapshot } from './parts'
import { PlaybackStep } from './PlaybackStep'
import { STEP_ORDER, STEP_TITLES, channelLabel, stepStatuses, type StepId, type StepStatus } from './status'
import styles from './connection.module.css'

/** The registered screen (no props): the app's MIDI service and this browser's features. */
export function ConnectionView() {
  return <ConnectionSetup />
}

/** The setup page; tests inject the service and feature report. */
export function ConnectionSetup({
  service = getMidiService(),
  features = getFeatures(),
}: {
  service?: MidiService
  features?: FeatureReport
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
          Connect your piano, check its keys and pedals, and make sure the app can play it. Each step works on its own;
          everything is remembered on this device.
        </p>
        <RouteMemory snap={snap} route={current.route} />
        <Checklist statuses={statuses} />
      </header>

      <div class={styles.layout}>
        <AccessStep
          index={index('access')}
          status={statuses.access}
          snap={snap}
          service={service}
          features={features}
        />
        <InputStep index={index('input')} status={statuses.input} snap={snap} service={service} />
        <LivePanel snap={snap} service={service} />
        <OutputStep index={index('output')} status={statuses.output} snap={snap} service={service} />
        <EchoStep index={index('echo')} status={statuses.echo} snap={snap} service={service} />
        <HintPedalStep index={index('pedal')} status={statuses.pedal} snap={snap} service={service} />
        <PlaybackStep index={index('playback')} status={statuses.playback} snap={snap} service={service} />
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
  const ready = STEP_ORDER.filter((id) => statuses[id].tone === 'done').length
  if (statuses.input.tone !== 'done')
    return 'You can come back here any time from the connection status at the top of the screen.'
  return `${ready} of ${STEP_ORDER.length} steps complete. Your piano is ready for both-hands practice.`
}

/** "Remembered: Piano → Piano, channel 1 · USB" and whether it is connected now. */
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
        <strong>Remembered:</strong> {parts.join(' → ')}
        {route.connection !== 'unknown' ? ` · ${route.connection === 'usb' ? 'USB' : 'Bluetooth'}` : ''}. {state}
      </span>
    </p>
  )
}

/** Overview of every step; each item jumps to its step. */
function Checklist({ statuses }: { statuses: Readonly<Record<StepId, StepStatus>> }) {
  const go = (id: StepId) => {
    const section = document.getElementById(stepAnchor(id))
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }
  return (
    <nav class={styles.checklist} aria-label="Setup steps">
      <ol>
        {STEP_ORDER.map((id, i) => (
          <li key={id}>
            <button type="button" class={styles.checkItem} data-tone={statuses[id].tone} onClick={() => go(id)}>
              <span class={styles.checkNumber} aria-hidden="true">
                {statuses[id].tone === 'done' ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <span class={styles.checkText}>
                <span class={styles.checkTitle}>{STEP_TITLES[id]}</span>
                <StatusPill status={statuses[id]} />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
