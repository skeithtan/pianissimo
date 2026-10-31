/**
 * A tiny observable value (no framework). The session publishes its coarse UI state through
 * these so the Practice view re-renders only when something it shows changed — never once per
 * MIDI event (spec "Execution and rendering architecture").
 */
export interface ReadonlyStore<T> {
  get(): T
  subscribe(fn: (value: T) => void): () => void
}

export class Store<T> implements ReadonlyStore<T> {
  #value: T
  readonly #listeners = new Set<(value: T) => void>()
  readonly #equal: (a: T, b: T) => boolean
  /** Number of published changes (tests: renders per MIDI event). */
  emissions = 0

  constructor(initial: T, equal: (a: T, b: T) => boolean = Object.is) {
    this.#value = initial
    this.#equal = equal
  }

  get(): T {
    return this.#value
  }

  /** Publishes `next` unless it equals the current value. Returns true when it changed. */
  set(next: T): boolean {
    if (this.#equal(this.#value, next)) return false
    this.#value = next
    this.emissions++
    for (const fn of [...this.#listeners]) fn(next)
    return true
  }

  update(patch: Partial<T>): boolean {
    return this.set({ ...this.#value, ...patch })
  }

  subscribe(fn: (value: T) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }
}

/** Shallow equality of two plain objects (arrays compared by element identity). */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  const ka = Object.keys(a) as (keyof T)[]
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const x = a[k]
    const y = b[k]
    if (Object.is(x, y)) continue
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => Object.is(v, y[i]))) continue
    return false
  }
  return true
}
