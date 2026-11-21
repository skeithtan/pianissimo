import type { ComponentType } from 'preact'
import { useRef, useState, useEffect } from 'preact/hooks'
import { msg } from '../../i18n/messages'
import { pushNotice } from '../../app/state'
import type { TakeTarget } from './take'
import type { RecordingStorage } from './History'

export function useRecordingDialog() {
  const [Panel, setPanel] = useState<ComponentType<{ onClose: () => void }> | null>(null)
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
          setPanel(() => ({ onClose }: { onClose: () => void }) => <Recorder target={target} onClose={onClose} />)
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
  return { open, dialog: Panel ? <Panel onClose={close} /> : null, isOpen: Panel !== null }
}
