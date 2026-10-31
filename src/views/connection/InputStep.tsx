/**
 * Step 2, piano input (spec "MIDI input, output, and pedal controls": list inputs separately,
 * select one piano input, live key and pedal tests, remember the route). The live test itself
 * is the `LivePanel` beside or below this step.
 */
import type { MidiService, MidiSnapshot } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import type { MidiRouteSettings } from '../../core/model/settings'
import { Segmented } from '../../ui/controls'
import { Callout, Help, PortList, Step } from './parts'
import type { StepStatus } from './status'
import styles from './connection.module.css'

const CONNECTION_HELP: Readonly<Record<MidiRouteSettings['connection'], string>> = {
  usb: 'USB cable or a USB MIDI interface.',
  bluetooth:
    'Bluetooth MIDI, paired in the system or MIDIWeb settings. Bluetooth timing can vary a little more than USB.',
  unknown: 'Recorded with this route so you can tell set-ups apart later.',
}

export function InputStep({
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
  const route = settings.value.route
  const granted = snap.access === 'granted'
  const rememberedMissing =
    granted && !snap.input && route.inputName !== null && !snap.inputs.some((p) => p.name === route.inputName)
  return (
    <Step
      id="input"
      index={index}
      title="Piano input"
      status={status}
      lead="Choose the port your piano sends its keys and pedals on."
    >
      {!granted ? (
        <Help>Allow MIDI access first; your piano’s ports then appear here.</Help>
      ) : snap.inputs.length === 0 && !snap.input ? (
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
    </Step>
  )
}
