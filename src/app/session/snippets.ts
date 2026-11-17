/**
 * Mistake playback in the expanded result card (DECISIONS U100): "What you played" replays the
 * learner's own key presses of one bar of the last pass, captured as they arrived; "As written"
 * plays the bar from the score at the pass's speed. Pure pieces (the capture, the two event
 * lists) and a small scheduler over an `OutputBackend`; the session decides when they may play.
 *
 * The capture is the only thing in the MIDI input path: one bounded append per key event during
 * a scored pass, nothing else (no sorting, no allocation beyond the record, nothing stored).
 */
import { buildPerformance, passageRange } from '../../core/playback'
import type { OutputBackend } from '../../core/playback/types'
import type { ScoreModel } from '../../core/model/score'
import { secondsBetween, type TempoMapData } from '../../core/music/tempo'
import type { TimerApi } from '../../core/playback/types'

/** One key event of a pass: when (performance.now() ms), which key, how hard, and where. */
export interface CapturedKey {
  readonly time: number
  readonly note: number
  /** 1..127 for a press; 0 for a release. */
  readonly velocity: number
  /** The engine group the cursor waited at when it arrived (its bar is the group's). */
  readonly group: number
}

/** Key events kept per pass (a long loop at most): beyond, a pass is not captured any further. */
export const CAPTURE_LIMIT = 4096

/**
 * The key events of the pass being played and of the last completed one. `begin` starts a pass
 * (drops what the previous unfinished one had), `add` is O(1), `finish` keeps the pass under the
 * attempt's id. Nothing is persisted; a new context (another loop, hands, speed) simply never
 * matches the kept id.
 */
export class PassCapture {
  #current: CapturedKey[] = []
  #full = false
  #last: { readonly id: string; readonly keys: readonly CapturedKey[]; readonly truncated: boolean } | null = null

  begin(): void {
    this.#current = []
    this.#full = false
  }

  /** O(1): one append while there is room. */
  add(time: number, note: number, velocity: number, group: number): void {
    if (this.#current.length >= CAPTURE_LIMIT) {
      this.#full = true
      return
    }
    this.#current.push({ time, note, velocity, group })
  }

  finish(attemptId: string): void {
    this.#last = { id: attemptId, keys: this.#current, truncated: this.#full }
    this.#current = []
    this.#full = false
  }

  /** A release after its pass ended (the last chord's keys come up later): kept on that pass. */
  release(time: number, note: number): void {
    const last = this.#last
    if (!last || last.keys.length >= CAPTURE_LIMIT) return
    ;(last.keys as CapturedKey[]).push({ time, note, velocity: 0, group: -1 })
  }

  clear(): void {
    this.#current = []
    this.#full = false
    this.#last = null
  }

  /** The completed pass `attemptId`'s key events, or null when it is not the one kept. */
  pass(attemptId: string): { readonly keys: readonly CapturedKey[]; readonly truncated: boolean } | null {
    return this.#last?.id === attemptId ? this.#last : null
  }

  get size(): number {
    return this.#current.length
  }
}

/** `played`: the learner's own presses replayed; `written`: the bar from the score. */
export type SnippetKind = 'played' | 'written'

/** A sound to make, `at` ms after the snippet starts. */
export interface SnippetNote {
  readonly at: number
  readonly note: number
  readonly velocity: number
  readonly duration: number
}

export interface Snippet {
  readonly notes: readonly SnippetNote[]
  /** Total length (ms), the last release included. */
  readonly length: number
  /** "What you played" only: a long pause was shortened to `MAX_GAP_MS`. */
  readonly shortened: boolean
}

/** A pause between presses longer than this is shortened to it in a replay (ms). */
export const MAX_GAP_MS = 1200
/** A key still held when the pass ended sounds this long in a replay (ms). */
const HELD_MS = 600

/**
 * "What you played" for the groups `groups` (one bar's): the presses that arrived while the
 * cursor waited at one of them, with their own velocities and the time until each key's release,
 * from the first such press. Pauses longer than `MAX_GAP_MS` between one press and the next are
 * shortened to it (the learner may have stopped to think: a replay of six silent seconds helps
 * nobody), and the snippet says so. Empty when nothing was captured there.
 */
