import { describe, expect, it } from 'vitest'
import { rat, toString } from '../music/rational'
import { userTempoMap } from '../music/tempo'
import { buildClickTrack } from './clicks'
import { passageRange } from './performance'
import { makeModel } from './testkit'

const show = (cs: ReturnType<typeof buildClickTrack>) => cs.map((c) => `${toString(c.position)}${c.accent ? '!' : ''}`)

describe('buildClickTrack', () => {
  it('clicks quarter beats in 4/4 with an accent on each bar start', () => {
    const model = makeModel({ notes: [{ at: '0', dur: '1/4', midi: 60 }], measures: 2 })
    expect(show(buildClickTrack(model, passageRange(model, null)))).toEqual([
      '0!',
      '1/4',
      '1/2',
      '3/4',
      '1!',
      '5/4',
      '3/2',
      '7/4',
    ])
  })

  it('clicks dotted quarters in 6/8 at "♩. = 60" and eighth-based compound beats without a mark', () => {
    const marked = makeModel({
      notes: [{ at: '0', dur: '1/8', midi: 60 }],
      beats: 6,
      beatType: 8,
      tempo: userTempoMap(60, rat(3, 8)),
    })
    expect(show(buildClickTrack(marked, passageRange(marked, null)))).toEqual(['0!', '3/8'])
    const soundOnly = makeModel({
      notes: [{ at: '0', dur: '1/8', midi: 60 }],
      beats: 6,
      beatType: 8,
      tempo: { segments: [{ start: rat(0), quarterBpm: 90, beatUnit: rat(1, 4), beatBpm: 90, source: 'sound' }] },
    })
    expect(show(buildClickTrack(soundOnly, passageRange(soundOnly, null)))).toEqual(['0!', '3/8'])
  })

  it('places pickup clicks where they fall in a full bar, unaccented', () => {
    const model = makeModel({ notes: [{ at: '0', dur: '1/4', midi: 60 }], pickup: '1/4', measures: 2 })
    expect(show(buildClickTrack(model, passageRange(model, null)))).toEqual(['0', '1/4!', '1/2', '3/4', '1'])
  })

  it('keeps only clicks inside the range', () => {
    const model = makeModel({ notes: [{ at: '0', dur: '1/4', midi: 60 }], measures: 3 })
    expect(show(buildClickTrack(model, passageRange(model, { fromOcc: 1, toOcc: 1 })))).toEqual([
      '1!',
      '5/4',
      '3/2',
      '7/4',
    ])
  })
})
