/**
 * Every required note gates the cursor (DECISIONS P23): with both hands selected, an onset group
 * is complete only when every distinct pitch the two hands attack there has been freshly pressed.
 * A sweep over real scores: at every group with notes in both hands, one hand alone (with or
 * without the previous group's keys still held) must never advance the cursor, in ordinary
 * reading, scored passages (whole piece and every bar as a loop) and Keep time. The groups' pitch
 * sets are checked against the score independently of the timeline builder.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REFERENCE_PIECE, SCORES, fixtureExists, importBytes } from '../../../tests/unit/import/fixtures'
import type { Hand, ScoreModel } from '../model/score'
import type { PassageRange } from '../model/practice'
import { key } from '../music/rational'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline, type Timeline } from './timeline'
import type { EngineConfig } from './types'

type Variant = { readonly first: Hand; readonly legato: boolean }
const VARIANTS: readonly Variant[] = [
  { first: 'R', legato: false },
  { first: 'L', legato: false },
  { first: 'R', legato: true },
  { first: 'L', legato: true },
]
type Kind = 'reading' | 'scored' | 'strict'

function handPitches(model: ScoreModel, tl: Timeline, gi: number, hand: Hand): number[] {
  const g = tl.groups[gi]!
  return [...new Set(g.notes.filter((n) => model.notes[n]!.hand === hand).map((n) => model.notes[n]!.midi))]
}

/**
 * Independent of `buildTimeline`: the distinct pitches attacked at `position` in the passage
 * (grace, cue notes and tie continuations excluded; DECISIONS I13, spec "Tied continuation").
 */
function attackedAt(model: ScoreModel, tl: Timeline, gi: number): number[] {
  const g = tl.groups[gi]!
  const k = key(g.position)
  const out = new Set<number>()
  for (const n of model.notes) {
    if (key(n.onset) === k && !n.grace && !n.cue && !n.tieContinuation) out.add(n.midi)
  }
  for (const i of g.boundaryNotes) out.add(model.notes[i]!.midi)
  return [...out].sort((a, b) => a - b)
}

/**
 * Walk the whole timeline once: at each group press the `first` hand's pitches, check that a
 * two-hand group did not advance (nor complete), then press the rest. `legato` keeps every key
 * down until the next group has been played (the previous group's keys are held while the
 * first hand plays); a held key the group needs again is released and re-pressed first.
 * Returns one line per violation.
 */
function walk(model: ScoreModel, tl: Timeline, kind: Kind, v: Variant): string[] {
  const config: EngineConfig =
    kind === 'reading'
      ? { mode: 'reading', pieceId: 'p', transport: 'accompaniment' }
      : kind === 'scored'
        ? { mode: 'scored', pieceId: 'p', transport: 'accompaniment', prepared: true }
        : { mode: 'scored', pieceId: 'p', transport: 'strict', rhythm: { toleranceMs: 150 }, prepared: true }
  const d = new EngineDriver(tl, config)
  if (kind === 'strict') {
    d.engine.startRunning(d.now)
    d.flush()
  }
  const bad: string[] = []
  let held: number[] = []
  const press = (pitches: readonly number[]) => {
    for (const p of pitches) {
      if (held.includes(p)) {
        d.up(p)
        held = held.filter((x) => x !== p)
      }
      d.down(p)
      if (v.legato) held.push(p)
      else d.up(p)
    }
  }
  for (let gi = 0; gi < tl.groups.length; gi++) {
    if (d.state.groupIndex !== gi) {
      bad.push(`expected group ${gi}, engine at ${d.state.groupIndex}`)
      break
    }
    d.wait(400)
    d.engine.transportArrived(gi, d.now)
    d.flush()
    const g = tl.groups[gi]!
    const expected = attackedAt(model, tl, gi)
    if (expected.join() !== g.pitches.join())
      bad.push(`group ${gi}: requires ${g.pitches} but the score attacks ${expected}`)
    const a = handPitches(model, tl, gi, v.first)
    const rest = g.pitches.filter((p) => !a.includes(p))
    const completions = d.of('input-complete').length
    press(a)
    if (a.length > 0 && rest.length > 0) {
      const bar = model.occurrences[g.occ]?.number
      if (d.state.groupIndex !== gi) bad.push(`group ${gi} (bar ${bar}): ${v.first} ${a} alone advanced`)
      else if (d.of('input-complete').length !== completions) bad.push(`group ${gi} (bar ${bar}): completed early`)
      else if (d.state.missingPitches.join() !== rest.join()) bad.push(`group ${gi}: missing ${d.state.missingPitches}`)
    }
    press(rest)
    if (v.legato) {
      const off = held.filter((p) => !g.pitches.includes(p))
      if (off.length > 0) d.up(...off)
      held = held.filter((p) => g.pitches.includes(p))
    }
  }
  if (bad.length === 0 && kind !== 'reading' && d.state.phase !== 'completed') bad.push(`attempt ${d.state.phase}`)
  if (bad.length === 0 && kind !== 'reading' && d.records().at(-1)?.wrongAttacks !== 0) bad.push('wrong attacks')
  return bad
}

