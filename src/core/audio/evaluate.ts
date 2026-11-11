/**
 * Synthetic evaluation of the audio follower (tests and the accuracy table in README.md): turns a
 * score into a perturbed performance, renders it, streams it through a follower in 10 ms blocks
 * and measures when each onset is reached. Pure (no Node APIs).
 */
import type { ScoreModel } from '../model/score'
import { type Rational, add, cmp, toNumber } from '../music/rational'
import { type TempoMapData, secondsAt } from '../music/tempo'
import { PIANO_HIGH, PIANO_LOW } from './features'
import { type AudioFollowerOptions, createAudioFollower } from './index'
import { type PlayedNote, renderNotes, rng } from './testkit'

/** A sounding note of a score in seconds at the score tempo. */
export interface ScoreNote {
  readonly midi: number
  readonly start: number
  readonly end: number
  /** Whole-note performance position of the attack. */
  readonly position: number
}

/**
 * Sustain-pedal down spans of the score, [start, end) in performance positions: `start` presses,
 * `stop` releases, `change` releases and presses again; a pedal still down at the end is released
 * at the end of the piece.
 */
export function sustainSpans(model: ScoreModel): [Rational, Rational][] {
  const out: [Rational, Rational][] = []
  let down: Rational | null = null
  const marks = model.pedals.filter((p) => p.kind === 'sustain').sort((a, b) => cmp(a.at, b.at))
  for (const m of marks) {
    if ((m.type === 'stop' || m.type === 'change') && down) {
      if (cmp(m.at, down) > 0) out.push([down, m.at])
      down = null
    }
    if ((m.type === 'start' || m.type === 'change') && !down) down = m.at
  }
  if (down && cmp(model.totalDuration, down) > 0) out.push([down, model.totalDuration])
  return out
}

/**
 * Sounding notes of a model in seconds at `multiplier` (tie heads with their tied length; grace
 * and cue notes skipped, as the follower's groups do; with `pedal`, a note ending inside a marked
 * sustain span rings to its end).
 */
export function scoreNotes(
  model: ScoreModel,
  tempo: TempoMapData,
  multiplier = 1,
  options: { readonly pedal?: boolean } = {},
): ScoreNote[] {
  const spans = options.pedal ? sustainSpans(model) : []
  const out: ScoreNote[] = []
  for (const n of model.notes) {
    if (n.tieContinuation || n.grace || n.cue) continue
    if (n.midi < PIANO_LOW || n.midi > PIANO_HIGH) continue
    const start = secondsAt(tempo, n.onset, multiplier) + n.refOffsetSec / multiplier
    let endPos = add(n.onset, n.soundingDuration)
    const span = spans.find(([a, b]) => cmp(a, endPos) < 0 && cmp(endPos, b) < 0 && cmp(n.onset, b) < 0)
    if (span) endPos = span[1]
    const end = secondsAt(tempo, endPos, multiplier)
    out.push({ midi: n.midi, start, end: Math.max(end, start + 0.03), position: toNumber(n.onset) })
  }
  return out.sort((a, b) => a.start - b.start)
}

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

