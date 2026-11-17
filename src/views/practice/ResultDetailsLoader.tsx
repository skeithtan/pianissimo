/**
 * The expanded result card's contents (DECISIONS U99), fetched on its first expansion: the
 * details module (`ResultDetails.tsx`) pulls in the score excerpts and the Results panels, so it
 * stays out of the practice path's bundle until the learner asks for it. While it loads, the card
 * keeps the height it will have, so it does not jump.
 */
import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { ResultDetailsProps } from './resultDetailsTypes'
import styles from './practice.module.css'

export type { ResultDetailsProps } from './resultDetailsTypes'

let loaded: ComponentType<ResultDetailsProps> | null = null
let loading: Promise<ComponentType<ResultDetailsProps>> | null = null

/** Loads the details module once; later expansions render it at once. */
export function loadResultDetails(): Promise<ComponentType<ResultDetailsProps>> {
  loading ??= import('./ResultDetails').then((m) => (loaded = m.ResultDetails))
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
    loadResultDetails().then(
      (c) => live && setDetails(() => c),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [Details])
  if (Details) return <Details {...props} />
  return (
    <div class={styles.resultDetailsLoading} role="status" data-testid="result-details-loading">
      {failed ? 'The details could not be loaded. Try again in a moment.' : 'Loading the details…'}
    </div>
  )
}
