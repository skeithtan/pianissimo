import { describe, expect, it } from 'vitest'
import type { PartRef, StaffDef, VoiceDef } from '../model/score'
import { conventionalParts, conventionStaff, homeStaff, isCrossStaff, proposeHands, SPLIT_SHARE } from './hands'

const parts: PartRef[] = [{ id: 'P1', name: 'Piano', staffCount: 2 }]
const staves: StaffDef[] = [
  { index: 0, partId: 'P1', staffNumber: 1 },
  { index: 1, partId: 'P1', staffNumber: 2 },
]
const voice = (voice: string, notesPerStaff: Record<number, number>, partId = 'P1'): VoiceDef => ({
  key: `${partId}:${voice}`,
  partId,
  voice,
  notesPerStaff,
})

describe('proposeHands (DECISIONS M2)', () => {
  it('assigns single-staff voices by staff and never marks them ambiguous', () => {
    const hands = proposeHands([voice('1', { 0: 10 }), voice('2', { 1: 10 })], parts, staves)
    expect(hands).toEqual({ byVoice: { 'P1:1': 'R', 'P1:2': 'L' }, ambiguousVoices: [], confirmed: true })
  })

  it('keeps a cross-staff voice on its home staff when the 1–4 / 5–8 numbering agrees, whatever the share', () => {
    const voices = [voice('1', { 0: 100 }), voice('5', { 0: 45, 1: 55 })]
    expect(conventionStaff(voices[1]!, parts, staves)).toBe(1)
    expect(homeStaff(voices[1]!)).toBe(1)
    expect(isCrossStaff(voices[1]!)).toBe(true)
    expect([...conventionalParts(voices, parts, staves)]).toEqual(['P1'])
    expect(proposeHands(voices, parts, staves)).toEqual({
      byVoice: { 'P1:1': 'R', 'P1:5': 'L' },
      ambiguousVoices: [],
      confirmed: true,
    })
  })

  it('falls back to the minority share when the numbering is sequential (Dorico style)', () => {
    const excursion = [voice('1', { 0: 100 }), voice('2', { 0: 5, 1: 95 })]
    expect(conventionalParts(excursion, parts, staves).size).toBe(0)
    expect(proposeHands(excursion, parts, staves)).toEqual({
      byVoice: { 'P1:1': 'R', 'P1:2': 'L' },
      ambiguousVoices: [],
      confirmed: true,
    })
    const split = [voice('1', { 0: 100 }), voice('2', { 0: 40, 1: 60 })]
    expect(proposeHands(split, parts, staves)).toEqual({
      byVoice: { 'P1:1': 'R', 'P1:2': 'L' },
      ambiguousVoices: ['P1:2'],
      confirmed: false,
    })
  })

  it('treats exactly a third on the minority staff as split', () => {
    const atShare = [voice('1', { 0: 100 }), voice('2', { 0: 1, 1: 2 })]
    expect(1 / 3).toBe(SPLIT_SHARE)
    expect(proposeHands(atShare, parts, staves).ambiguousVoices).toEqual(['P1:2'])
  })

  it('marks a conventionally numbered voice ambiguous when its home staff contradicts the numbering', () => {
    // Voice 5 mostly on the upper staff: the part's numbering cannot be trusted, and the split is wide.
    const voices = [voice('1', { 0: 100 }), voice('5', { 0: 60, 1: 40 })]
    expect(proposeHands(voices, parts, staves)).toEqual({
      byVoice: { 'P1:1': 'R', 'P1:5': 'R' },
      ambiguousVoices: ['P1:5'],
      confirmed: false,
    })
  })

  it('prefers the upper staff on a tie and asks when the numbering gives no help', () => {
    const voices = [voice('a', { 0: 4, 1: 4 })]
    expect(conventionStaff(voices[0]!, parts, staves)).toBeUndefined()
    expect(proposeHands(voices, parts, staves)).toEqual({
      byVoice: { 'P1:a': 'R' },
      ambiguousVoices: ['P1:a'],
      confirmed: false,
    })
  })

  it('ignores the numbering convention for one-staff and three-staff parts', () => {
    const one: PartRef[] = [{ id: 'P1', name: 'Piano', staffCount: 1 }]
    expect(conventionStaff(voice('5', { 0: 3 }), one, [{ index: 0, partId: 'P1', staffNumber: 1 }])).toBeUndefined()
    const three: PartRef[] = [{ id: 'P1', name: 'Organ', staffCount: 3 }]
    const threeStaves: StaffDef[] = [0, 1, 2].map((i) => ({ index: i, partId: 'P1', staffNumber: i + 1 }))
    expect(conventionStaff(voice('5', { 1: 3 }), three, threeStaves)).toBeUndefined()
  })

  it('works without part information (share rule only)', () => {
    expect(proposeHands([voice('5', { 0: 1, 1: 9 })])).toEqual({
      byVoice: { 'P1:5': 'L' },
      ambiguousVoices: [],
      confirmed: true,
    })
  })
})
