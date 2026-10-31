/**
 * Pedal (spec "MIDI input, output, and pedal controls"): what the assigned hint pedal reveals
 * (note names by default, or the keyboard guide), a summary of the learned mapping, and a way to
 * (re)learn it, which lives in the Connection view.
 */
import { closeSettings, navigate } from '../../app/navigation'
import { settings, updateSettings } from '../../app/state'
import { Button, Segmented } from '../../ui/controls'
import { Group, Help, Setting } from './parts'
import { describeHintPedal, describeObservedPedals } from './pedalSummary'
import styles from './settings.module.css'

export function PedalSection() {
  const pedal = settings.value.pedal
  const observed = describeObservedPedals(pedal)
  return (
    <>
      <Group>
        <Setting
          label="Hint pedal action"
          description="A press reveals this once. Holding the pedal never repeats it, and taps never escalate to anything else."
        >
          <Segmented
            label="Hint pedal action"
            value={pedal.hintPedalAction}
            options={[
              { value: 'names', label: 'Note names' },
              { value: 'keys', label: 'Show keys' },
            ]}
            onChange={(hintPedalAction) => updateSettings({ pedal: { hintPedalAction } })}
          />
        </Setting>
      </Group>
      <Group title="Current pedal">
        <p class={styles.summary} data-testid="pedal-summary">
          {describeHintPedal(pedal.hintPedal)}
        </p>
        {observed ? <Help>Pedals your piano sent during setup: {observed}.</Help> : null}
        <div>
          <Button
            icon="plug"
            onClick={() => {
              closeSettings()
              navigate('connection')
            }}
          >
            Set up in Connection
          </Button>
        </div>
        <Help>
          If your piano does not send the middle pedal, keep using the Hint button. Using a pedal here may not stop it
          from changing the piano's own sound.
        </Help>
      </Group>
    </>
  )
}
