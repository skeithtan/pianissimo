import { msg } from '../../i18n/messages'
/**
 * Keep time (rhythm mode, DECISIONS P13): how close to its scheduled time a note must be to count
 * as on time. Tight ±80 ms / Normal ±150 ms (the default) / Loose ±250 ms. Applies immediately;
 * a change during a Keep time attempt stops it (a different tolerance is a different comparison
 * context, like a label change).
 */
import { settings, updateSettings } from '../../app/state'
import { Segmented } from '../../ui/controls'
import { Group, Help, Setting } from './parts'

type ToleranceChoice = '80' | '150' | '250'

export const TOLERANCE_OPTIONS: readonly { value: ToleranceChoice; label: string }[] = [
  { value: '80', label: 'Tight ±80 ms' },
  { value: '150', label: 'Normal ±150 ms' },
  { value: '250', label: 'Loose ±250 ms' },
]

export function KeepTimeGroup() {
  const toleranceMs = settings.value.rhythm.toleranceMs
  const value = TOLERANCE_OPTIONS.find((o) => o.value === String(toleranceMs))?.value ?? null
  return (
    <Group title={msg('Keep time')}>
      <Setting
        label={msg('Timing window')}
        description={msg(
          'With Keep time on, the music never waits: a note played within this window of its beat counts as on time, a later one is missed.',
        )}
      >
        <Segmented
          label={msg('Keep time window')}
          value={value}
          options={TOLERANCE_OPTIONS.map((o) => ({ ...o, label: msg(o.label) }))}
          onChange={(choice) => updateSettings({ rhythm: { toleranceMs: Number(choice) } })}
        />
      </Setting>
      {value === null ? (
        <Help>
          {msg('Now ±')}
          {toleranceMs} ms.
        </Help>
      ) : null}
    </Group>
  )
}
