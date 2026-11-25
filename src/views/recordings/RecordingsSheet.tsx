import { msg } from '../../i18n/messages'
/**
 * A piece's recordings (U164), over the score or the Library, like Progress and apart from it. The list
 * (`History`) loads on the first opening.
 */
import { LazySheet } from '../shared/LazySheet'
import type { RecordingListProps } from './History'

const loadList = () => import('./History').then((m) => m.RecordingList)

export interface RecordingsSheetProps extends RecordingListProps {
  readonly open: boolean
  readonly onClose: () => void
}

export function RecordingsSheet({ open, onClose, ...list }: RecordingsSheetProps) {
  return (
    <LazySheet title={msg('Recordings')} open={open} onClose={onClose} load={loadList}>
      {(List) => <List {...list} />}
    </LazySheet>
  )
}
