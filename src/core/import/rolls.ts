/**
 * Reference realization of marked rolls (spec "Listening and hand practice", last paragraph;
 * `ROLL_POLICY_VERSION`):
 *  - total spread first → last attack = 120 ms at 1×, shortened to at most half the interval
 *    from the written onset to the next written attack or to the earliest member's ending
 *    (tie chain included), whichever comes first;
 *  - the roll's distinct fresh pitches are spaced evenly in the marked direction (low → high
 *    by default); tie continuations and a single fresh pitch add no spread;
 *  - one shared (cross-staff) group is one sweep; independent groups start together;
 *  - explicit `attack` offsets on members are source-resolved timings: kept, no extra spread.
 * Offsets are seconds at 1× in the full-piece realization (before any hand filtering); written
 * positions never change. Without a tempo every offset is 0 until a tempo is supplied.
 */
import { type Rational, add, cmp, gt, lt } from '../music/rational'
import { type TempoMapData, beatUnitName, hasTempo, secondsBetween, userTempoMap } from '../music/tempo'
import type { ArpeggioGroup, Diagnostic, PerformedNote, ScoreModel } from '../model/score'

export const ROLL_SPREAD_SEC = 0.12

interface RollNote {
  readonly index: number
  readonly onset: Rational
  readonly midi: number
  readonly soundingDuration: Rational
  readonly tieContinuation: boolean
  readonly grace: boolean
  readonly cue: boolean
}

export interface RollRealization {
  /** Reference offset per performed note index (0 for notes outside rolls). */
  readonly offsets: Float64Array
  /** Spread per arpeggio group index. */
  readonly spreads: readonly number[]
}

function firstAfter(sorted: readonly Rational[], p: Rational): Rational | undefined {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (gt(sorted[mid]!, p)) hi = mid
    else lo = mid + 1
  }
  return sorted[lo]
}

/**
 * Compute reference offsets. `attackOf` returns a member's explicit attack offset in whole notes
 * (MusicXML `attack`), or undefined.
 */
export function realizeRolls(
  notes: readonly RollNote[],
  groups: readonly Pick<ArpeggioGroup, 'index' | 'at' | 'notes' | 'direction'>[],
  tempo: TempoMapData,
  attackOf: (noteIndex: number) => Rational | undefined,
): RollRealization {
  const offsets = new Float64Array(notes.length)
  const spreads = groups.map(() => 0)
  if (!hasTempo(tempo)) return { offsets, spreads }
  const attackPositions: Rational[] = []
  let last: Rational | undefined
  for (const n of notes) {
    if (n.tieContinuation || n.grace || n.cue) continue
    if (!last || cmp(n.onset, last) !== 0) attackPositions.push(n.onset)
    last = n.onset
  }
  for (const g of groups) {
    const members = g.notes.map((i) => notes[i]!).filter((n) => !n.tieContinuation && !n.grace && !n.cue)
    if (members.length === 0) continue
    const explicit = members.map((n) => attackOf(n.index))
    if (explicit.some((a) => a !== undefined)) {
      let lo = Infinity
      let hi = -Infinity
      members.forEach((n, k) => {
        const a = explicit[k]
        const sec = a === undefined ? 0 : secondsBetween(tempo, n.onset, add(n.onset, a))
        offsets[n.index] = sec
        lo = Math.min(lo, sec)
        hi = Math.max(hi, sec)
      })
      spreads[g.index] = hi - lo
      continue
    }
    const pitches = [...new Set(members.map((n) => n.midi))].sort((a, b) => (g.direction === 'down' ? b - a : a - b))
    if (pitches.length < 2) continue
    let spread = ROLL_SPREAD_SEC
    const next = firstAfter(attackPositions, g.at)
    if (next) spread = Math.min(spread, secondsBetween(tempo, g.at, next) / 2)
    let earliestEnd: Rational | undefined
    for (const n of members) {
      const end = add(n.onset, n.soundingDuration)
      if (!earliestEnd || lt(end, earliestEnd)) earliestEnd = end
    }
    if (earliestEnd && gt(earliestEnd, g.at)) spread = Math.min(spread, secondsBetween(tempo, g.at, earliestEnd) / 2)
    spread = Math.max(0, spread)
    const step = spread / (pitches.length - 1)
    const offsetOf = new Map(pitches.map((p, k) => [p, step * k] as const))
    for (const n of members) offsets[n.index] = offsetOf.get(n.midi) ?? 0
    spreads[g.index] = spread
  }
  return { offsets, spreads }
}

/** Explicit `attack` offset of a performed note, read from its source note. */
export function sourceAttack(
  model: Pick<ScoreModel, 'notes' | 'sourceNotes'>,
): (noteIndex: number) => Rational | undefined {
  return (i) => {
    const n = model.notes[i]
    return n ? model.sourceNotes[n.src]?.attack : undefined
  }
}

/**
 * Rebuild a model's roll offsets for its current tempo map. Explicit attack offsets are kept
 * (`SourceNote.attack`; packages imported before importer 0.2.0 lack it and get the default spread).
 */
export function applyRollRealization(
  model: ScoreModel,
  attackOf: (noteIndex: number) => Rational | undefined = sourceAttack(model),
): ScoreModel {
  const { offsets, spreads } = realizeRolls(model.notes, model.arpeggios, model.tempo, attackOf)
  const notes: PerformedNote[] = model.notes.map((n) =>
    n.refOffsetSec === offsets[n.index] ? n : { ...n, refOffsetSec: offsets[n.index] ?? 0 },
  )
  const arpeggios: ArpeggioGroup[] = model.arpeggios.map((g) => ({ ...g, spreadSec: spreads[g.index] ?? 0 }))
  return { ...model, notes, arpeggios }
}

/**
 * Supply a practice tempo for a score without a numerical tempo (spec: "missing numerical tempo
 * requires a practice tempo"). Replaces the tempo map with one user segment and realizes the
 * reference rolls for it; explicit `attack` offsets from the file are realized at that tempo. `beatUnit` is in whole notes (quarter = 1/4, dotted quarter = 3/8).
 * Throws on a non-finite or non-positive BPM.
 */
export function withUserTempo(model: ScoreModel, beatBpm: number, beatUnit: Rational): ScoreModel {
  if (!Number.isFinite(beatBpm) || beatBpm <= 0) throw new RangeError(`Invalid tempo ${beatBpm}`)
  if (!(beatUnit.n > 0 && beatUnit.d > 0)) throw new RangeError('Invalid beat unit')
  const tempo = userTempoMap(beatBpm, beatUnit)
  const diagnostics: Diagnostic[] = model.diagnostics.filter(
    (d) => d.code !== 'tempo-missing' && d.code !== 'tempo-user',
  )
  diagnostics.push({
    severity: 'info',
    code: 'tempo-user',
    message: `Practice tempo set by you: ${beatUnitName(beatUnit)} = ${beatBpm}.`,
  })
  return applyRollRealization({ ...model, tempo, diagnostics })
}
