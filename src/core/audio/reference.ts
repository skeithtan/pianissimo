/**
 * Expected feature sequence of a score (spike, DECISIONS P14): one feature frame per 10 ms at the
 * score's tempo × multiplier, built from a harmonic template per sounding pitch (fundamental
 * plus decaying partials, spread over FFT bins by the Hann window's main lobe and summed into
 * semitones exactly as live frames are) and an exponential decay envelope per note. No audio is
 * synthesized: the cost is O(notes × sounding frames).
 */
import { type Rational, add, cmp, toNumber } from '../music/rational'
import { type TempoMapData, hasTempo, positionAtSeconds, secondsAt } from '../music/tempo'
import type { ScoreModel } from '../model/score'
import {
  FEATURE_DIM,
  FRAME_SEC,
  FrameEncoder,
  HOP_SEC,
  PIANO_HIGH,
  PIANO_LOW,
  SEMITONES,
  frameSize,
  semitoneOfFrequency,
} from './features'

/** Partials per template (fewer when they pass Nyquist). */
export const PARTIALS = 8
/** Release time constant after the notated end (damper), seconds. */
export const RELEASE_SEC = 0.06
/** Frames of silence kept after the last release. */
const TAIL_FRAMES = 50
/** Silent frames before time 0, so a follower waiting for the first note has silence to wait on. */
export const LEAD_FRAMES = 50

/** Decay time constant of a sounding piano string by pitch (rough: long in the bass, short in the treble). */
export function decaySec(midi: number): number {
  return 3 * 2 ** (-(midi - PIANO_LOW) / 24)
}

export interface ReferenceNote {
  readonly midi: number
  /** Seconds at the reference speed. */
  readonly start: number
  readonly end: number
  /** Whole-note performance position of the attack. */
  readonly position: number
}

export interface Reference {
  readonly sampleRate: number
  readonly count: number
  /** Leading silent frames: frame j models the window centered at (j − lead) × 10 ms. */
  readonly lead: number
  /** count × FEATURE_DIM, row-major (see `FrameEncoder`). */
  readonly frames: Float32Array
  /** Onset strength per frame (the same flux as live frames). */
  readonly onset: Float32Array
  readonly notes: readonly ReferenceNote[]
  readonly tempo: TempoMapData
  readonly multiplier: number
  readonly totalDuration: number
}

/** Hann main-lobe power at a fractional bin distance d (|d| < 2). */
function hannLobe(d: number): number {
  const a = Math.abs(d)
  if (a >= 2) return 0
  if (a < 1e-9) return 1
  if (Math.abs(a - 1) < 1e-9) return 0.25
  const s = Math.sin(Math.PI * a) / (Math.PI * a)
  const w = s / (1 - a * a)
  return w * w
}

