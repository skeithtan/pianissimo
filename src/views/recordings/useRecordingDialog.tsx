import type { ComponentType } from 'preact'
import { useRef, useState, useEffect } from 'preact/hooks'
import pill from '../../ui/statusPill.module.css'
import styles from './recordingControl.module.css'
import { msg } from '../../i18n/messages'
import { pushNotice } from '../../app/state'
import type { TakeTarget } from './take'
import type { RecordingStorage } from './History'

type PanelProps = { onClose: () => void; controlsHost: HTMLElement | null }

export function useRecordingDialog() {
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null)
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null)
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const close = () => {
    generation.current++
    setPanel(null)
  }
  async function open(storage: RecordingStorage, target?: TakeTarget) {
    const request = ++generation.current
    try {
      if (target) {
        const { Recorder } = await import('./Recorder')
        if (request === generation.current)
          setPanel(() => ({ onClose, controlsHost }: PanelProps) => (
            <Recorder target={target} onClose={onClose} controlsHost={controlsHost} />
          ))
      } else {
        const { RecordingHistory } = await import('./History')
        if (request === generation.current)
          setPanel(() => ({ onClose }: { onClose: () => void }) => (
            <RecordingHistory storage={storage} onClose={onClose} />
          ))
      }
    } catch {
      pushNotice({
        kind: 'warning',
        text: msg('This screen could not be loaded. Check your connection and try again.'),
      })
    }
  }
  function controls(onOpen: () => void, inHeader = true) {
    return (
      <div class={styles.control}>
        <span class={styles.slot} ref={inHeader && Panel ? setControlsHost : null} />
        <button
          class={`${pill.pill} ${pill.action} ${styles.record}`}
          type="button"
          aria-label={msg('Record performance')}
          title={msg('Record performance')}
          aria-haspopup="dialog"
          disabled={Panel !== null}
          onClick={onOpen}
        >
          <span class={pill.dot} aria-hidden="true" />
          <span class={styles.label}>{msg('Record')}</span>
        </button>
      </div>
    )
  }
  return {
    open,
    controls,
    phoneFooter: Panel ? <footer class={styles.phoneFooter} ref={setControlsHost} /> : null,
    dialog: Panel ? <Panel onClose={close} controlsHost={controlsHost} /> : null,
    isOpen: Panel !== null,
  }
}
