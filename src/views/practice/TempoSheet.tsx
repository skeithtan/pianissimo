/**
 * Practice tempo entry for a score without a numerical tempo (spec "Missing numerical tempos
 * require user input to establish the reference tempo before relative speed controls can be
 * used"). Saved on the piece (`userTempo`); the model applies it through `withUserTempo`.
 */
import { useState } from 'preact/hooks'
import { rat, type Rational } from '../../core/music/rational'
import type { UserTempo } from '../../core/storage/records'
import { Button, Field, Sheet } from '../../ui/controls'
import styles from './practice.module.css'

const UNITS: readonly { readonly id: string; readonly label: string; readonly unit: Rational }[] = [
  { id: 'q', label: 'Quarter note ♩', unit: rat(1, 4) },
  { id: 'dq', label: 'Dotted quarter ♩.', unit: rat(3, 8) },
  { id: 'h', label: 'Half note 𝅗𝅥', unit: rat(1, 2) },
  { id: 'e', label: 'Eighth note ♪', unit: rat(1, 8) },
]

export function parseBpm(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'))
  return Number.isFinite(v) && v >= 10 && v <= 400 ? v : null
}

export function TempoSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean
  onClose: () => void
  onSave: (t: UserTempo) => void
}) {
  const [bpm, setBpm] = useState('72')
  const [unit, setUnit] = useState('q')
  const value = parseBpm(bpm)
  const chosen = UNITS.find((u) => u.id === unit) ?? UNITS[0]!
  return (
    <Sheet title="Set a practice tempo" open={open} onClose={onClose}>
      <form
        class={styles.tempoForm}
        onSubmit={(e) => {
          e.preventDefault()
          if (value !== null) onSave({ beatBpm: value, beatUnit: chosen.unit })
        }}
      >
        <p class={styles.muted}>
          This score has no metronome mark. Choose the tempo to practice and time attempts against.
        </p>
        <Field label="Beat" hint="The note value one beat lasts.">
          <select
            class={styles.select}
            value={unit}
            onChange={(e) => setUnit((e.currentTarget as HTMLSelectElement).value)}
          >
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Beats per minute" error={value === null ? 'Enter a number from 10 to 400.' : null}>
          <input
            class={styles.input}
            inputMode="decimal"
            value={bpm}
            onInput={(e) => setBpm((e.currentTarget as HTMLInputElement).value)}
          />
        </Field>
        <div class={styles.resultActions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={value === null}>
            Use this tempo
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
