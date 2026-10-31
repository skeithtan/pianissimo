/**
 * MIDI connection status chip, driven by the `connectionStatus` signal. A dot, a short label and
 * the text itself carry the state (color is never the only cue). Tapping it opens the Connection
 * setup modal over the current view. Used by the app bar and by the Practice header.
 */
import { connectionStatus, type ConnectionState, type ConnectionStatus } from '../../app/state'
import { openConnection } from '../../app/navigation'
import styles from './ConnectionChip.module.css'

type Tone = 'neutral' | 'busy' | 'good' | 'warn'

const TONE: Readonly<Record<ConnectionState, Tone>> = {
  unsupported: 'warn',
  denied: 'warn',
  disconnected: 'neutral',
  connecting: 'busy',
  connected: 'good',
}

/** Short chip text for a status. */
export function connectionLabel(status: ConnectionStatus): string {
  switch (status.state) {
    case 'unsupported':
      return 'No MIDI in this browser'
    case 'denied':
      return 'MIDI access blocked'
    case 'disconnected':
      return 'Piano not connected'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return status.inputName ? `Connected · ${status.inputName}` : 'Piano connected'
  }
}

export interface ConnectionChipProps {
  readonly onOpen?: () => void
  /** `'narrow'`: on phone-width screens only the dot shows (the label stays for assistive technology). */
  readonly compact?: 'narrow'
}

export function ConnectionChip({ onOpen = openConnection, compact }: ConnectionChipProps) {
  const status = connectionStatus.value
  const label = connectionLabel(status)
  return (
    <button
      type="button"
      class={compact === 'narrow' ? `${styles.chip} ${styles.narrow}` : styles.chip}
      data-tone={TONE[status.state]}
      data-state={status.state}
      title={status.detail ?? label}
      aria-label={`MIDI status: ${label}. Open connection setup`}
      onClick={onOpen}
    >
      <span class={styles.dot} aria-hidden="true" />
      <span class={styles.text}>{label}</span>
    </button>
  )
}
