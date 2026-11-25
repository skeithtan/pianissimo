import { msg } from '../../i18n/messages'
/**
 * Progress (U148): one panel per piece with what to work on next and the past passes, over the score or
 * the Library. It never leaves the screen it was opened on. Its contents (`ProgressPanel`) load on the
 * first opening, so neither the Library nor the practice path carries them. On tablets and desktops it
 * stands at the end side; on a phone it fills the screen (U82).
 */
import { LazySheet } from '../shared/LazySheet'
import type { ProgressPanelProps } from './ProgressPanel'

const loadPanel = () => import('./ProgressPanel').then((m) => m.ProgressPanel)

export interface ProgressSheetProps extends ProgressPanelProps {
  readonly open: boolean
  readonly onClose: () => void
}

export function ProgressSheet({ open, onClose, ...panel }: ProgressSheetProps) {
  return (
    <LazySheet title={msg('Progress')} open={open} onClose={onClose} load={loadPanel}>
      {(Panel) => <Panel {...panel} />}
    </LazySheet>
  )
}