/** The player stops before the group at fraction `at` of the piece. */
export interface Hesitation {
  readonly at: number
  readonly seconds: number
  /** The keys stay down: the notes sounding into the stop ring through it (default: released). */
  readonly held?: boolean
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
  /** Stops in the playing (a learner looking for the next notes). */
  readonly hesitations?: readonly Hesitation[]
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
  const base = scoreNotes(model, tempo, 1, { pedal: options.pedal ?? false })
  const positions = [...new Set(base.map((n) => n.position))].sort((a, b) => a - b)
  const groupOf = new Map(positions.map((p, i) => [p, i]))
  const shift = positions.map(() => (rand() * 2 - 1) * jitter)
  const at = (fractions: readonly number[] | undefined): Set<number> =>
    new Set((fractions ?? []).map((f) => Math.min(positions.length - 1, Math.floor(f * positions.length))))
  const wrong = at(options.wrongAt)
  const missing = at(options.missingAt)
  // Score time at which each hesitation begins: the attack of its group.
  const stops = (options.hesitations ?? [])
    .map((h) => {
      const group = Math.min(positions.length - 1, Math.floor(h.at * positions.length))
      const start = base.find((n) => groupOf.get(n.position) === group)?.start ?? 0
      return { start, seconds: h.seconds, held: h.held ?? false }
    })
    .sort((a, b) => a.start - b.start)
  const depth = options.rubato ?? 0
  const period = 8
  const warp = (t: number): number => t + ((depth * period) / (2 * Math.PI)) * Math.sin((2 * Math.PI * t) / period)
  /** Audio time of score time `t`; a stop beginning at `t` has passed unless `before`. */
  const time = (t: number, before = false): number => {
    let waited = 0
    for (const s of stops) if (before ? t > s.start + 1e-9 : t >= s.start - 1e-9) waited += s.seconds
    return lead + warp(t / options.factor) + waited
  }
  const notes: PlayedNote[] = []
  const mistakes: number[] = []
  const audible = new Map<number, number>()
  const handled = new Set<number>()
  for (const n of base) {
    const g = groupOf.get(n.position)!
    const start = time(n.start) + shift[g]! + (rand() * 2 - 1) * 0.004
    let end = time(n.end) + shift[g]! + (options.sustain ?? 0)
    // A stop with the hands off the keys releases what sounds into it; held keys ring through.
    const cut = stops.find((s) => !s.held && n.start < s.start - 1e-9 && n.end >= s.start - 1e-9)
    if (cut) end = time(cut.start, true) + shift[g]!
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
  /** Reach error per onset (time the follower got there − true time, seconds); NaN when never reached. */
  readonly errors: readonly number[]
  readonly within100: number
  readonly within150: number
  /** Share of the onsets the follower reached more than 150 ms before they were played. */
  readonly ahead: number
  readonly medianAbsMs: number
  /** Share within 150 ms among onsets more than `recoverySec` after the last mistake. */
  readonly recovered: number
  /** Analysis and matching time per frame in ms (wall clock). */
  readonly msPerFrame: number
  readonly frames: number
}

export interface EvaluateOptions extends AudioFollowerOptions {
  readonly sampleRate?: number
  /** White-noise amplitude of the rendering (default 3e-4, about −70 dBFS). */
  readonly noise?: number
  readonly recoverySec?: number
  /** Wall clock in ms (performance.now); omit to skip timing. */
  readonly clock?: () => number
}

/** Renders the performance and scores onset reaching (see `evaluateAudio`). */
export function evaluate(model: ScoreModel, perf: Performance, options: EvaluateOptions = {}): Evaluation {
  const sr = options.sampleRate ?? 44100
  const audio = renderNotes(perf.notes, {
    sampleRate: sr,
    ...(options.noise === undefined ? {} : { noise: options.noise }),
  })
  return evaluateAudio(model, audio, sr, perf.onsets, perf.mistakes, options)
}

/**
 * Streams `audio` (mono) through a follower in 10 ms blocks and scores when each true onset is
 * reached: the time the follower first reported a position at or past the onset's minus the
 * onset's time in the audio. Works for a recording with a hand-made onset list as well as for a
 * synthetic performance.
 */
export function evaluateAudio(
  model: ScoreModel,
  audio: Float32Array,
  sampleRate: number,
  onsets: readonly TruthOnset[],
  mistakes: readonly number[],
  options: EvaluateOptions = {},
): Evaluation {
  const sr = sampleRate
  const follower = createAudioFollower(model, options)
  const hop = Math.round(sr / 100)
  const times: number[] = []
  const positions: number[] = []
  const clock = options.clock
  const t0 = clock?.() ?? 0
  let frames = 0
  let furthest = -Infinity
  for (let s = 0; s + hop <= audio.length; s += hop) {
    const est = follower.push(audio.subarray(s, s + hop), sr, s / sr)
    frames += est.frames
    // The cursor only moves forward: a position behind the furthest one changes nothing.
    if (est.moved && est.position > furthest) {
      furthest = est.position
      times.push(est.time)
      positions.push(est.position)
    }
  }
  const msPerFrame = clock ? (clock() - t0) / Math.max(1, frames) : 0
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
    ahead: errors.length === 0 ? 0 : errors.filter((e) => e < -0.15).length / errors.length,
    medianAbsMs: abs.length ? abs[Math.floor(abs.length / 2)]! * 1000 : 0,
    recovered: within(150, after),
    msPerFrame,
    frames,
  }
}
