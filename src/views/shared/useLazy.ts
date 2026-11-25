import { useEffect, useState } from 'preact/hooks'

const loaded = new Map<() => Promise<unknown>, unknown>()

/** Something loaded the first time it is wanted, and kept: `load` is a module's constant. */
export function useLazy<T>(wanted: boolean, load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(() => (loaded.get(load) as T | undefined) ?? null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!wanted || value) return
    let live = true
    setFailed(false)
    load().then(
      (next) => {
        loaded.set(load, next)
        if (live) setValue(() => next)
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [wanted, value, load, attempt])
  return { value, failed, retry: () => setAttempt((n) => n + 1) }
}