export function playedSnippet(keys: readonly CapturedKey[], groups: ReadonlySet<number>): Snippet {
  const notes: SnippetNote[] = []
  const open = new Map<number, number[]>()
  const raw: { time: number; note: number; velocity: number; end: number }[] = []
  for (const k of keys) {
    if (k.velocity > 0) {
      if (!groups.has(k.group)) continue
      const entry = { time: k.time, note: k.note, velocity: k.velocity, end: Number.NaN }
      raw.push(entry)
      const list = open.get(k.note)
      if (list) list.push(raw.length - 1)
      else open.set(k.note, [raw.length - 1])
    } else {
      const list = open.get(k.note)
      const i = list?.shift()
      if (i !== undefined) raw[i]!.end = k.time
    }
  }
  if (raw.length === 0) return { notes: [], length: 0, shortened: false }
  let shift = 0
  let shortened = false
  let prev = raw[0]!.time
  for (const r of raw) {
    const gap = r.time - prev
    if (gap > MAX_GAP_MS) {
      shift += gap - MAX_GAP_MS
      shortened = true
    }
    prev = r.time
    const at = r.time - raw[0]!.time - shift
    const held = Number.isNaN(r.end) ? HELD_MS : r.end - r.time
    notes.push({ at, note: r.note, velocity: r.velocity, duration: Math.max(60, Math.min(held, MAX_GAP_MS * 2)) })
  }
  const length = Math.max(...notes.map((n) => n.at + n.duration))
  return { notes, length, shortened }
}

/**
 * "As written": bar `occ` of the score, both hands, at `multiplier` (the pass's speed), from the
 * bar's start; velocities from the score's dynamics. Pedals are left out (a pedal held after the
 * snippet would linger on the piano).
 */
export function writtenSnippet(model: ScoreModel, tempo: TempoMapData, multiplier: number, occ: number): Snippet {
  const range = passageRange(model, { fromOcc: occ, toOcc: occ })
  const events = buildPerformance(model, { hands: 'none', range, sendPedals: false })
  const ms = (e: { position: ScoreModel['totalDuration']; offsetSec: number }) =>
    (secondsBetween(tempo, range.start, e.position, multiplier) + e.offsetSec / multiplier) * 1000
  const ons = new Map<number, { at: number; note: number; velocity: number }>()
  const notes: SnippetNote[] = []
  for (const e of events) {
    if (e.kind === 'on') ons.set(e.voice, { at: ms(e), note: e.note, velocity: e.velocity })
    else if (e.kind === 'off') {
      const on = ons.get(e.voice)
      if (!on) continue
      ons.delete(e.voice)
      notes.push({ ...on, duration: Math.max(60, ms(e) - on.at) })
    }
  }
  notes.sort((a, b) => a.at - b.at || a.note - b.note)
  const length = notes.length ? Math.max(...notes.map((n) => n.at + n.duration)) : 0
  return { notes, length, shortened: false }
}

/**
 * Plays a snippet on a backend: each press and release is handed over when it is due (a timer per
 * event, so nothing is queued ahead that a stop could not take back), `onEnd` once the last
 * release has passed. `stop` releases only the notes this snippet holds down: never a global
 * cleanup, so the accompaniment or anything else on the same output is left alone.
 */
export class SnippetPlayer {
  #i = 0
  #offs: { at: number; note: number }[] = []
  #timer: ReturnType<TimerApi['setTimeout']> | null = null
  #stopped = false
  readonly #start: number

  constructor(
    readonly snippet: Snippet,
    private readonly backend: OutputBackend,
    private readonly clock: () => number,
    private readonly timers: TimerApi,
    private readonly onEnd: () => void,
  ) {
    this.#start = clock()
    this.#tick()
  }

  /** The note `note` is sounding from this snippet at `time` (or ended less than `graceMs` ago). */
  sounds(note: number, time: number, graceMs = 150): boolean {
    const t = time - this.#start
    return this.snippet.notes.some((n) => n.note === note && t >= n.at - 20 && t <= n.at + n.duration + graceMs)
  }

  get stopped(): boolean {
    return this.#stopped
  }

  #tick(): void {
    this.#timer = null
    if (this.#stopped) return
    const now = this.clock()
    const t = now - this.#start
    const notes = this.snippet.notes
    // Releases first, so a key struck again at the same instant sounds again.
    this.#offs.sort((a, b) => a.at - b.at)
    while (this.#offs.length && this.#offs[0]!.at <= t) this.backend.noteOff(this.#offs.shift()!.note, now)
    while (this.#i < notes.length && notes[this.#i]!.at <= t) {
      const n = notes[this.#i++]!
      this.backend.noteOn(n.note, n.velocity, now)
      this.#offs.push({ at: n.at + n.duration, note: n.note })
    }
    if (this.#i >= notes.length && this.#offs.length === 0) {
      this.#stopped = true
      this.onEnd()
      return
    }
    this.#offs.sort((a, b) => a.at - b.at)
    const next = Math.min(this.#i < notes.length ? notes[this.#i]!.at : Infinity, this.#offs[0]?.at ?? Infinity)
    this.#timer = this.timers.setTimeout(() => this.#tick(), Math.max(1, next - t))
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#timer !== null) this.timers.clearTimeout(this.#timer)
    this.#timer = null
    const now = this.clock()
    for (const off of this.#offs.splice(0)) this.backend.noteOff(off.note, now)
  }
}
