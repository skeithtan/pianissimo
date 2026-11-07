/**
 * Synthetic evaluation of the audio follower (tests and the spike's accuracy table): turns a
 * score into a perturbed performance, renders it, streams it through a follower in 10 ms blocks
 * and measures when each onset is reached. Pure (no Node APIs).
 */
import type { ScoreModel } from '../model/score'
import type { TempoMapData } from '../music/tempo'
import { type AudioFollowerOptions, createAudioFollower } from './index'
import { referenceNotes } from './reference'
import { type PlayedNote, renderNotes, rng } from './testkit'

export interface TruthOnset {
  readonly position: number
  /** Seconds in the rendered audio. */
  readonly time: number
}

export interface Performance {
  readonly notes: readonly PlayedNote[]
  /** Audible onset groups (a group whose only note was dropped is left out). */
  readonly onsets: readonly TruthOnset[]
  /** Audio times of the wrong or missing notes. */
  readonly mistakes: readonly number[]
}

export interface PerformOptions {
  /** Performed speed relative to the score tempo (1.25 = faster). */
  readonly factor: number
  /** Seconds of silence before the first note (default 1). */
  readonly lead?: number
  /** Random onset displacement per group, ± seconds (default 0.015). */
  readonly jitter?: number
  /** Fractions of the onset groups where one note is replaced by a wrong pitch. */
  readonly wrongAt?: readonly number[]
  /** Fractions of the onset groups where one note is left out. */
  readonly missingAt?: readonly number[]
  /** A silent stop of this many seconds before the group at `pauseAt` (the player waits). */
  readonly pause?: number
  readonly pauseAt?: number
  /** Pedal as marked in the score (notes ring to the pedal release; default false). */
  readonly pedal?: boolean
  /** Seconds added to every note's end (sustain pedal held through, notes ring on). */
  readonly sustain?: number
  /** Rubato depth 0..0.9: the local tempo swings by ± this share over an 8 s period. */
  readonly rubato?: number
  readonly seed?: number
}

export function perform(model: ScoreModel, tempo: TempoMapData, options: PerformOptions): Performance {
  const rand = rng(options.seed ?? 7)
  const lead = options.lead ?? 1
  const jitter = options.jitter ?? 0.015
  const base = referenceNotes(model, tempo, 1, { pedal: options.pedal ?? false })
  const positions = [...new Set(base.map((n) => n.position))].sort((a, b) => a - b)
  const groupOf = new Map(positions.map((p, i) => [p, i]))
  const shift = positions.map(() => (rand() * 2 - 1) * jitter)
  const at = (fractions: readonly number[] | undefined): Set<number> =>
    new Set((fractions ?? []).map((f) => Math.min(positions.length - 1, Math.floor(f * positions.length))))
  const wrong = at(options.wrongAt)
  const missing = at(options.missingAt)
  const pauseGroup = options.pause ? Math.floor((options.pauseAt ?? 0.5) * positions.length) : -1
  const pauseStart = pauseGroup >= 0 ? (base.find((n) => groupOf.get(n.position) === pauseGroup)?.start ?? 0) : 0
  const depth = options.rubato ?? 0
  const period = 8
  const warp = (t: number): number => t + ((depth * period) / (2 * Math.PI)) * Math.sin((2 * Math.PI * t) / period)
  const time = (t: number): number =>
    lead + warp(t / options.factor) + (pauseGroup >= 0 && t >= pauseStart - 1e-9 ? options.pause! : 0)
  const notes: PlayedNote[] = []
  const mistakes: number[] = []
  const audible = new Map<number, number>()
  const handled = new Set<number>()
  for (const n of base) {
    const g = groupOf.get(n.position)!
    const start = time(n.start) + shift[g]! + (rand() * 2 - 1) * 0.004
    let end = time(n.end) + shift[g]! + (options.sustain ?? 0)
    // A pause holds nothing: notes sounding into it are released at its start.
    if (pauseGroup >= 0 && n.start < pauseStart - 1e-9 && n.end > pauseStart) end = time(pauseStart - 1e-6) + shift[g]!
    let midi = n.midi
    if (!handled.has(g) && (wrong.has(g) || missing.has(g))) {
      handled.add(g)
      mistakes.push(start)
      if (missing.has(g)) continue
      midi += rand() < 0.5 ? 1 : -2
    }
    notes.push({ midi, start, end: Math.max(end, start + 0.05), velocity: 0.5 + 0.5 * rand() })
    if (!audible.has(g) || start < audible.get(g)!) audible.set(g, start)
  }
  const onsets = [...audible.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([g, t]) => ({ position: positions[g]!, time: t }))
  return { notes, onsets, mistakes }
}

