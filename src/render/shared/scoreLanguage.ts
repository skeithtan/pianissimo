import { effect } from '@preact/signals'
import { msg } from '../../i18n/messages'

/** Keep the mounted engraving and its keyboard controls in step with the interface language. */
export function bindScoreLanguage(
  root: HTMLElement,
  options: {
    readonly cursorLabel?: string
    readonly cursorActionLabel?: string
    readonly returnLabel?: string
  },
): () => void {
  const grip = root.querySelector('.pn-cursor-grip')
  const repeat = root.querySelector('.pn-cursor-action')
  const start = root.querySelector('.pn-handle-start')
  const end = root.querySelector('.pn-handle-end')
  const clear = root.querySelector('.pn-loop-clear')
  const back = root.querySelector('.pn-return span')
  return effect(() => {
    root.setAttribute('aria-label', msg('Score'))
    grip?.setAttribute('aria-label', options.cursorLabel ?? msg('Playhead: drag or use arrow keys'))
    repeat?.setAttribute('aria-label', options.cursorActionLabel ?? msg('Repeat from here'))
    start?.setAttribute('aria-label', msg('Passage start: drag or use arrow keys'))
    end?.setAttribute('aria-label', msg('Passage end: drag or use arrow keys'))
    clear?.setAttribute('aria-label', msg('Clear passage selection'))
    if (back) back.textContent = options.returnLabel ?? msg('Return to current position')
  })
}
