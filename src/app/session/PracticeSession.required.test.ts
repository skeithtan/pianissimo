/**
 * Every required note gates the cursor through the real session (DECISIONS P23): input routing,
 * the gated transport, Repeat resets and held keys. At each group with notes in both hands, one
 * hand alone (tapped, or played legato over the previous group's held keys) must leave both the
 * engine's group and the strip's cursor where they are. The engine-level sweep over every
 * fixture is `core/engine/engine.required.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REFERENCE_PIECE, fixtureBytes, fixtureExists, importBytes } from '../../../tests/unit/import/fixtures'
import type { PassageRange } from '../../core/model/practice'
import type { Hand, ScoreModel } from '../../core/model/score'
import { toNumber } from '../../core/music/rational'
import { harness, type Harness } from './testkit'

type Style = 'tap' | 'legato'

/** Play one pass from the engine's current group to the end; returns the violations. */
function playPass(h: Harness, model: ScoreModel, first: Hand, style: Style): string[] {
  const bad: string[] = []
  let held: number[] = []
  const records = h.attempts.length
  const press = (pitches: readonly number[]) => {
    for (const p of pitches) {
      if (held.includes(p)) {
        h.release(p)
        held = held.filter((x) => x !== p)
      }
      h.press(p)
      if (style === 'tap') h.release(p)
      else held.push(p)
    }
  }
  for (let guard = 0; guard < 5000; guard++) {
    const s = h.session.engine.state
    // A completed pass ends here (a Repeat reset may already be preparing the next one).
    if (s.groupIndex === null || s.phase === 'completed' || h.attempts.length > records) break
    const gi = s.groupIndex
    const tl = h.session.engine.timeline
    const g = tl.groups[gi]!
    for (let k = 0; k < 500 && h.session.engine.state.transportGate < gi; k++) h.step(20)
    const handOf = (hand: Hand) => [
      ...new Set(g.notes.filter((n) => model.notes[n]!.hand === hand).map((n) => model.notes[n]!.midi)),
    ]
    const a = handOf(first)
    const rest = g.pitches.filter((p) => !a.includes(p))
    press(a)
    h.step(300)
    const after = h.session.engine.state
    if (a.length > 0 && rest.length > 0 && (after.groupIndex !== gi || h.strip.cursor > toNumber(g.position) + 1e-9)) {
      bad.push(`group ${gi} (bar ${model.occurrences[g.occ]?.number}): ${first} ${a} alone moved the cursor`)
      break
    }
    press(rest)
    if (style === 'legato') {
      const off = held.filter((p) => !g.pitches.includes(p))
      if (off.length > 0) h.release(...off)
      held = held.filter((p) => g.pitches.includes(p))
    }
    h.step(20)
    if (h.session.engine.state.groupIndex === gi && h.attempts.length === records) {
      bad.push(`group ${gi}: still current after all its pitches`)
      break
    }
  }
  if (held.length > 0) h.release(...held)
  return bad
}

async function sweep(model: ScoreModel, range: PassageRange | null, first: Hand, style: Style, passes = 1) {
  const h = harness(model, { hands: 'both', range })
  h.midi.out = null
  await h.session.start()
  h.step(50)
  const bad: string[] = []
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0) {
      // The Repeat reset: wait for Ready at the loop start.
      for (let k = 0; k < 2000 && h.session.engine.state.phase !== 'ready'; k++) h.step(20)
    }
    bad.push(...playPass(h, model, first, style))
  }
  const scored = h.attempts.filter((a) => a.kind === 'scored')
  return { bad, scored }
}

describe('every required note gates the session cursor (P23)', () => {
  it('two-hands fixture: reading and a two-pass Repeat loop', async () => {
    const model = (await importBytes('two-hands.musicxml', fixtureBytes('two-hands.musicxml'))).package.model
    const loop = { fromOcc: 0, toOcc: model.occurrences.length - 1 }
    for (const first of ['R', 'L'] as const) {
      for (const style of ['tap', 'legato'] as const) {
        expect((await sweep(model, null, first, style)).bad).toEqual([])
        const r = await sweep(model, loop, first, style, 2)
        expect(r.bad).toEqual([])
        expect(r.scored.map((a) => [a.completion, a.wrongAttacks])).toEqual([
          ['completed', 0],
          ['completed', 0],
        ])
      }
    }
  })

  const present = fixtureExists(REFERENCE_PIECE)
  describe.skipIf(!present)('the reference piece (tests/fixtures/private)', async () => {
    const model = present
      ? (await importBytes('reference-piece.musicxml', new Uint8Array(readFileSync(REFERENCE_PIECE)))).package.model
      : (undefined as unknown as ScoreModel)
    for (const first of ['R', 'L'] as const) {
      for (const style of ['tap', 'legato'] as const) {
        it(`reading the whole piece, ${first} first, ${style}`, async () => {
          expect((await sweep(model, null, first, style)).bad).toEqual([])
        }, 60_000)
        it(`four-bar Repeat loops, two passes each, ${first} first, ${style}`, async () => {
          const bars = model.occurrences.length
          for (let from = 0; from < bars; from += 4) {
            const loop = { fromOcc: from, toOcc: Math.min(bars - 1, from + 3) }
            const r = await sweep(model, loop, first, style, 2)
            expect(r.bad, `bars ${from + 1}–${loop.toOcc + 1}`).toEqual([])
            expect(r.scored.map((a) => [a.completion, a.wrongAttacks])).toEqual([
              ['completed', 0],
              ['completed', 0],
            ])
          }
        }, 60_000)
      }
    }
  })
})