export interface Evaluation {
  readonly onsets: number
  /** Reach error per onset (estimate time − true time, seconds); NaN when never reached. */
  readonly errors: readonly number[]
  readonly within100: number
  readonly within150: number
  readonly medianAbsMs: number
  /** Share within 150 ms among onsets more than `recoverySec` after the last mistake. */
  readonly recovered: number
  /** Feature + alignment time per frame in ms (wall clock). */
  readonly msPerFrame: number
  readonly frames: number
}

export interface EvaluateOptions extends AudioFollowerOptions {
  readonly sampleRate?: number
  readonly recoverySec?: number
  /** Wall clock in ms (performance.now); omit to skip timing. */
  readonly clock?: () => number
}

/** Renders the performance and scores onset reaching (see `evaluateAudio`). */
export function evaluate(
  model: ScoreModel,
  tempo: TempoMapData,
  multiplier: number,
  perf: Performance,
  options: EvaluateOptions = {},
): Evaluation {
  const sr = options.sampleRate ?? 44100
  const audio = renderNotes(perf.notes, { sampleRate: sr })
  return evaluateAudio(model, tempo, multiplier, audio, sr, perf.onsets, perf.mistakes, options)
}

/**
 * Streams `audio` (mono) through a follower built at `multiplier` in 10 ms blocks and scores
 * when each true onset is reached: the time of the first estimate at or past the onset's
 * position minus the onset's time in the audio. Works for a recording with a hand-made onset
 * list as well as for a synthetic performance.
 */
export function evaluateAudio(
  model: ScoreModel,
  tempo: TempoMapData,
  multiplier: number,
  audio: Float32Array,
  sampleRate: number,
  onsets: readonly TruthOnset[],
  mistakes: readonly number[],
  options: EvaluateOptions = {},
): Evaluation {
  const sr = sampleRate
  const follower = createAudioFollower(model, tempo, multiplier, options)
  const hop = Math.round(sr / 100)
  const times: number[] = []
  const positions: number[] = []
  follower.push(new Float32Array(0), sr, 0) // builds the reference outside the timing
  const clock = options.clock
  const t0 = clock?.() ?? 0
  for (let s = 0; s + hop <= audio.length; s += hop) {
    const est = follower.push(audio.subarray(s, s + hop), sr, s / sr)
    if (est.frames > 0) {
      times.push(est.time)
      positions.push(est.position)
    }
  }
  const msPerFrame = clock ? (clock() - t0) / Math.max(1, times.length) : 0
  const errors: number[] = []
  let k = 0
  for (const o of onsets) {
    while (k < positions.length && positions[k]! < o.position - 1e-6) k++
    errors.push(k < positions.length ? times[k]! - o.time : NaN)
  }
  const within = (ms: number, list: readonly number[]): number =>
    list.length === 0 ? 1 : list.filter((e) => Math.abs(e) <= ms / 1000).length / list.length
  const lastMistake = mistakes.length ? Math.max(...mistakes) : -Infinity
  const after = errors.filter((_, i) => onsets[i]!.time > lastMistake + (options.recoverySec ?? 1))
  const abs = errors.map((e) => (Number.isNaN(e) ? Infinity : Math.abs(e))).sort((a, b) => a - b)
  return {
    onsets: errors.length,
    errors,
    within100: within(100, errors),
    within150: within(150, errors),
    medianAbsMs: abs.length ? abs[Math.floor(abs.length / 2)]! * 1000 : 0,
    recovered: within(150, after),
    msPerFrame,
    frames: times.length,
  }
}
