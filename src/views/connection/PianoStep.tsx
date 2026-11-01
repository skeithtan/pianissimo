/**
 * Step 1, the piano (spec "Delivery and device compatibility"; "MIDI input, output, and pedal
 * controls"): MIDI access through the browser's permission flow on an explicit button press
 * (unsupported browsers: MIDIWeb on iPad or Chrome on a computer; how to re-allow a blocked
 * permission), then the piano input: list inputs separately, select one, live key and pedal
 * tests (the `LivePanel` beside or below this step), remember the route. Boot already asks for
 * access and picks a lone piano (DECISIONS C9), so this step is usually done on arrival; access
 * and input are one step because the second is the only thing to do once the first succeeds
 * (C11). Pairing is done by the system or browser, never by this site.
 */
import type { MidiService, MidiSnapshot } from '../../app/services'
import type { FeatureReport } from '../../app/features'
import { settings, updateSettings } from '../../app/state'
import type { MidiRouteSettings } from '../../core/model/settings'
import { Button, Segmented } from '../../ui/controls'
import { Callout, Help, PortList, Step } from './parts'
import type { StepStatus } from './status'
import styles from './connection.module.css'

const CONNECTION_HELP: Readonly<Record<MidiRouteSettings['connection'], string>> = {
  usb: 'USB cable or a USB MIDI interface.',
  bluetooth:
    'Bluetooth MIDI, paired in the system or MIDIWeb settings. Bluetooth timing can vary a little more than USB.',
  unknown: 'Recorded with this route so you can tell set-ups apart later.',
}

export function PianoStep({
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
  const route = settings.value.route
  const granted = snap.access === 'granted'
  const request = () => void service.connect()
  return (
    <Step
      id="piano"
      index={index}
      title="Your piano"
      status={status}
      lead="Let Pianissimo hear your piano, and choose the port it sends its keys and pedals on."
    >
      {granted ? (
        <InputBody snap={snap} service={service} route={route} />
      ) : (
        <AccessBody snap={snap} features={features} onRequest={request} />
      )}
      <div class={styles.inline}>
        <span class={styles.inlineLabel} id="connection-type-label">
          Connection type
        </span>
        <Segmented
          label="Connection type"
          value={route.connection}
          compact
          options={[
            { value: 'usb', label: 'USB' },
            { value: 'bluetooth', label: 'Bluetooth' },
            { value: 'unknown', label: 'Not sure' },
          ]}
          onChange={(connection) => updateSettings({ route: { connection } })}
        />
      </div>
      <Help>{CONNECTION_HELP[route.connection]}</Help>
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
    case 'granted':
      return null
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

function InputBody({ snap, service, route }: { snap: MidiSnapshot; service: MidiService; route: MidiRouteSettings }) {
  const rememberedMissing =
    !snap.input && route.inputName !== null && !snap.inputs.some((p) => p.name === route.inputName)
  return (
    <>
      {snap.inputs.length === 0 && !snap.input ? (
        <Callout tone="info" title="No MIDI input found">
          <p>
            Check that the piano is on and its cable is connected, or pair it in the system’s Bluetooth MIDI settings.
            New devices appear here by themselves.
          </p>
        </Callout>
      ) : (
        <PortList
          label="MIDI inputs"
          name="midi-input"
          ports={snap.inputs}
          selected={snap.input}
          rememberedName={route.inputName}
          onSelect={(id) => service.selectInput(id)}
        />
      )}
      {rememberedMissing ? (
        <Help>
          Your remembered piano, {route.inputName}, is not connected. Turn it on or plug it in: it is selected
          automatically when it appears.
        </Help>
      ) : null}
      {snap.input && !snap.input.connected ? (
        <Callout tone="warning" title={`${snap.input.name} is disconnected`} live>
          <p>
            Reconnect the piano. It is picked up again automatically; release all keys and pedals before practicing.
          </p>
        </Callout>
      ) : null}
      {snap.input?.connected ? (
        <Help>
          Play a few keys softly and loudly, a chord, and each pedal. Every press and release should appear once in Live
          input, with its velocity.
        </Help>
      ) : null}
    </>
  )
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
