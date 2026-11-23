import { effect } from '@preact/signals'
import { msg } from '../../i18n/messages'
import type { OccurrenceGeometry } from '../types'

/** A bar's drawn number ("12", "12 (pass 2)"), in the current language when the layout keeps its parts. */
export function barLabel(o: Pick<OccurrenceGeometry, 'label' | 'number' | 'pass'>): string {
  if (o.number === undefined) return o.label
  return (o.pass ?? 1) > 1 ? msg('{0} (pass {1})', o.number, o.pass) : o.number
}

/** Writes a bar number into `t`; a later pass is marked so `relabelBars` can translate it again. */
export function setBarLabel(t: Element, o: Pick<OccurrenceGeometry, 'label' | 'number' | 'pass'>): void {
  t.textContent = barLabel(o)
  if (o.number !== undefined && (o.pass ?? 1) > 1) {
    t.setAttribute('data-number', o.number)
    t.setAttribute('data-pass', String(o.pass))
  }
}

/** Re-translates the later-pass bar numbers under `root` (after a language change). */
export function relabelBars(root: ParentNode): void {
  for (const t of root.querySelectorAll('.pn-mnum[data-pass]')) {
    const text = barLabel({
      label: '',
      number: t.getAttribute('data-number')!,
      pass: Number(t.getAttribute('data-pass')),
    })
    if (t.textContent !== text) t.textContent = text
  }
}

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
    relabelBars(root)
  })
}