function sweep(model: ScoreModel, label: string): void {
  const twoHand = (tl: Timeline) =>
    tl.groups.some((_, i) => handPitches(model, tl, i, 'R').length > 0 && handPitches(model, tl, i, 'L').length > 0)
  const whole = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
  it(`${label}: one hand alone never advances a two-hand group (reading, scored, Keep time)`, () => {
    for (const v of VARIANTS) {
      expect(walk(model, whole, 'reading', v), `reading ${JSON.stringify(v)}`).toEqual([])
      if (!whole.scoredAllowed) continue
      const all: PassageRange = { fromOcc: 0, toOcc: model.occurrences.length - 1 }
      const scored = buildTimeline(model, { hands: 'both', range: all, multiplier: 1 })
      expect(walk(model, scored, 'scored', v), `scored ${JSON.stringify(v)}`).toEqual([])
      expect(walk(model, scored, 'strict', v), `strict ${JSON.stringify(v)}`).toEqual([])
    }
  }, 60_000)
  if (!whole.scoredAllowed) return
  it(`${label}: the same in every one-bar loop (boundary reattacks included)`, () => {
    for (let occ = 0; occ < model.occurrences.length; occ++) {
      const tl = buildTimeline(model, { hands: 'both', range: { fromOcc: occ, toOcc: occ }, multiplier: 1 })
      if (!tl.scoredAllowed || !twoHand(tl)) continue
      for (const v of VARIANTS) expect(walk(model, tl, 'scored', v), `bar ${occ} ${JSON.stringify(v)}`).toEqual([])
    }
  }, 60_000)
}

describe('every required note gates the cursor (P23)', () => {
  describe('built scores', () => {
    // Two hands at one onset, the same pitch in both hands, a tie in one hand while the other
    // attacks, and a grace note: the documented exceptions next to ordinary chords.
    const model = buildScore({
      notes: [
        { at: 0, midi: 72 },
        { at: 0, midi: 48, hand: 'L' },
        { at: 1, midi: 74 },
        { at: 1, midi: 74, hand: 'L' },
        { at: 2, midi: 76 },
        { at: 3, midi: 76, cont: true },
        { at: 2, midi: 50, hand: 'L' },
        { at: 3, midi: 52, hand: 'L' },
        { at: 4, midi: 79, grace: true },
        { at: 4, midi: 77 },
        { at: 4, midi: 53, hand: 'L' },
      ],
      bars: 2,
    })
    sweep(model, 'built')

    it('the documented exceptions: a shared pitch takes one press, a tied note none', () => {
      const tl = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
      const d = new EngineDriver(tl, { mode: 'reading', pieceId: 'p', transport: 'free' })
      d.tap(72)
      expect(d.state.groupIndex).toBe(0)
      d.tap(48)
      d.tap(74) // the same pitch in both hands: one key, one press
      expect(d.state.groupIndex).toBe(2)
      d.tap(76, 50)
      d.tap(52) // the right hand's E5 is tied through beat 4: nothing to press there
      expect(d.state.groupIndex).toBe(4)
      d.tap(77, 53) // the grace G5 is never required (DECISIONS I13)
      expect(d.state.phase).toBe('completed')
    })
  })

  describe('fixtures (tests/fixtures/scores)', async () => {
    const names = readdirSync(SCORES).filter((n) => n.endsWith('.musicxml'))
    for (const name of names) {
      let model: ScoreModel | undefined
      try {
        model = (await importBytes(name, new Uint8Array(readFileSync(`${SCORES}/${name}`)))).package.model
      } catch {
        continue // readable rejections (malformed, unrelated)
      }
      sweep(model, name)
    }
  })

  const present = fixtureExists(REFERENCE_PIECE)
  describe.skipIf(!present)('the reference piece (tests/fixtures/private)', async () => {
    if (!present) return
    const model = (await importBytes('reference-piece.musicxml', new Uint8Array(readFileSync(REFERENCE_PIECE)))).package
      .model
    sweep(model, 'reference piece')
  })
})
