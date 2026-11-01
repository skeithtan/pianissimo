import { expect, it } from 'vitest'
import { buildTimeline } from '../engine/timeline'
import { buildPerformance, passageRange } from './performance'
import { makeModel } from './testkit'
import type { PerformanceEvent } from './types'

const onNotes = (evs: readonly PerformanceEvent[]): number[] => evs.flatMap((e) => (e.kind === 'on' ? [e.note] : []))

it('a learner tie across the loop start does not silence the automatic unison attack there (E16)', () => {
  const model = makeModel({
    notes: [
      { at: '0', dur: '1', midi: 60, hand: 'R', tieToNext: true },
      { at: '1', dur: '1/2', midi: 60, hand: 'R' },
      { at: '3/2', dur: '1/2', midi: 64, hand: 'R' },
      { at: '1', dur: '1/2', midi: 60, hand: 'L', voice: '5' },
    ],
    measures: 2,
  })
  const passage = { fromOcc: 1, toOcc: 1 }
  const tl = buildTimeline(model, { hands: 'right', range: passage, multiplier: 1 })
  expect(tl.groups[0]!.pitches).not.toContain(60)
  const evs = buildPerformance(model, { hands: 'right', sendPedals: false, range: passageRange(model, passage) })
  expect(onNotes(evs)).toContain(60)
})

it('an untied learner note held across the loop start still suppresses the unison automatic attack', () => {
  const model = makeModel({
    notes: [
      { at: '0', dur: '3/2', midi: 60, hand: 'R' },
      { at: '3/2', dur: '1/2', midi: 64, hand: 'R' },
      { at: '1', dur: '1/2', midi: 60, hand: 'L', voice: '5' },
    ],
    measures: 2,
  })
  const passage = { fromOcc: 1, toOcc: 1 }
  const tl = buildTimeline(model, { hands: 'right', range: passage, multiplier: 1 })
  expect(tl.groups[0]!.pitches).toContain(60)
  const evs = buildPerformance(model, { hands: 'right', sendPedals: false, range: passageRange(model, passage) })
  expect(onNotes(evs)).not.toContain(60)
})