/** Semitone energy template of a pitch (unit total), as the live extractor would bin it. */
export function pitchTemplate(midi: number, sampleRate: number): Float64Array {
  const n = frameSize(sampleRate)
  const binHz = sampleRate / n
  const out = new Float64Array(SEMITONES)
  const f0 = 440 * 2 ** ((midi - 69) / 12)
  for (let h = 1; h <= PARTIALS; h++) {
    const f = f0 * h
    if (f >= sampleRate / 2) break
    const amp2 = 1 / (h * h)
    const x = f / binHz
    for (let k = Math.max(1, Math.floor(x) - 1); k <= Math.ceil(x) + 1 && k <= n / 2; k++) {
      const p = semitoneOfFrequency(k * binHz)
      if (p >= 0) out[p] = out[p]! + amp2 * hannLobe(k - x)
    }
  }
  let sum = 0
  for (let p = 0; p < SEMITONES; p++) sum += out[p]!
  if (sum > 0) for (let p = 0; p < SEMITONES; p++) out[p] = out[p]! / sum
  return out
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

export interface ReferenceNoteOptions {
  /** Hold notes released under a marked sustain pedal until the pedal lifts (default true). */
  readonly pedal?: boolean
}

/**
 * Sounding notes of a model in seconds at `multiplier` (tie heads with their tied length; cue
 * notes skipped; with `pedal`, a note ending inside a marked sustain span rings to its end).
 */
export function referenceNotes(
  model: ScoreModel,
  tempo: TempoMapData,
  multiplier: number,
  options: ReferenceNoteOptions = {},
): ReferenceNote[] {
  const spans = options.pedal === false ? [] : sustainSpans(model)
  const out: ReferenceNote[] = []
  for (const n of model.notes) {
    if (n.tieContinuation || n.cue) continue
    if (n.midi < PIANO_LOW || n.midi > PIANO_HIGH) continue
    const start = secondsAt(tempo, n.onset, multiplier) + n.refOffsetSec / multiplier
    let endPos = add(n.onset, n.soundingDuration)
    const span = spans.find(([a, b]) => cmp(a, endPos) < 0 && cmp(endPos, b) < 0 && cmp(n.onset, b) < 0)
    if (span) endPos = span[1]
    const end = n.grace ? start + 0.1 : secondsAt(tempo, endPos, multiplier)
    out.push({ midi: n.midi, start, end: Math.max(end, start + 0.03), position: toNumber(n.onset) })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Squared envelope of a note at time t (seconds). */
function envelope2(note: ReferenceNote, tau: number, t: number): number {
  if (t < note.start) return 0
  if (t < note.end) return Math.exp((-2 * (t - note.start)) / tau)
  return Math.exp((-2 * (note.end - note.start)) / tau) * Math.exp((-2 * (t - note.end)) / RELEASE_SEC)
}

/**
 * Builds the reference for `model` at `tempo` × `multiplier`, binned for `sampleRate`. Frame j
 * models the analysis window centered at (j − lead) × 10 ms.
 */
export function buildReference(
  model: ScoreModel,
  tempo: TempoMapData,
  multiplier: number,
  sampleRate: number,
  options: ReferenceNoteOptions = {},
): Reference {
  if (!hasTempo(tempo)) throw new Error('The audio follower needs a tempo')
  const notes = referenceNotes(model, tempo, multiplier, options)
  let last = 0
  for (const n of notes) {
    const tail = n.end + RELEASE_SEC * 4
    if (tail > last) last = tail
  }
  const lead = LEAD_FRAMES
  const count = lead + Math.ceil(last / HOP_SEC) + TAIL_FRAMES
  const energy = new Float64Array(count * SEMITONES)
  const templates = new Map<number, Float64Array>()
  const half = FRAME_SEC / 2
  const SUB = 8
  for (const note of notes) {
    let tpl = templates.get(note.midi)
    if (!tpl) templates.set(note.midi, (tpl = pitchTemplate(note.midi, sampleRate)))
    const tau = decaySec(note.midi)
    const first = Math.max(0, lead + Math.floor((note.start - half) / HOP_SEC))
    for (let j = first; j < count; j++) {
      const t = (j - lead) * HOP_SEC
      let e2: number
      if (Math.abs(t - note.start) < half) {
        // The attack falls inside this window: average the envelope over it (Hann² weights).
        let acc = 0
        let wsum = 0
        for (let s = 0; s < SUB; s++) {
          const u = (s + 0.5) / SUB
          const w = Math.sin(Math.PI * u) ** 4
          acc += w * envelope2(note, tau, t - half + u * FRAME_SEC)
          wsum += w
        }
        e2 = acc / wsum
      } else {
        e2 = envelope2(note, tau, t)
        if (t > note.end && e2 < 1e-7) break
      }
      if (e2 <= 0) continue
      const row = j * SEMITONES
      for (let p = 0; p < SEMITONES; p++) energy[row + p] = energy[row + p]! + e2 * tpl[p]!
    }
  }
  const frames = new Float32Array(count * FEATURE_DIM)
  const onset = new Float32Array(count)
  const encoder = new FrameEncoder()
  for (let j = 0; j < count; j++) {
    const e = energy.subarray(j * SEMITONES, (j + 1) * SEMITONES)
    onset[j] = encoder.encode(e, false, frames.subarray(j * FEATURE_DIM, (j + 1) * FEATURE_DIM)).onset
  }
  return {
    sampleRate,
    count,
    lead,
    frames,
    onset,
    notes,
    tempo,
    multiplier,
    totalDuration: toNumber(model.totalDuration),
  }
}

/**
 * Float whole-note position of reference frame j, clamped to the end of the piece. Lead-in
 * frames are negative (before the first note), at the first segment's tempo.
 */
export function framePosition(ref: Reference, j: number): number {
  const sec = (j - ref.lead) * HOP_SEC
  if (sec < 0) return (sec * ref.multiplier * ref.tempo.segments[0]!.quarterBpm) / 240
  return Math.min(ref.totalDuration, positionAtSeconds(ref.tempo, sec, ref.multiplier))
}

/** Reference frame of a performance position (nearest, clamped); position 0 is the first frame after the lead. */
export function frameAt(ref: Reference, position: Rational): number {
  const sec = secondsAt(ref.tempo, position, ref.multiplier)
  return Math.min(ref.count - 1, Math.max(0, ref.lead + Math.round(sec / HOP_SEC)))
}
