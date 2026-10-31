/**
 * Note names (spec "Mistake feedback and hints"): letter or fixed-do names, si/ti, octave display,
 * "Always show effective accidentals" (default on) and "Simplify enharmonic names" (default off).
 * Naming only changes label text, so every change applies immediately and never interrupts
 * practice; the examples below recompute from the same `core/naming` code the hints use.
 */
import { settings, updateSettings } from '../../app/state'
import { Segmented, Toggle } from '../../ui/controls'
import { Group, Help, Setting } from './parts'
import { exampleLabels } from './namingExamples'
import styles from './settings.module.css'

export function NamingSection() {
  const naming = settings.value.naming
  return (
    <>
      <Group>
        <Setting label="Naming system" description="Fixed do means C is always do.">
          <Segmented
            label="Naming system"
            value={naming.system}
            options={[
              { value: 'letter', label: 'Letter names', title: 'C D E F G A B' },
              { value: 'fixed-do', label: 'Fixed do', title: 'do re mi fa sol la si' },
            ]}
            onChange={(system) => updateSettings({ naming: { system } })}
          />
        </Setting>
        {naming.system === 'fixed-do' ? (
          <Setting label="Seventh note">
            <Segmented
              label="Seventh note"
              value={naming.seventh}
              options={[
                { value: 'si', label: 'si' },
                { value: 'ti', label: 'ti' },
              ]}
              onChange={(seventh) => updateSettings({ naming: { seventh } })}
            />
          </Setting>
        ) : null}
        <Toggle
          label="Show octave number"
          description="C4 is middle C."
          checked={naming.showOctave}
          onChange={(showOctave) => updateSettings({ naming: { showOctave } })}
        />
        <Toggle
          label="Always show effective accidentals"
          description="Name the actual pitch as if there were no key signature: a C made sharp by the key is C♯."
          checked={naming.alwaysShowEffectiveAccidentals}
          onChange={(alwaysShowEffectiveAccidentals) => updateSettings({ naming: { alwaysShowEffectiveAccidentals } })}
        />
        <Toggle
          label="Simplify enharmonic names"
          description="B♯ becomes C, C♭ becomes B, E♯ becomes F, F♭ becomes E, and double accidentals are reduced."
          checked={naming.simplifyEnharmonics}
          onChange={(simplifyEnharmonics) => updateSettings({ naming: { simplifyEnharmonics } })}
        />
      </Group>
      <Group title="Example">
        <ul class={styles.examples} aria-label="Example labels">
          {exampleLabels(naming).map(({ example, label }) => (
            <li key={example.id} class={styles.example}>
              <span class={styles.exampleWritten}>{example.description}</span>
              <span class={styles.exampleArrow} aria-hidden="true">
                →
              </span>
              <strong class={styles.exampleLabel} data-testid={`example-${example.id}`}>
                {label}
              </strong>
            </li>
          ))}
        </ul>
        <Help>
          These preferences only change label text. The printed score, matching and which notes are labeled stay the
          same.
        </Help>
      </Group>
    </>
  )
}
