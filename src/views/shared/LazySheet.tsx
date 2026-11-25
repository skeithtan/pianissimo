import type { ComponentChildren, ComponentType } from 'preact'
import { msg } from '../../i18n/messages'
import { Button, Sheet } from '../../ui/controls'
import { useLazy } from './useLazy'

/** A sheet at the side whose contents load on the first opening, so that no screen carries them. */
export function LazySheet<P>({
  title,
  open,
  onClose,
  load,
  children,
}: {
  title: string
  open: boolean
  onClose: () => void
  load: () => Promise<ComponentType<P>>
  children: (Panel: ComponentType<P>) => ComponentChildren
}) {
  const { value: Panel, failed, retry } = useLazy(open, load)
  return (
    <Sheet title={title} open={open} onClose={onClose} side>
      {Panel ? (
        children(Panel)
      ) : failed ? (
        <div role="alert">
          <p>{msg('This screen could not be loaded. Check your connection and try again.')}</p>
          <Button onClick={retry}>{msg('Try again')}</Button>
        </div>
      ) : (
        <p role="status">{msg('Loading…')}</p>
      )}
    </Sheet>
  )
}
