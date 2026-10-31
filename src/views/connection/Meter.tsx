/**
 * A pedal value meter: continuous value 0–127, the on/off threshold as a marker, and the state
 * as text ("Down 127" / "Up 0") so it never relies on color.
 */
import type { ComponentChildren } from 'preact'
import styles from './connection.module.css'

export function PedalMeter({
  label,
  value,
  threshold,
  inverted = false,
  thresholdNote,
  children,
}: {
  label: string
  value: number
  threshold: number
  inverted?: boolean
  /** "learned" or "conventional", shown next to the threshold. */
  thresholdNote?: string
  children?: ComponentChildren
}) {
  const down = inverted ? value < threshold : value >= threshold
  return (
    <div class={styles.meter} data-down={down ? '' : undefined}>
      <div class={styles.meterHead}>
        <span class={styles.meterLabel}>{label}</span>
        <span class={styles.meterState}>
          {down ? 'Down' : 'Up'} <span class={styles.meterValue}>{value}</span>
        </span>
      </div>
      <div
        class={styles.meterTrack}
        role="meter"
        aria-label={`${label} value`}
        aria-valuemin={0}
        aria-valuemax={127}
        aria-valuenow={value}
        aria-valuetext={`${value}, ${down ? 'down' : 'up'}`}
      >
        <div class={styles.meterFill} style={{ transform: `scaleX(${value / 127})` }} />
        <div
          class={styles.meterThreshold}
          style={{ left: `${(threshold / 127) * 100}%` }}
          title={`Threshold ${threshold}`}
        />
      </div>
      <div class={styles.meterFoot}>
        <span>
          Threshold {threshold}
          {thresholdNote ? ` (${thresholdNote})` : ''}
          {inverted ? ', inverted' : ''}
        </span>
        {children}
      </div>
    </div>
  )
}
