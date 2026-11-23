import { msg } from '../../i18n/messages'
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
          {down ? msg('Down') : msg('Up')} <span class={styles.meterValue}>{value}</span>
        </span>
      </div>
      <div
        class={styles.meterTrack}
        role="meter"
        aria-label={msg('{0} value', label)}
        aria-valuemin={0}
        aria-valuemax={127}
        aria-valuenow={value}
        aria-valuetext={down ? msg('{0}, down', value) : msg('{0}, up', value)}
      >
        <div class={styles.meterFill} style={{ transform: `scaleX(${value / 127})` }} />
        <div
          class={styles.meterThreshold}
          style={{ left: `${(threshold / 127) * 100}%` }}
          title={msg('Threshold {0}', threshold)}
        />
      </div>
      <div class={styles.meterFoot}>
        <span>
          {msg('Threshold')} {threshold}
          {thresholdNote ? ` (${thresholdNote})` : ''}
          {inverted ? msg(', inverted') : ''}
        </span>
        {children}
      </div>
    </div>
  )
}
