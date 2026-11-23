import { msg } from '../../i18n/messages'
/**
 * Progress (U148): one panel per piece with what to work on next, the past passes and the recordings,
 * over the score or the Library. It never leaves the screen it was opened on. Its contents
 * (`ProgressPanel`) load on the first opening, so neither the Library nor the practice path carries
 * them. On tablets and desktops it stands at the end side; on a phone it fills the screen (U82).
 */
import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Button, Sheet } from '../../ui/controls'
import type { ProgressPanelProps } from './ProgressPanel'
import styles from './ProgressSheet.module.css'

let loaded: ComponentType<ProgressPanelProps> | null = null

export interface ProgressSheetProps extends ProgressPanelProps {
  readonly open: boolean
  readonly onClose: () => void
}

export function ProgressSheet({ open, onClose, ...panel }: ProgressSheetProps) {
  const [Panel, setPanel] = useState<ComponentType<ProgressPanelProps> | null>(() => loaded)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open || Panel) return
    let live = true
    setFailed(false)
    import('./ProgressPanel').then(
      (m) => {
        loaded = m.ProgressPanel
        if (live) setPanel(() => m.ProgressPanel)
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [open, Panel, attempt])
  return (
    <Sheet title={msg('Progress')} open={open} onClose={onClose} className={styles.side}>
      {Panel ? (
        <Panel {...panel} />
      ) : failed ? (
        <div role="alert">
          <p>{msg('This screen could not be loaded. Check your connection and try again.')}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{msg('Try again')}</Button>
        </div>
      ) : (
        <p role="status">{msg('Loading…')}</p>
      )}
    </Sheet>
  )
}
