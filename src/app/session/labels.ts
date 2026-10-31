/**
 * Persistent score labels for the practice strip (spec "Persistent score labels", "Mistake
 * feedback and hints" fade paragraph, DECISIONS U3, R3).
 *
 * - Texts: one formatted name per performed note (core/naming `labelFor`), recomputed only when
 *   the naming preferences change. The strip creates text nodes only while a label is visible.
 * - Eligibility: `isPersistentLabelVisible` per note (resolved sounding MIDI, governing clef).
 * - Fades: notes leaving eligibility fade out over `fadeMs` (smoothstep, from their current
 *   opacity); newly eligible notes fade in. While nothing fades, `opacity()` returns the same
 *   map object, so the per-frame merge with temporary hints costs nothing.
 *
 * Pure apart from the injected `now`; no DOM.
 */
import { fadeOutOpacity } from '../../core/engine/fade'
import type { LabelSettingsSnapshot } from '../../core/model/practice'
import type { PerformedNote } from '../../core/model/score'
import type { NamingSettings, PersistentLabelSettings } from '../../core/model/settings'
import { isPersistentLabelVisible, labelFor } from '../../core/naming'

type LabelNote = Pick<PerformedNote, 'index' | 'midi' | 'clef' | 'sounding' | 'ottavaShift' | 'accidentalContext'>

interface Fade {
  readonly start: number
  readonly from: number
  readonly to: 0 | 1
}

const EMPTY: ReadonlyMap<number, number> = new Map()

/**
 * The engine's record of the label settings in force (assistance details). `rulesJson` is the
 * plain `{ [clef]: ClefLabelRule }` map, which the Results view parses.
 */
export function labelSnapshot(labels: PersistentLabelSettings): LabelSettingsSnapshot {
  return { mode: labels.mode, rulesJson: JSON.stringify(labels.rules) }
}

export class PersistentLabels {
  readonly #notes: readonly LabelNote[]
  #texts: Map<number, string> = new Map()
  #eligible: Uint8Array
  #count = 0
  #base: Map<number, number> = new Map()
  readonly #fades = new Map<number, Fade>()
  #fadeMs: number
  #current: ReadonlyMap<number, number> = EMPTY
  #dirty = true

  constructor(notes: readonly LabelNote[], labels: PersistentLabelSettings, naming: NamingSettings, fadeMs: number) {
    this.#notes = notes
    this.#eligible = new Uint8Array(notes.length)
    this.#fadeMs = fadeMs
    this.setNaming(naming)
    for (const n of notes) {
      if (isPersistentLabelVisible({ midi: n.midi, clef: n.clef }, labels)) {
        this.#eligible[n.index] = 1
        this.#count++
      }
    }
    this.#rebuildBase()
  }

  /** Note index → label text for every note (persistent or temporary display). */
  get texts(): ReadonlyMap<number, string> {
    return this.#texts
  }

  /** Number of notes currently eligible for a persistent label. */
  get eligibleCount(): number {
    return this.#count
  }

  isEligible(note: number): boolean {
    return this.#eligible[note] === 1
  }

  /** Recomputes texts. Returns true when any text changed. */
  setNaming(naming: NamingSettings): boolean {
    const next = new Map<number, string>()
    let changed = this.#texts.size !== this.#notes.length
    for (const n of this.#notes) {
      const text = labelFor(n, naming).text
      next.set(n.index, text)
      if (!changed && this.#texts.get(n.index) !== text) changed = true
    }
    this.#texts = next
    return changed
  }

  setFadeMs(ms: number): void {
    this.#fadeMs = Math.max(0, ms)
  }

  /** New mode or rules: leaving notes fade out, entering notes fade in. Returns true on change. */
  setLabels(labels: PersistentLabelSettings, now: number): boolean {
    let changed = false
    for (const n of this.#notes) {
      const next = isPersistentLabelVisible({ midi: n.midi, clef: n.clef }, labels) ? 1 : 0
      if (next === this.#eligible[n.index]) continue
      changed = true
      const from = this.#valueAt(n.index, now)
      this.#eligible[n.index] = next
      this.#count += next ? 1 : -1
      this.#fades.set(n.index, { start: now, from, to: next })
    }
    if (changed) {
      this.#rebuildBase()
      this.#dirty = true
    }
    return changed
  }

  /** Real time when every persistent fade has finished (−Infinity when none runs). */
  fadingUntil(): number {
    let end = -Infinity
    for (const f of this.#fades.values()) end = Math.max(end, f.start + this.#fadeMs)
    return end
  }

  get fading(): boolean {
    return this.#fades.size > 0
  }

  /**
   * Persistent opacity per note at `now` (1 for steady eligible notes, eased values while
   * fading, absent = 0). The same object is returned until something changes.
   */
  opacity(now: number): ReadonlyMap<number, number> {
    if (this.#fades.size === 0) {
      if (this.#dirty) {
        this.#current = this.#base
        this.#dirty = false
      }
      return this.#current
    }
    const out = new Map(this.#base)
    for (const [note, f] of this.#fades) {
      const v = this.#fadeValue(f, now)
      const done = now - f.start >= this.#fadeMs
      if (done) {
        this.#fades.delete(note)
        if (f.to === 1) out.set(note, 1)
        else out.delete(note)
      } else if (v > 0) {
        out.set(note, v)
      } else {
        out.delete(note)
      }
    }
    this.#current = out
    this.#dirty = this.#fades.size === 0
    if (this.#dirty) this.#current = this.#base
    return this.#current
  }

  #valueAt(note: number, now: number): number {
    const f = this.#fades.get(note)
    if (f) return this.#fadeValue(f, now)
    return this.#eligible[note] ? 1 : 0
  }

  #fadeValue(f: Fade, now: number): number {
    const p = 1 - fadeOutOpacity(now - f.start, this.#fadeMs)
    return f.from + (f.to - f.from) * p
  }

  #rebuildBase(): void {
    const base = new Map<number, number>()
    for (const n of this.#notes) if (this.#eligible[n.index]) base.set(n.index, 1)
    for (const [note, f] of this.#fades) if (f.to === 0) base.delete(note)
    this.#base = base
  }
}

/**
 * Combine persistent and temporary label opacity by maximum (one label per note; spec "show
 * one label per note when both sources of visibility apply"). Returns `persistent` itself when
 * there is no temporary label.
 */
export function mergeOpacity(
  persistent: ReadonlyMap<number, number>,
  temporary: ReadonlyMap<number, number>,
): ReadonlyMap<number, number> {
  if (temporary.size === 0) return persistent
  const out = new Map(persistent)
  for (const [n, v] of temporary) if (v > (out.get(n) ?? 0)) out.set(n, v)
  return out
}

/** Same keys and values (temporary maps are small; persistent ones are compared by identity first). */
export function sameOpacity(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}
