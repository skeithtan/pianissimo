/**
 * Temporary note-name hints: lifetime in active practice time, timed-expiry fade, and
 * outgoing fades that stay attached to their original notes
 * (spec: "Mistake feedback and hints", lifetime and fade paragraphs).
 */
import { fadeOutOpacity } from './fade'

/**
 * Active practice time: real time minus ordinary-reading pauses. Hint lifetimes and every
 * label fade run on this clock, so pausing ordinary reading freezes them.
 */
export class ActiveClock {
  #pausedTotal = 0
  #pausedAt: number | null = null

  active(now: number): number {
    if (this.#pausedAt !== null) return this.#pausedAt - this.#pausedTotal
    return now - this.#pausedTotal
  }

  get paused(): boolean {
    return this.#pausedAt !== null
  }

  pause(now: number): void {
    if (this.#pausedAt === null) this.#pausedAt = now
  }

  resume(now: number): void {
    if (this.#pausedAt === null) return
    this.#pausedTotal += Math.max(0, now - this.#pausedAt)
    this.#pausedAt = null
  }

  /** Real time at which an active-time instant occurs; null while paused (it never arrives). */
  toReal(active: number): number | null {
    return this.#pausedAt === null ? active + this.#pausedTotal : null
  }
}

/** 'auto' = shown after the wrong-attack threshold; 'manual' = an explicit hint request. */
export type HintSource = 'auto' | 'manual'

export interface TemporaryHint {
  readonly group: number
  readonly notes: readonly number[]
  readonly source: HintSource
  /** Active-time expiry; null for "Until correct". */
  readonly expiresAt: number | null
  /** Timed-expiry fade length, clamped to the lifetime. */
  readonly expiryFadeMs: number
}

/** An outgoing label set fading from opacity `from` to 0, attached to its original notes. */
interface Fade {
  readonly notes: readonly number[]
  readonly start: number
  readonly durationMs: number
  readonly from: number
}

function hintOpacity(h: TemporaryHint, t: number): number {
  if (h.expiresAt === null) return 1
  return fadeOutOpacity(t - (h.expiresAt - h.expiryFadeMs), h.expiryFadeMs)
}

function fadeOpacity(f: Fade, t: number): number {
  return f.from * fadeOutOpacity(t - f.start, f.durationMs)
}

const EMPTY: ReadonlyMap<number, number> = new Map()

/** All times are active-clock milliseconds. */
export class HintState {
  #hint: TemporaryHint | null = null
  #fades: Fade[] = []

  get hint(): TemporaryHint | null {
    return this.#hint
  }

  isActive(group: number): boolean {
    return this.#hint !== null && this.#hint.group === group
  }

  /**
   * Reveal (or restart) the hint for a group. Cancels any in-progress fade of the same notes,
   * restoring full opacity (spec: a fresh manual request cancels the fade and restarts the
   * lifetime). Timed hints fade during the final `fadeMs` of the lifetime, clamped to it.
   */
  show(
    group: number,
    notes: readonly number[],
    source: HintSource,
    t: number,
    lifetimeMs: number | null,
    fadeMs: number,
  ): void {
    if (this.#fades.length > 0) this.#fades = this.#fades.filter((f) => !f.notes.some((n) => notes.includes(n)))
    this.#hint = {
      group,
      notes,
      source,
      expiresAt: lifetimeMs === null ? null : t + lifetimeMs,
      expiryFadeMs: lifetimeMs === null ? 0 : Math.max(0, Math.min(fadeMs, lifetimeMs)),
    }
  }

  /**
   * Retire the active hint (group completed or hints dismissed): its labels fade from their
   * current opacity to 0 over `fadeMs`, attached to their original notes. Returns the group.
   */
  retire(t: number, fadeMs: number): number | null {
    const h = this.#hint
    if (!h) return null
    this.#hint = null
    const from = hintOpacity(h, t)
    if (from > 0 && fadeMs > 0) this.#fades.push({ notes: h.notes, start: t, durationMs: fadeMs, from })
    return h.group
  }

  /** Expire a timed hint whose lifetime has elapsed (it is already invisible). Returns its group. */
  expire(t: number): number | null {
    const h = this.#hint
    if (!h || h.expiresAt === null || t < h.expiresAt) return null
    this.#hint = null
    return h.group
  }

  /** Drop finished fades; returns true when anything was removed. */
  prune(t: number): boolean {
    const before = this.#fades.length
    if (before === 0) return false
    this.#fades = this.#fades.filter((f) => f.start + f.durationMs > t)
    return this.#fades.length !== before
  }

  /** Active time at which the last outgoing fade finishes (−∞ when none). */
  fadingUntil(): number {
    let end = -Infinity
    for (const f of this.#fades) end = Math.max(end, f.start + f.durationMs)
    return end
  }

  /** Next active instant at which something changes by itself (expiry or fade end); null if none. */
  nextDeadline(): number | null {
    let next = this.#hint?.expiresAt ?? null
    for (const f of this.#fades) {
      const end = f.start + f.durationMs
      if (next === null || end < next) next = end
    }
    return next
  }

  /** Temporary-source opacity of one note's label (0 when it has no temporary reason to show). */
  opacity(note: number, t: number): number {
    let o = 0
    if (this.#hint && this.#hint.notes.includes(note)) o = hintOpacity(this.#hint, t)
    for (const f of this.#fades) if (f.notes.includes(note)) o = Math.max(o, fadeOpacity(f, t))
    return o
  }

  /** Notes with a visible temporary label → eased opacity in (0, 1]. */
  opacities(t: number): ReadonlyMap<number, number> {
    if (!this.#hint && this.#fades.length === 0) return EMPTY
    const out = new Map<number, number>()
    const put = (note: number, o: number): void => {
      if (o > 0 && o > (out.get(note) ?? 0)) out.set(note, o)
    }
    if (this.#hint) {
      const o = hintOpacity(this.#hint, t)
      for (const n of this.#hint.notes) put(n, o)
    }
    for (const f of this.#fades) {
      const o = fadeOpacity(f, t)
      for (const n of f.notes) put(n, o)
    }
    return out.size === 0 ? EMPTY : out
  }

  /** Remove everything immediately (no fade). */
  clear(): void {
    this.#hint = null
    this.#fades = []
  }
}
