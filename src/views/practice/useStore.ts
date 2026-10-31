import { useEffect, useRef, useState } from 'preact/hooks'
import type { ReadonlyStore } from '../../app/session'

/** Subscribe a component to a session store; it re-renders only when that store changes. */
export function useStore<T>(store: ReadonlyStore<T>): T {
  const [value, setValue] = useState<{ v: T }>(() => ({ v: store.get() }))
  useEffect(() => {
    setValue({ v: store.get() })
    return store.subscribe((v) => setValue({ v }))
  }, [store])
  return value.v
}

/**
 * Subscribe to one derived value of a store (compared with `Object.is`): the component re-renders
 * only when that value changes, e.g. the bar of `progress`, which publishes every frame while
 * playing. `select` should be stable or cheap; the latest one is used.
 */
export function useStoreValue<T, V>(store: ReadonlyStore<T>, select: (value: T) => V): V {
  const latest = useRef(select)
  latest.current = select
  const [value, setValue] = useState<V>(() => select(store.get()))
  useEffect(() => {
    setValue(latest.current(store.get()))
    return store.subscribe((v) => setValue(latest.current(v)))
  }, [store])
  return value
}
