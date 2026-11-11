/**
 * What the audio follower expects to hear (DECISIONS P16): the score's onset groups and, per
 * group, the semitone energies its notes add when they are struck. Pure and worker-safe.
 */
import type { ScoreModel } from '../model/score'
import { type Rational, cmp, key, toNumber } from '../music/rational'
import { LOBE_SPAN, PIANO_HIGH, PIANO_LOW, SEMITONES, frameSize, semitoneOfFrequency, windowLobe } from './features'

/** Partials per note (fewer when they pass PARTIAL_MAX_HZ or Nyquist). */
export const PARTIALS = 16
export const PARTIAL_MAX_HZ = 6000

/** The notes struck together at one position of the performance. */
export interface AttackGroup {
  readonly position: Rational
  /** Distinct MIDI pitches, ascending. */
  readonly pitches: readonly number[]
}

/**
 * The onset groups of `model` in performance order: every position where a note is struck, with
 * the distinct pitches struck there. As the practice timeline for both hands does, tie
 * continuations, grace notes and cue notes are left out, so the positions are the timeline's.
 */
export function attackGroups(model: ScoreModel): AttackGroup[] {
  const buckets = new Map<string, { position: Rational; pitches: Set<number> }>()
  for (const n of model.notes) {
    if (n.tieContinuation || n.grace || n.cue) continue
    if (n.midi < PIANO_LOW || n.midi > PIANO_HIGH) continue
    const k = key(n.onset)
    let b = buckets.get(k)
    if (!b) buckets.set(k, (b = { position: n.onset, pitches: new Set() }))
    b.pitches.add(n.midi)
  }
  return [...buckets.values()]
    .sort((a, b) => cmp(a.position, b.position))
    .map((b) => ({ position: b.position, pitches: [...b.pitches].sort((x, y) => x - y) }))
}

/**
 * Semitone energies of one struck pitch, as the analyzer bins them at `sampleRate`: 16 partials
 * at 1/h power, each spread over FFT bins by the analysis window; the strongest semitone is 1.
 * A real piano's partials are stronger or weaker than this from note to note and from piano to
 * piano; the matcher compares log-compressed rises, which forgives most of that.
 */
export function pitchTemplate(
  midi: number,
  sampleRate: number,
  lobe: (d: number) => number = windowLobe(frameSize(sampleRate)),
  /** Partials and the exponent of their power roll-off (tests sound notes with other spectra). */
  shape: { readonly partials: number; readonly rollOff: number } = { partials: PARTIALS, rollOff: 1 },
): Float64Array {
  const n = frameSize(sampleRate)
  const binHz = sampleRate / n
  const out = new Float64Array(SEMITONES)
  const f0 = 440 * 2 ** ((midi - 69) / 12)
  for (let h = 1; h <= shape.partials; h++) {
    const f = f0 * h
    if (f >= sampleRate / 2 || f > PARTIAL_MAX_HZ) break
    const x = f / binHz
    const power = h ** -shape.rollOff
    for (let k = Math.max(1, Math.ceil(x - LOBE_SPAN)); k < x + LOBE_SPAN && k <= n / 2; k++) {
      const p = semitoneOfFrequency(k * binHz)
      if (p >= 0) out[p] = out[p]! + lobe(k - x) * power
    }
  }
  let max = 0
  for (let p = 0; p < SEMITONES; p++) if (out[p]! > max) max = out[p]!
  if (max > 0) for (let p = 0; p < SEMITONES; p++) out[p] = out[p]! / max
  return out
}

/** A group's attack as sparse semitone energies: the sum of its pitches' templates. */
export interface AttackTemplate {
  /** Semitone bins (0-based from MIDI 21), ascending. */
  readonly index: Int16Array
  readonly value: Float32Array
}

/** Energies below this share of a note's strongest semitone are left out of a template. */
const TEMPLATE_FLOOR = 1e-4

export function attackTemplates(groups: readonly AttackGroup[], sampleRate: number): AttackTemplate[] {
  const lobe = windowLobe(frameSize(sampleRate))
  const byPitch = new Map<number, Float64Array>()
  const byChord = new Map<string, AttackTemplate>()
  return groups.map((g) => {
    const chord = g.pitches.join(',')
    let t = byChord.get(chord)
    if (t) return t
    const sum = new Float64Array(SEMITONES)
    for (const midi of g.pitches) {
      let one = byPitch.get(midi)
      if (!one) byPitch.set(midi, (one = pitchTemplate(midi, sampleRate, lobe)))
      for (let p = 0; p < SEMITONES; p++) sum[p] = sum[p]! + one[p]!
    }
    const index: number[] = []
    for (let p = 0; p < SEMITONES; p++) if (sum[p]! > TEMPLATE_FLOOR) index.push(p)
    t = { index: Int16Array.from(index), value: Float32Array.from(index, (p) => sum[p]!) }
    byChord.set(chord, t)
    return t
  })
}

/** Float whole-note position of each group. */
export function groupPositions(groups: readonly AttackGroup[]): Float64Array {
  return Float64Array.from(groups, (g) => toNumber(g.position))
}
