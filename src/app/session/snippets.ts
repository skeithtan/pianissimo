/**
 * Mistake playback in the expanded result card (DECISIONS U100): "What you played" replays the
 * learner's own key presses and pedals of one bar of the last pass, captured as they arrived;
 * "As written" plays the bar from the score, its pedal marks included, at the pass's speed
 * (U101). Pure pieces (the capture, the two event lists) and a small scheduler over an
 * `OutputBackend`; the session decides when they may play.
 *
 * The capture is the only thing in the MIDI input path: one bounded append per key or pedal event
 * during a scored pass, nothing else (no sorting, no allocation beyond the record, nothing stored).
 */
import { CC_SOFT, CC_SOSTENUTO, CC_SUSTAIN } from '../../core/midi/types'
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

/** One pedal event of a pass: when (performance.now() ms), which controller, its value (0..127). */
export interface CapturedPedal {
  readonly time: number
  readonly controller: number
  readonly value: number
}

/** The pedals a replay keeps: sustain, sostenuto and soft (never the hint pedal, the session's filter). */
export const SNIPPET_PEDALS: readonly number[] = [CC_SUSTAIN, CC_SOSTENUTO, CC_SOFT]

/** Key events (and, apart, pedal events) kept per pass (a long loop at most): beyond, not captured. */
export const CAPTURE_LIMIT = 4096

interface KeptPass {
  readonly id: string
  readonly keys: readonly CapturedKey[]
  readonly pedals: readonly CapturedPedal[]
  readonly truncated: boolean
}

/**
 * The key and pedal events of the pass being played and of the last completed one. `begin` starts
 * a pass (drops what the previous unfinished one had; a pedal already down is put at its start),
 * `add` and `pedal` are O(1), `finish` keeps the pass under the attempt's id. Nothing is persisted;
 * a new context (another loop, hands, speed) simply never matches the kept id.
 */
export class PassCapture {
  #current: CapturedKey[] = []
  #currentPedals: CapturedPedal[] = []
  #full = false
  #inPass = false
  /** Every pedal's latest value, whatever the phase, so a pass can start with a pedal down. */
  readonly #pedalNow = new Map<number, number>()
  #last: KeptPass | null = null

