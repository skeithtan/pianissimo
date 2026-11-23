import { msg } from '../../i18n/messages'
/**
 * The expanded result card's contents (DECISIONS U99), fetched on its first expansion: the
 * details module (`ResultDetails.tsx`) pulls in the score excerpts and the Results panels, so it
 * stays out of the practice path's bundle until the learner asks for it. While it loads, the card
 * keeps the height it will have, so it does not jump, and shows the verdict and the actions (U142),
 * which need nothing that loads.
 */
import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { verdict } from './format'
import type { ResultDetailsProps } from './resultDetailsTypes'
import styles from './practice.module.css'

export type { ResultDetailsProps } from './resultDetailsTypes'

type DetailsModule = typeof import('./ResultDetails')

let loaded: ComponentType<ResultDetailsProps> | null = null
let loading: Promise<DetailsModule> | null = null

/** Loads the details module once (the pill's peek, at rest, or the first expansion). */
export function loadDetailsModule(): Promise<DetailsModule> {
  loading ??= import('./ResultDetails').then((m) => {
    loaded = m.ResultDetails
    return m
  })
  loading.catch(() => {
    // A failed fetch (offline before the chunk was cached) is tried again on the next expansion.
    loading = null
  })
  return loading
}

export function ResultDetailsLoader(props: ResultDetailsProps) {
  const [Details, setDetails] = useState<ComponentType<ResultDetailsProps> | null>(() => loaded)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (Details) return
    let live = true
    loadDetailsModule().then(
      (m) => live && setDetails(() => m.ResultDetails),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [Details])
  if (Details) return <Details {...props} />
  return (
    <div class={styles.resultDetailsLoading} data-testid="result-details-loading">
      <p class={styles.resultLoadingVerdict}>{verdict(props.result)}</p>
      {props.actions}
      <p role="status">
        {failed ? msg('The details could not be loaded. Try again in a moment.') : msg('Loading the details…')}
      </p>
    </div>
  )
}
