/**
 * Step 1, MIDI access (spec "Delivery and device compatibility"): explain, then request access
 * through the browser's permission flow on an explicit button press; explain unsupported
 * browsers (Safari: MIDIWeb on iPad or Chrome on a computer) and how to re-allow a blocked
 * permission. Pairing is done by the system or browser, never by this site.
 */
import type { MidiService, MidiSnapshot } from '../../app/services'
import type { FeatureReport } from '../../app/features'
import { Button } from '../../ui/controls'
import { Callout, Help, Step } from './parts'
import type { StepStatus } from './status'
import styles from './connection.module.css'

export function AccessStep({
  index,
  status,
  snap,
  service,
  features,
}: {
  index: number
  status: StepStatus
  snap: MidiSnapshot
  service: MidiService
  features: FeatureReport
}) {
  const request = () => void service.connect()
  return (
    <Step
      id="access"
      index={index}
      title="MIDI access"
      status={status}
      lead="Let Pianissimo hear your piano and play notes on it."
    >
      <AccessBody snap={snap} features={features} onRequest={request} />
      <PairingGuide />
    </Step>
  )
}

function AccessBody({
  snap,
  features,
  onRequest,
}: {
  snap: MidiSnapshot
  features: FeatureReport
  onRequest: () => void
}) {
  switch (snap.access) {
    case 'unsupported':
      return (
        <Callout tone="warning" title="This browser cannot connect a piano">
          <p>{features.features.webMidi.explanation ?? snap.message}</p>
          <ul class={styles.list}>
            <li>
              <strong>iPad:</strong> open Pianissimo in the free MIDIWeb Browser app. Safari and Home Screen shortcuts
              have no Web MIDI.
            </li>
            <li>
              <strong>Computer:</strong> use standard desktop Chrome; no special browser is needed.
            </li>
          </ul>
        </Callout>
      )
    case 'granted':
      return (
        <Callout tone="success" title="MIDI access is allowed">
          <p>Your MIDI devices are listed below. Nothing is sent to the piano until you test it.</p>
        </Callout>
      )
    case 'denied':
      return (
        <>
          <Callout tone="danger" title="MIDI access is blocked" live>
            <p>{snap.message}</p>
            <ol class={styles.list}>
              <li>In Chrome, click the site controls icon at the left of the address bar.</li>
              <li>Open Site settings and set “MIDI devices” to Allow.</li>
              <li>Come back here and press Try again. Some browsers need the page reloaded first.</li>
            </ol>
            <p>In MIDIWeb or another browser, look for this site’s MIDI permission in the browser settings.</p>
          </Callout>
          <div class={styles.actions}>
            <Button variant="primary" onClick={onRequest}>
              Try again
            </Button>
          </div>
        </>
      )
    case 'error':
      return (
        <>
          <Callout tone="warning" title="MIDI could not start" live>
            <p>{snap.message}</p>
          </Callout>
          <div class={styles.actions}>
            <Button variant="primary" onClick={onRequest}>
              Try again
            </Button>
          </div>
        </>
      )
    case 'idle':
    case 'requesting': {
      const busy = snap.access === 'requesting'
      return (
        <>
          <Help>
            {snap.permission === 'denied'
              ? 'The browser is set to block MIDI for this site. Allow it in the site settings, then try here.'
              : 'Your browser will ask whether this site may use MIDI devices. Choose Allow. Pianissimo does not need system-exclusive messages.'}
          </Help>
          <div class={styles.actions}>
            <Button variant="primary" icon="plug" onClick={onRequest} disabled={busy} aria-busy={busy}>
              {busy ? 'Waiting for your answer…' : 'Allow MIDI access'}
            </Button>
          </div>
        </>
      )
    }
  }
}

/** Connection guidance (spec "Delivery and device compatibility"; "MIDI input, output, and pedal controls"). */
function PairingGuide() {
  return (
    <details class={styles.details}>
      <summary>How to connect your piano</summary>
      <div class={styles.detailsBody}>
        <p>
          <strong>USB:</strong> connect the piano’s USB (often “USB to Host”) port to this device. On iPad, use a USB-C
          or Lightning adapter.
        </p>
        <p>
          <strong>Traditional 5-pin MIDI sockets:</strong> use a USB MIDI interface. The piano’s MIDI Out goes to the
          interface’s MIDI In (so the app hears you), and the interface’s MIDI Out goes to the piano’s MIDI In (so the
          app can play the piano).
        </p>
        <p>
          <strong>Bluetooth:</strong> the piano must offer Bluetooth MIDI (Bluetooth LE MIDI). Pair it in the system’s
          or MIDIWeb’s own Bluetooth MIDI settings — this website never pairs devices. Bluetooth audio alone is not
          enough: it only carries sound, not notes.
        </p>
      </div>
    </details>
  )
}
