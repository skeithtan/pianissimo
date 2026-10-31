import { FLAG_MIN_COMPLETE, FLAG_MIN_ERROR_PASSES, FLAG_MIN_ERROR_PERCENT } from './types'
import type { BarRecord } from './types'

/** A bar's rolling-window evidence: complete traversals only. */
export interface BarEvidence {
  /** Complete traversals in the window (at most five). */
  readonly complete: number
  /** How many of them contained a wrong-note attack (each counted once). */
  readonly errors: number
  /** Timestamp of the most recent error-bearing traversal, 0 when none. */
  readonly lastErrorAt: number
}

export function barEvidence(bar: BarRecord | undefined): BarEvidence {
  if (!bar) return { complete: 0, errors: 0, lastErrorAt: 0 }
  let errors = 0
  let lastErrorAt = 0
  for (const s of bar.recent) {
    if (!s.errorBearing) continue
    errors += 1
    if (s.at > lastErrorAt) lastErrorAt = s.at
  }
  return { complete: bar.recent.length, errors, lastErrorAt }
}

/**
 * Spec flag rule (proposed default): at least three complete traversals, at least three
 * of them containing a wrong attack, and at least 60% of the available traversals
 * containing mistakes. 3 of 5 qualifies; one pass with many wrong notes does not, because
 * each traversal counts once.
 */
export function meetsFlagRule(e: BarEvidence): boolean {
  return (
    e.complete >= FLAG_MIN_COMPLETE &&
    e.errors >= FLAG_MIN_ERROR_PASSES &&
    e.errors * 100 >= FLAG_MIN_ERROR_PERCENT * e.complete
  )
}

/** Orders evidence by recent proportion of error passes, then evidence count, then recency. */
export function compareEvidence(a: BarEvidence, b: BarEvidence): number {
  const proportion = b.errors * a.complete - a.errors * b.complete
  if (proportion !== 0) return proportion
  if (a.complete !== b.complete) return b.complete - a.complete
  return b.lastErrorAt - a.lastErrorAt
}
