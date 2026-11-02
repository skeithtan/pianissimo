/**
 * Hints (spec "Mistake feedback and hints"): when names appear automatically (1, 2, 3, a custom
 * positive number of wrong attacks, or off), how long a temporary hint lasts (10 / 20 / 30 /
 * 60 s, custom or until the group is correct), how long hidden labels take to fade out, and
 * whether a wrong note flashes the screen edges red (DECISIONS S5). Changes apply immediately;
 * they never interrupt practice.
 */
import { useState } from 'preact/hooks'
import { settings, updateSettings } from '../../app/state'
import { Segmented, Slider, Toggle } from '../../ui/controls'
import { Group, Help, Setting } from './parts'
import { MIN_HINT_LIFETIME_SECONDS, parsePositive } from './numbers'
import styles from './settings.module.css'

type ThresholdChoice = '1' | '2' | '3' | 'custom' | 'off'
type LifetimeChoice = '10' | '20' | '30' | '60' | 'custom' | 'until-correct'

const PRESET_THRESHOLDS = [1, 2, 3]
const PRESET_LIFETIMES = [10, 20, 30, 60]

function thresholdChoice(value: number | null, forceCustom: boolean): ThresholdChoice {
  if (value === null) return 'off'
  if (!forceCustom && PRESET_THRESHOLDS.includes(value)) return String(value) as ThresholdChoice
  return 'custom'
}

function lifetimeChoice(value: number | 'until-correct', forceCustom: boolean): LifetimeChoice {
  if (value === 'until-correct') return 'until-correct'
  if (!forceCustom && PRESET_LIFETIMES.includes(value)) return String(value) as LifetimeChoice
  return 'custom'
}

/** A number field that applies each valid entry at once and explains an invalid one. */
function CustomNumber({
  label,
  unit,
  initial,
  integer,
  min,
  max,
  what,
  onValid,
}: {
  label: string
  unit: string
  initial: number | null
  integer: boolean
  min?: number
  max: number
  what: string
  onValid: (value: number) => void
}) {
  const [text, setText] = useState(initial === null ? '' : String(initial))
  const [error, setError] = useState<string | null>(null)
  return (
    <div class={styles.custom}>
      <div class={styles.customRow}>
        <input
          class={styles.number}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          autoComplete="off"
          aria-label={label}
          aria-invalid={error ? true : undefined}
          value={text}
          onInput={(event) => {
            const next = (event.currentTarget as HTMLInputElement).value
            setText(next)
            const result = parsePositive(next, { integer, ...(min !== undefined ? { min } : {}), max, what })
            if (result.ok) {
              setError(null)
              onValid(result.value)
            } else {
              setError(result.error)
            }
          }}
        />
        <span class={styles.unit}>{unit}</span>
      </div>
      {error ? (
        <p class={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function HintsSection() {
  const hints = settings.value.hints
  const [customThreshold, setCustomThreshold] = useState(false)
  const [customLifetime, setCustomLifetime] = useState(false)
  const threshold = thresholdChoice(hints.autoThreshold, customThreshold)
  const lifetime = lifetimeChoice(hints.lifetime, customLifetime)

  return (
    <>
      <Group>
        <Setting
          label="Show note names automatically"
          description="After this many wrong attacks at the same notes. Your configured hint pedal remains available when automatic hints are off."
        >
          <Segmented
            label="Show note names automatically"
            value={threshold}
            options={[
              { value: '1', label: '1 mistake' },
              { value: '2', label: '2 mistakes' },
              { value: '3', label: '3 mistakes' },
              { value: 'custom', label: 'Custom' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(choice) => {
              setCustomThreshold(choice === 'custom')
              if (choice === 'off') updateSettings({ hints: { autoThreshold: null } })
              else if (choice !== 'custom') updateSettings({ hints: { autoThreshold: Number(choice) } })
              else if (hints.autoThreshold === null) updateSettings({ hints: { autoThreshold: 4 } })
            }}
          />
          {threshold === 'custom' ? (
            <CustomNumber
              label="Custom number of wrong attacks"
              unit="wrong attacks"
              initial={hints.autoThreshold}
              integer
              max={99}
              what="a number of wrong attacks"
              onValid={(autoThreshold) => updateSettings({ hints: { autoThreshold } })}
            />
          ) : null}
        </Setting>
      </Group>

      <Group>
        <Setting
          label="Hint lifetime"
          description="How long names stay after they appear, counted in active practice time. Pausing freezes the timer."
        >
          <Segmented
            label="Hint lifetime"
            value={lifetime}
            options={[
              { value: '10', label: '10 s' },
              { value: '20', label: '20 s' },
              { value: '30', label: '30 s' },
              { value: '60', label: '60 s' },
              { value: 'custom', label: 'Custom' },
              { value: 'until-correct', label: 'Until correct' },
            ]}
            onChange={(choice) => {
              setCustomLifetime(choice === 'custom')
              if (choice === 'until-correct') updateSettings({ hints: { lifetime: 'until-correct' } })
              else if (choice !== 'custom') updateSettings({ hints: { lifetime: Number(choice) } })
              else if (hints.lifetime === 'until-correct') updateSettings({ hints: { lifetime: 45 } })
            }}
          />
          {lifetime === 'custom' ? (
            <CustomNumber
              label="Custom hint lifetime in seconds"
              unit="seconds"
              initial={typeof hints.lifetime === 'number' ? hints.lifetime : null}
              integer={false}
              min={MIN_HINT_LIFETIME_SECONDS}
              max={3600}
              what="a number of seconds"
              onValid={(seconds) => updateSettings({ hints: { lifetime: seconds } })}
            />
          ) : null}
        </Setting>
      </Group>

      <Group>
        <Slider
          label="Fade-out duration"
          min={100}
          max={1000}
          step={50}
          value={Math.min(1000, Math.max(100, hints.fadeMs))}
          format={(v) => `${v} ms`}
          onChange={(fadeMs) => updateSettings({ hints: { fadeMs } })}
        />
        <Help>
          Names fade out smoothly instead of disappearing. The default is 300 ms. It is shortened if the hint lifetime
          is shorter.
        </Help>
      </Group>

      <Group>
        <Toggle
          label="Red flash on a wrong note"
          description="Flash the screen edges red when you play a wrong note. The red cursor tint and hints stay on."
          checked={hints.damageFlash}
          onChange={(damageFlash) => updateSettings({ hints: { damageFlash } })}
        />
      </Group>
    </>
  )
}