  begin(time: number): void {
    this.#current = []
    this.#currentPedals = []
    this.#full = false
    this.#inPass = true
    for (const [controller, value] of this.#pedalNow)
      if (value > 0) this.#currentPedals.push({ time, controller, value })
  }

  /** O(1): one append while there is room. */
  add(time: number, note: number, velocity: number, group: number): void {
    if (this.#current.length >= CAPTURE_LIMIT) {
      this.#full = true
      return
    }
    this.#current.push({ time, note, velocity, group })
  }

  /**
   * O(1): a pedal moved. Kept on the pass being played, or, between passes, on the last completed
   * one (the pedal lifted after its last chord); `record` false only follows the pedal's value.
   */
  pedal(time: number, controller: number, value: number, record = true): void {
    this.#pedalNow.set(controller, value)
    if (!record) return
    if (this.#inPass) {
      if (this.#currentPedals.length >= CAPTURE_LIMIT) this.#full = true
      else this.#currentPedals.push({ time, controller, value })
      return
    }
    const last = this.#last
    if (last && last.pedals.length < CAPTURE_LIMIT) (last.pedals as CapturedPedal[]).push({ time, controller, value })
  }

  finish(attemptId: string): void {
    this.#last = { id: attemptId, keys: this.#current, pedals: this.#currentPedals, truncated: this.#full }
    this.#current = []
    this.#currentPedals = []
    this.#full = false
    this.#inPass = false
  }

  /** A release after its pass ended (the last chord's keys come up later): kept on that pass. */
  release(time: number, note: number): void {
    const last = this.#last
    if (!last || last.keys.length >= CAPTURE_LIMIT) return
    ;(last.keys as CapturedKey[]).push({ time, note, velocity: 0, group: -1 })
  }

  clear(): void {
    this.#current = []
    this.#currentPedals = []
    this.#full = false
    this.#inPass = false
    this.#pedalNow.clear()
    this.#last = null
  }

  /** The completed pass `attemptId`'s key and pedal events, or null when it is not the one kept. */
  pass(attemptId: string): KeptPass | null {
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

/** A pedal to move, `at` ms after the snippet starts. Every pedal a snippet presses it lets up again. */
export interface SnippetPedal {
  readonly at: number
  readonly controller: number
  readonly value: number
}

export interface Snippet {
  readonly notes: readonly SnippetNote[]
  /** In time order (at one instant, ups before downs); the last event of each controller is 0. */
  readonly pedals: readonly SnippetPedal[]
  /** Total length (ms), the last release (of a key or a pedal) included. */
  readonly length: number
  /** "What you played" only: a long pause was shortened to `MAX_GAP_MS`. */
  readonly shortened: boolean
}

/** A pause between presses longer than this is shortened to it in a replay (ms). */
export const MAX_GAP_MS = 1200
/** A key still held when the pass ended sounds this long in a replay (ms). */
const HELD_MS = 600
/**
 * A pedal still down when the bar's last key sound ends rings on until the learner lifted it, at
 * most this much longer (ms); then the replay lets it up.
 */
export const PEDAL_TAIL_MS = MAX_GAP_MS
/** At or above this a pedal value is down (the conventional MIDI boundary). */
const PEDAL_DOWN = 64

/**
 * "What you played" for the groups `groups` (one bar's): the presses that arrived while the
 * cursor waited at one of them, with their own velocities and the time until each key's release,
 * from the first such press. Pauses longer than `MAX_GAP_MS` between one press and the next are
 * shortened to it (the learner may have stopped to think: a replay of six silent seconds helps
 * nobody), and the snippet says so. Empty when nothing was captured there.
 *
 * The learner's pedals come with it (U101): the pedals down at the first press go down at the
 * start, every pedal move until the last key sound ends follows on the same shortened clock, and a
 * pedal still down then rings on until the learner lifted it (at most `PEDAL_TAIL_MS`); every
 * pedal ends up.
 */
export function playedSnippet(
  keys: readonly CapturedKey[],
  groups: ReadonlySet<number>,
  pedals: readonly CapturedPedal[] = [],
): Snippet {
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
  if (raw.length === 0) return { notes: [], pedals: [], length: 0, shortened: false }
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
  // A capture time on the replay's clock: after press i, as much of the pause as the replay kept.
  const toAt = (time: number): number => {
    let i = -1
    while (i + 1 < raw.length && raw[i + 1]!.time <= time) i++
    if (i < 0) return 0
    const kept = i + 1 < raw.length ? notes[i + 1]!.at - notes[i]!.at : Infinity
    return notes[i]!.at + Math.min(time - raw[i]!.time, kept)
  }
  const replayed = replayPedals(pedals, raw[0]!.time, length, toAt)
  return { notes, pedals: replayed.pedals, length: Math.max(length, replayed.end), shortened }
}

/** The pedal part of "What you played": see `playedSnippet`. */
function replayPedals(
  pedals: readonly CapturedPedal[],
  start: number,
  length: number,
  toAt: (time: number) => number,
): { pedals: SnippetPedal[]; end: number } {
  const out: SnippetPedal[] = []
  const value = new Map<number, number>()
  for (const p of pedals) if (p.time <= start) value.set(p.controller, p.value)
  for (const [controller, v] of value) if (v > 0) out.push({ at: 0, controller, value: v })
  const tail = new Map<number, number>()
  for (const p of pedals) {
    if (p.time <= start) continue
    const at = toAt(p.time)
    if (at < length) {
      out.push({ at, controller: p.controller, value: p.value })
      value.set(p.controller, p.value)
    } else if (
      (value.get(p.controller) ?? 0) >= PEDAL_DOWN &&
      p.value < PEDAL_DOWN &&
      !tail.has(p.controller) &&
      at <= length + PEDAL_TAIL_MS
    ) {
      // Lifted after the last key sound: the pedal rang this long.
      tail.set(p.controller, at)
    }
  }
  let end = length
  for (const [controller, v] of value) {
    if (v <= 0) continue
    const at = tail.get(controller) ?? (v >= PEDAL_DOWN ? length + PEDAL_TAIL_MS : length)
    out.push({ at, controller, value: 0 })
    end = Math.max(end, at)
  }
  return { pedals: sortPedals(out), end }
}

/** Time order; at one instant, ups before downs (as the performance builder ranks them). */
function sortPedals(pedals: SnippetPedal[]): SnippetPedal[] {
  return pedals
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.at - b.p.at || (a.p.value === 0 ? 0 : 1) - (b.p.value === 0 ? 0 : 1) || a.i - b.i)
    .map(({ p }) => p)
}

/**
 * "As written": bar `occ` of the score, both hands, at `multiplier` (the pass's speed), from the
 * bar's start; velocities from the score's dynamics; the score's pedal marks (U101), a pedal down
 * from an earlier bar going down at the start and every pedal let up at the bar's end, so none
 * lingers on the piano after the snippet.
 */
export function writtenSnippet(model: ScoreModel, tempo: TempoMapData, multiplier: number, occ: number): Snippet {
  const range = passageRange(model, { fromOcc: occ, toOcc: occ })
  const events = buildPerformance(model, { hands: 'none', range, sendPedals: true })
  const ms = (e: { position: ScoreModel['totalDuration']; offsetSec: number }) =>
    (secondsBetween(tempo, range.start, e.position, multiplier) + e.offsetSec / multiplier) * 1000
  const ons = new Map<number, { at: number; note: number; velocity: number }>()
  const notes: SnippetNote[] = []
  const pedals: SnippetPedal[] = []
  for (const e of events) {
    if (e.kind === 'cc') pedals.push({ at: Math.max(0, ms(e)), controller: e.controller, value: e.value })
    else if (e.kind === 'on') ons.set(e.voice, { at: ms(e), note: e.note, velocity: e.velocity })
    else if (e.kind === 'off') {
      const on = ons.get(e.voice)
      if (!on) continue
      ons.delete(e.voice)
      notes.push({ ...on, duration: Math.max(60, ms(e) - on.at) })
    }
  }
  notes.sort((a, b) => a.at - b.at || a.note - b.note)
  // A bar with no note to play plays nothing, its pedals neither.
  if (notes.length === 0) return { notes, pedals: [], length: 0, shortened: false }
  const sorted = sortPedals(pedals)
  const length = Math.max(...notes.map((n) => n.at + n.duration), ...sorted.map((p) => p.at))
  return { notes, pedals: sorted, length, shortened: false }
}

/**
 * Plays a snippet on a backend: each press, release and pedal move is handed over when it is due
 * (a timer per event, so nothing is queued ahead that a stop could not take back), in time order
 * (at one instant: releases, pedals, presses), `onEnd` once the last release has passed. `stop`
 * releases only the notes this snippet holds down and lets up only the pedals it pressed: never a
 * global cleanup, so the accompaniment or anything else on the same output is left alone.
 */
export class SnippetPlayer {
  #i = 0
  #p = 0
  #offs: { at: number; note: number }[] = []
  /** Pedals this snippet has down (controller → value). */
  readonly #down = new Map<number, number>()
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

  /** This snippet moves the pedal `controller` (an echo of it is not the learner's). */
  drivesPedal(controller: number): boolean {
    return this.snippet.pedals.some((p) => p.controller === controller)
  }

  get stopped(): boolean {
    return this.#stopped
  }

  #tick(): void {
    this.#timer = null
    if (this.#stopped) return
    const now = this.clock()
    const t = now - this.#start
    const { notes, pedals } = this.snippet
    for (;;) {
      const offAt = this.#offs[0]?.at ?? Infinity
      const pedalAt = pedals[this.#p]?.at ?? Infinity
      const onAt = notes[this.#i]?.at ?? Infinity
      const next = Math.min(offAt, pedalAt, onAt)
      if (next > t) break
      // Releases first, so a key struck again at the same instant sounds again; then the pedals,
      // so a key let go as the pedal goes down still rings.
      if (offAt === next) this.backend.noteOff(this.#offs.shift()!.note, now)
      else if (pedalAt === next) {
        const p = pedals[this.#p++]!
        this.backend.controlChange(p.controller, p.value, now)
        if (p.value > 0) this.#down.set(p.controller, p.value)
        else this.#down.delete(p.controller)
      } else {
        const n = notes[this.#i++]!
        this.backend.noteOn(n.note, n.velocity, now)
        this.#offs.push({ at: n.at + n.duration, note: n.note })
        this.#offs.sort((a, b) => a.at - b.at)
      }
    }
    if (this.#i >= notes.length && this.#p >= pedals.length && this.#offs.length === 0) {
      this.#stopped = true
      this.onEnd()
      return
    }
    const next = Math.min(
      notes[this.#i]?.at ?? Infinity,
      pedals[this.#p]?.at ?? Infinity,
      this.#offs[0]?.at ?? Infinity,
    )
    this.#timer = this.timers.setTimeout(() => this.#tick(), Math.max(1, next - t))
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#timer !== null) this.timers.clearTimeout(this.#timer)
    this.#timer = null
    const now = this.clock()
    for (const off of this.#offs.splice(0)) this.backend.noteOff(off.note, now)
    for (const controller of this.#down.keys()) this.backend.controlChange(controller, 0, now)
    this.#down.clear()
  }
}
