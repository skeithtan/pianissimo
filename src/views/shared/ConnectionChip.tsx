import { msg } from '../../i18n/messages'
/**
 * MIDI connection status chip, driven by the `connectionStatus` signal. A dot, a short label and
 * the text itself carry the state (color is never the only cue). Tapping it opens Settings on Piano
 * and sound over the current view. Used by the app bar and by the Practice header.
 */
import { connectionStatus, type ConnectionState, type ConnectionStatus } from '../../app/state'
import { getFeatures } from '../../app/features'
import { openConnection } from '../../app/navigation'
import { isSafari } from '../../app/pianoBrowsers'
import pill from '../../ui/statusPill.module.css'
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
      return isSafari() ? msg('No MIDI in Safari') : msg('No MIDI in this browser')
    case 'denied':
      return msg('MIDI access blocked')
    case 'disconnected':
      return msg('Piano not connected')
    case 'connecting':
      return msg('Connecting…')
    case 'connected':
      return status.inputName ? msg('Connected · {0}', status.inputName) : msg('Piano connected')
  }
}

export interface ConnectionChipProps {
  readonly onOpen?: () => void
  /** Only the dot shows (the label stays for assistive technology): the header has no room for words. */
  readonly dot?: boolean
  /** On the score screen's header: no pill around it (U154). */
  readonly plain?: boolean
}

export function ConnectionChip({ onOpen = openConnection, dot = false, plain = false }: ConnectionChipProps) {
  const status = connectionStatus.value
  const label = connectionLabel(status)
  return (
    <button
      type="button"
      class={`${pill.pill} ${pill.action} ${styles.chip}`}
      data-tone={TONE[status.state]}
      data-state={status.state}
      data-dot={dot || undefined}
      data-plain={plain || undefined}
      title={
        status.state === 'unsupported'
          ? (getFeatures().features.webMidi.explanation ?? label)
          : msg(status.detail ?? label)
      }
      aria-label={msg('MIDI status: {0}. Open Piano and sound', label)}
      onClick={onOpen}
    >
      <span class={pill.dot} data-status-dot aria-hidden="true" />
      <span class={styles.text}>{label}</span>
    </button>
  )
}
