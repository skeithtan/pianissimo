/**
 * What the pill shows of its card (U142): the card's first things below its actions, cut off partway,
 * so the pill reads as the top of something larger. A pass that was not clean peeks at the first place
 * to correct, any other at its facts. Text and shell are there with the pill; the excerpt is drawn once
 * the learner rests (`idle`), from the prepared layout, by the details module, which is fetched then
 * and not with Practice. It never changes the pill's size (the CSS clips it at a fixed height).
 */
import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { AttemptSummary } from '../../app/session'
import { msg, messageLanguage } from '../../i18n/messages'
import type { PeekDrawing } from './ResultDetails'
import { loadDetailsModule } from './ResultDetailsLoader'
import { cleanText, passFacts } from './format'
import type { ResultDetailsProps } from './resultDetailsTypes'
import styles from './practice.module.css'

/** After the result shows: past the review's zoom out and the pill's own intro (ms). */
export const PEEK_DELAY_MS = 1000
/** Where `requestIdleCallback` is missing, the drawing is a task of its own this long after (ms). */
const PEEK_TASK_MS = 50

function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: 2000 })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(run, PEEK_TASK_MS)
  return () => clearTimeout(handle)
}

/**
 * The facts of a pass, as the card lists them first. `marked`: it has marks, so nothing says it has none,
 * and under the facts comes the top of the first one's card, empty: a run has only one fact.
 */
export function PeekFacts({ result, goal, marked }: { result: AttemptSummary; goal: number | null; marked: boolean }) {
  const clean = result.timing || marked ? null : cleanText(result)
  return (
    <>
      {clean ? <p class={styles.peekClean}>{clean}</p> : null}
      <p class={styles.peekHeading}>{msg('This pass')}</p>
      <ul class={styles.peekFacts}>
        {passFacts(result, goal).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {marked ? <div class={styles.peekMistake} /> : null}
    </>
  )
}

interface Drawn {
  readonly id: string
  readonly language: string
  readonly layout: ResultDetailsProps['layout']
  /** Null: the pass has no excerpt to show (or it could not be drawn). */
  readonly drawing: PeekDrawing | null
  readonly View: ComponentType<{ drawing: PeekDrawing }> | null
}

export interface ResultPeekProps extends ResultDetailsProps {
  /** The pass has correction marks. */
  readonly marked: boolean
  /** Nothing is being played: the excerpt may be drawn. */
  readonly idle: boolean
}

export function ResultPeek(p: ResultPeekProps) {
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  const language = messageLanguage()
  const { id, passed } = p.result
  // A clean pass can have marks (a hesitation): its card, and so its peek, has the facts first.
  const excerpt = p.marked && !passed
  const current = drawn?.id === id && drawn.language === language ? drawn : null
  const fresh = current !== null && current.layout === p.layout
  useEffect(() => {
    if (!excerpt || !p.idle || fresh || !p.layout) return
    let live = true
    let cancel = () => undefined as void
    const done = (drawing: PeekDrawing | null, View: Drawn['View']) => {
      if (live) setDrawn({ id, language, layout: p.layout, drawing, View })
    }
    const timer = setTimeout(() => {
      cancel = whenIdle(() => {
        void loadDetailsModule().then(
          (m) => {
            if (!live) return
            cancel = whenIdle(() => {
              if (live) done(m.drawPeek(p), m.PeekExcerpt)
            })
          },
          () => done(null, null),
        )
      })
    }, PEEK_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
      cancel()
    }
  }, [id, language, p.layout, excerpt, p.idle, fresh])
  if (!excerpt || (current && !current.drawing)) return <PeekFacts result={p.result} goal={p.goal} marked={p.marked} />
  const View = current?.View
  return (
    <div class={styles.peekMistake} data-keeps={current?.drawing?.keeps || undefined} data-testid="result-peek-mistake">
      {View && current?.drawing ? <View drawing={current.drawing} /> : null}
    </div>
  )
}
