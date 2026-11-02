import { describe, expect, it } from 'vitest'
import { importFixture, inspectFixture } from '../../../tests/unit/import/fixtures'
import { DEFAULT_SETTINGS } from '../model/settings'
import { labelText } from '../naming/label'
import { rat } from '../music/rational'
import { IMPORTER_VERSION, ROLL_POLICY_VERSION, type ScoreModel } from '../model/score'
import { applyHandAssignment } from './hands'

const notesAt = (model: ScoreModel, occ: number) => model.notes.filter((n) => n.occ === occ)
const midis = (model: ScoreModel, occ: number) => notesAt(model, occ).map((n) => n.midi)

describe('import mapping: simultaneous hands and chords', async () => {
  const { package: pkg, summary } = await importFixture('two-hands.musicxml')
  const model = pkg.model

  it('maps both staves to performed notes sorted by onset, staff, pitch', () => {
    expect(model.staves).toEqual([
      { index: 0, partId: 'P1', staffNumber: 1 },
      { index: 1, partId: 'P1', staffNumber: 2 },
    ])
    expect(model.notes.map((n) => [n.midi, n.staff, n.onset.n, n.onset.d])).toEqual([
      [60, 0, 0, 1],
      [48, 1, 0, 1],
      [62, 0, 1, 4],
      [64, 0, 1, 2],
      [65, 0, 3, 4],
      [67, 0, 1, 1],
      [71, 0, 1, 1],
      [74, 0, 1, 1],
      [43, 1, 1, 1],
      [48, 1, 3, 2],
    ])
    expect(model.notes.every((n, i) => n.index === i && n.id === `${n.occ}:${n.src}`)).toBe(true)
    expect(model.notes.every((n) => n.tieHead === n.index && !n.tieContinuation)).toBe(true)
  })

  it('assigns hands per voice (voice 1 upper staff → right, voice 5 lower staff → left)', () => {
    expect(model.hands).toEqual({ byVoice: { 'P1:1': 'R', 'P1:5': 'L' }, ambiguousVoices: [], confirmed: true })
    expect(model.notes.filter((n) => n.staff === 0).every((n) => n.hand === 'R')).toBe(true)
    expect(model.notes.filter((n) => n.staff === 1).every((n) => n.hand === 'L')).toBe(true)
  })

  it('keeps the block chord on one onset and counts it', () => {
    expect(model.notes.filter((n) => n.occ === 1 && n.staff === 0).map((n) => n.midi)).toEqual([67, 71, 74])
    expect(summary.counts.chords).toBe(1)
  })

  it('reads tempo, velocity, measures and metadata', () => {
    expect(model.tempo.segments).toEqual([
      { start: rat(0), quarterBpm: 60, beatUnit: rat(1, 4), beatBpm: 60, source: 'both' },
    ])
    expect(model.notes.every((n) => n.velocity === 80)).toBe(true)
    expect(model.dynamics).toEqual([{ at: rat(0), occ: 0, staff: 0, velocity: 80, text: 'mf' }])
    expect(model.totalDuration).toEqual(rat(2))
    expect(model.meta).toMatchObject({
      title: 'Two Hands',
      composer: 'Pianissimo fixtures',
      packaging: 'musicxml',
      musicXmlVersion: '4.0',
      importerVersion: IMPORTER_VERSION,
      rollPolicyVersion: ROLL_POLICY_VERSION,
      importedAt: 0,
    })
    expect(model.parts).toEqual([{ id: 'P1', name: 'Piano', staffCount: 2 }])
    expect(model.diagnostics).toEqual([])
    expect(summary.readiness).toEqual({ tempo: true, hands: true, scoredPractice: true, blockers: [] })
  })
})

describe('import mapping: unequal hand rhythms and a second voice', async () => {
  const model = (await importFixture('unequal-rhythms.musicxml')).package.model

  it('places dotted left-hand notes between right-hand eighths', () => {
    const lower = model.notes.filter((n) => n.occ === 0 && n.staff === 1)
    expect(lower.map((n) => [n.midi, n.onset.n, n.onset.d])).toEqual([
      [48, 0, 1],
      [55, 3, 8],
      [52, 1, 2],
    ])
    expect(notesAt(model, 0).filter((n) => n.staff === 0)).toHaveLength(8)
  })

  it('positions a voice entering after <backup> and its 16ths', () => {
    const v2 = model.notes.filter((n) => n.voice === '2')
    expect(v2.map((n) => [n.midi, n.onset.n, n.onset.d])).toEqual([
      [76, 3, 2],
      [74, 27, 16],
      [72, 7, 4],
    ])
    expect(v2.every((n) => n.hand === 'R')).toBe(true)
    expect(model.voices.map((v) => v.key)).toEqual(['P1:1', 'P1:5', 'P1:2'])
  })
})

describe('ties across bars', async () => {
  const model = (await importFixture('ties.musicxml')).package.model

  it('chains E5 half + quarter + quarter into one attack with the total sounding duration', () => {
    const e5 = model.notes.filter((n) => n.midi === 76)
    expect(e5.map((n) => n.tieContinuation)).toEqual([false, true, true])
    expect(e5.every((n) => n.tieHead === e5[0]!.index)).toBe(true)
    expect(e5[0]!.soundingDuration).toEqual(rat(1))
    expect(e5[1]!.soundingDuration).toEqual(rat(1, 4))
  })

  it('ties only the chord member marked tied; the other is struck again', () => {
    const bar2Lower = model.notes.filter((n) => n.occ === 1 && n.staff === 1 && n.onset.n === 1 && n.onset.d === 1)
    expect(bar2Lower.map((n) => [n.midi, n.tieContinuation])).toEqual([
      [48, false],
      [55, true],
    ])
    const g3Head = model.notes.find((n) => n.midi === 55 && n.occ === 0)!
    expect(g3Head.soundingDuration).toEqual(rat(3, 2))
    expect(model.diagnostics.filter((d) => d.code === 'tie-unmatched')).toEqual([])
  })
})

describe('pickup bar', async () => {
  const model = (await importFixture('pickup.musicxml')).package.model

  it('keeps the implicit pickup short and starts bar 1 after it', () => {
    expect(model.sourceMeasures[0]).toMatchObject({ number: '0', implicit: true })
    expect(model.sourceMeasures[0]!.duration).toEqual(rat(1, 4))
    expect(model.sourceMeasures[0]!.nominalDuration).toEqual(rat(3, 4))
    expect(model.occurrences.map((o) => [o.number, o.start.n, o.start.d])).toEqual([
      ['0', 0, 1],
      ['1', 1, 4],
      ['2', 1, 1],
    ])
    expect(model.totalDuration).toEqual(rat(3, 2))
    expect(model.diagnostics.filter((d) => d.code === 'measure-underfull')).toEqual([])
  })

  it('applies the G-major key to accidental context', () => {
    expect(model.notes.every((n) => n.accidentalContext.keyFifths === 1)).toBe(true)
    expect(model.notes.find((n) => n.midi === 78)!.sounding).toEqual({ step: 'F', alter: 1, octave: 5 })
  })
})

describe('tuplets', async () => {
  const { package: pkg, summary } = await importFixture('tuplets.musicxml')
  const model = pkg.model

  it('places triplet and quintuplet notes exactly', () => {
    const upper = model.notes.filter((n) => n.staff === 0)
    expect(upper.map((n) => `${n.onset.n}/${n.onset.d}`)).toEqual([
      '0/1',
      '1/12',
      '1/6',
      '1/4',
      '1/2',
      '11/20',
      '3/5',
      '13/20',
      '7/10',
    ])
    expect(upper[0]!.duration).toEqual(rat(1, 12))
    expect(upper[4]!.duration).toEqual(rat(1, 20))
    expect(summary.counts.tupletNotes).toBe(8)
  })
})

describe('shared pitch in two voices', async () => {
  const model = (await importFixture('shared-pitch.musicxml')).package.model

  it('keeps both notes (one per voice) at the same onset and pitch', () => {
    const e4 = model.notes.filter((n) => n.midi === 64)
    expect(e4).toHaveLength(2)
    expect(e4.map((n) => n.voice).sort()).toEqual(['1', '2'])
    expect(e4[0]!.onset).toEqual(e4[1]!.onset)
    expect(e4.map((n) => n.duration)).toContainEqual(rat(1, 2))
    expect(e4.every((n) => n.hand === 'R')).toBe(true)
  })
})

describe('C♯ major with B♯4 and carried accidentals', async () => {
  const model = (await importFixture('csharp-major.musicxml')).package.model
  const upper = model.notes.filter((n) => n.staff === 0)

  it('keeps the written spelling and resolves the sounding key', () => {
    expect(upper[0]!.sounding).toEqual({ step: 'B', alter: 1, octave: 4 })
    expect(upper[0]!.midi).toBe(72)
    expect(upper[1]!.midi).toBe(73)
    expect(upper.map((n) => n.midi)).toEqual([72, 73, 65, 65, 65, 66])
    expect(upper[4]!.sounding).toEqual({ step: 'E', alter: 1, octave: 4 })
    expect(upper[2]!.accidentalContext).toEqual({ keyFifths: 7, carried: [] })
  })

  it('carries the natural through the bar and resets it at the barline', () => {
    expect(upper[3]!.accidentalContext).toEqual({ keyFifths: 7, carried: [['F', 4, 0]] })
    expect(upper[5]!.accidentalContext).toEqual({ keyFifths: 7, carried: [] })
  })

  it('names B♯4 as C♮5 with contextual accidentals and simplification (spec: Hint preference combinations)', () => {
    const naming = {
      ...DEFAULT_SETTINGS.naming,
      alwaysShowEffectiveAccidentals: false,
      simplifyEnharmonics: true,
      showOctave: true,
    }
    expect(labelText(upper[0]!, naming)).toBe('C♮5')
    expect(labelText(upper[3]!, naming)).toBe('F4')
    expect(labelText(upper[5]!, { ...naming, simplifyEnharmonics: false })).toBe('F4')
  })
})

describe('key, meter and clef changes, pedals, dynamics and fingering', async () => {
  const model = (await importFixture('changes.musicxml')).package.model

  it('emits key and meter changes at their performance positions', () => {
    expect(model.keys.map((k) => [k.occ, k.fifths])).toEqual([
      [0, 0],
      [1, 2],
    ])
    expect(model.meters.map((m) => [m.occ, m.beats, m.beatType])).toEqual([
      [0, 4, 4],
      [2, 3, 4],
    ])
    expect(model.sourceMeasures[2]!.duration).toEqual(rat(3, 4))
  })

  it('switches the lower staff clef mid-bar and gives each note its governing clef', () => {
    expect(model.clefs.map((c) => [c.occ, c.staff, c.key, `${c.at.n}/${c.at.d}`])).toEqual([
      [0, 0, 'G2', '0/1'],
      [0, 1, 'F4', '0/1'],
      [1, 1, 'G2', '3/2'],
    ])
    const lower2 = model.notes.filter((n) => n.occ === 1 && n.staff === 1)
    expect(lower2.map((n) => n.clef)).toEqual(['F4', 'G2'])
  })

  it('reads pedal marks (sustain start/change/stop, sostenuto from playback attributes)', () => {
    expect(model.pedals.map((p) => [p.kind, p.type, `${p.at.n}/${p.at.d}`])).toEqual([
      ['sustain', 'start', '0/1'],
      ['sustain', 'change', '3/2'],
      ['sostenuto', 'start', '2/1'],
      ['sustain', 'stop', '11/4'],
    ])
  })

  it('derives velocities from sound dynamics (× 0.9) and from bare marks', () => {
    expect(model.notes.filter((n) => n.occ < 2).every((n) => n.velocity === 49)).toBe(true)
    expect(model.notes.filter((n) => n.occ === 2).every((n) => n.velocity === 96)).toBe(true)
    expect(model.dynamics.map((d) => [d.text, d.velocity])).toEqual([
      ['p', 49],
      ['f', 96],
    ])
  })

  it('keeps fingering', () => {
    expect(model.notes.find((n) => n.occ === 2 && n.staff === 0)!.fingering).toBe('3')
    expect(model.sourceNotes.filter((n) => n.fingering !== undefined)).toHaveLength(1)
  })
})

describe('unsupported content is marked, never dropped (DECISIONS M4)', async () => {
  const model = (await importFixture('unsupported.musicxml')).package.model

  it('reports grace, ornament, tremolo and microtone bars as unsupported regions', () => {
    expect(model.unsupported.map((r) => [r.kind, r.fromOcc, r.toOcc])).toEqual([
      ['grace', 1, 1],
      ['ornament', 2, 2],
      ['tremolo', 3, 3],
      ['microtone', 4, 4],
    ])
    expect(model.unsupported[1]!.message).toContain('trill-mark')
    expect(model.diagnostics.filter((d) => d.code.startsWith('unsupported-')).map((d) => d.measure)).toEqual([
      '2',
      '3',
      '4',
      '5',
    ])
  })

  it('keeps the grace note as a performed note flagged grace, with no duration', () => {
    const grace = model.notes.filter((n) => n.grace)
    expect(grace).toHaveLength(1)
    expect(grace[0]!.midi).toBe(71)
    expect(grace[0]!.duration).toEqual(rat(0))
    expect(model.notes).toHaveLength(13)
  })
})

describe('cue notes are engraved but never performed (DECISIONS I13)', async () => {
  const { package: pkg, summary } = await importFixture('cue-notes.musicxml')
  const model = pkg.model

  it('flags them, keeps the bar supported and counts them in the summary', () => {
    expect(model.notes.filter((n) => n.cue).map((n) => [n.occ, n.midi])).toEqual([
      [1, 67],
      [1, 71],
    ])
    expect(
      midis(model, 1)
        .filter((_, i) => !notesAt(model, 1)[i]!.cue)
        .sort((a, b) => a - b),
    ).toEqual([43, 48, 62])
    expect(model.unsupported).toEqual([])
    expect(summary.counts.cueNotes).toBe(2)
    expect(summary.counts.performedNotes).toBe(8)
  })
})

describe('cross-staff voices keep the hand of their home staff (DECISIONS M2)', async () => {
  const { package: pkg, summary } = await importFixture('cross-staff.musicxml')
  const model = pkg.model

  it('assigns the home staff hand without confirmation and notes the excursion', () => {
    expect(model.voices.find((v) => v.key === 'P1:5')!.notesPerStaff).toEqual({ 0: 2, 1: 6 })
    expect(model.hands.ambiguousVoices).toEqual([])
    expect(model.hands.confirmed).toBe(true)
    expect(model.notes.filter((n) => n.voice === '5').every((n) => n.hand === 'L')).toBe(true)
    expect(summary.readiness.hands).toBe(true)
    expect(summary.readiness.scoredPractice).toBe(true)
    const note = model.diagnostics.find((d) => d.code === 'hand-cross-staff')
    expect(note).toMatchObject({ severity: 'info', measure: '2' })
    expect(note!.message).toMatch(
      /Voice 5 of “Piano” is the left hand, and 2 of its notes are written on the other staff \(bar 2\)/,
    )
    expect(model.diagnostics.some((d) => d.code === 'hand-ambiguous')).toBe(false)
    const v5 = summary.voices.find((v) => v.key === 'P1:5')!
    expect(v5).toMatchObject({ hand: 'L', homeStaff: 1, crossStaffBars: ['2'], ambiguous: false })
  })

  it('applyHandAssignment re-hands every note of the voice and confirms', () => {
    const confirmed = applyHandAssignment(model, { 'P1:5': 'R' })
    expect(confirmed.hands.confirmed).toBe(true)
    expect(confirmed.hands.byVoice['P1:5']).toBe('R')
    expect(confirmed.notes.filter((n) => n.voice === '5').every((n) => n.hand === 'R')).toBe(true)
    expect(confirmed.diagnostics.some((d) => d.code === 'hand-ambiguous')).toBe(false)
    expect(confirmed.meta.rollPolicyVersion).toBe(ROLL_POLICY_VERSION)
    expect(confirmed.meta.importerVersion).toBe(IMPORTER_VERSION)
    expect(confirmed.scoreVersionId).toBe(model.scoreVersionId)
  })

  it('applyHandAssignment rejects unknown voices and invalid hands', () => {
    expect(() => applyHandAssignment(model, { 'P1:9': 'L' })).toThrow(RangeError)
    expect(() => applyHandAssignment(model, { 'P1:5': 'X' as 'L' })).toThrow(RangeError)
  })
})

describe("a voice split between the staves needs the user's choice (spec: ambiguous hand assignments require confirmation)", async () => {
  const { package: pkg, summary } = await importFixture('split-voice.musicxml')
  const model = pkg.model

  it('proposes the home staff hand but marks the voice ambiguous and blocks scored practice', () => {
    expect(model.voices.find((v) => v.key === 'P1:2')!.notesPerStaff).toEqual({ 0: 3, 1: 5 })
    expect(model.hands.ambiguousVoices).toEqual(['P1:2'])
    expect(model.hands.confirmed).toBe(false)
    expect(model.hands.byVoice).toEqual({ 'P1:1': 'R', 'P1:2': 'L' })
    expect(model.notes.filter((n) => n.voice === '2').every((n) => n.hand === 'L')).toBe(true)
    expect(summary.readiness.hands).toBe(false)
    expect(summary.readiness.scoredPractice).toBe(false)
    expect(summary.readiness.blockers[0]).toMatch(/Choose which hand plays voice 2 of Piano/)
    const warning = model.diagnostics.find((d) => d.code === 'hand-ambiguous')
    expect(warning).toMatchObject({ severity: 'warning', measure: '2' })
    expect(summary.voices.find((v) => v.key === 'P1:2')).toMatchObject({ ambiguous: true, crossStaffBars: ['2'] })
  })

  it('applyHandAssignment confirms and clears the warning', () => {
    const confirmed = applyHandAssignment(model, { 'P1:2': 'R' })
    expect(confirmed.hands.confirmed).toBe(true)
    expect(confirmed.notes.filter((n) => n.voice === '2').every((n) => n.hand === 'R')).toBe(true)
    expect(confirmed.diagnostics.some((d) => d.code === 'hand-ambiguous')).toBe(false)
    expect(model.hands.confirmed).toBe(false)
  })
})

describe('two one-staff piano parts', async () => {
  it('suggests the two piano parts (right hand on top) and reads tempo from the unselected voice part', async () => {
    const inspected = await inspectFixture('two-parts.musicxml')
    const c = inspected.candidates[0]!
    expect(c.parts.map((p) => [p.id, p.name, p.staves, p.pianoLike])).toEqual([
      ['P1', 'Voice', 1, false],
      ['P2', 'Piano RH', 1, true],
      ['P3', 'Piano LH', 1, true],
    ])
    expect(c.suggestedParts).toEqual(['P2', 'P3'])
    const model = (await importFixture('two-parts.musicxml')).package.model
    expect(model.staves.map((s) => [s.index, s.partId, s.staffNumber])).toEqual([
      [0, 'P2', 1],
      [1, 'P3', 1],
    ])
    expect(model.hands.byVoice).toEqual({ 'P2:1': 'R', 'P3:1': 'L' })
    expect(model.tempo.segments[0]).toMatchObject({ quarterBpm: 80, beatBpm: 40, beatUnit: rat(1, 2) })
    expect(midis(model, 1)).toEqual([77, 43, 47])
  })

  it('builds the same score whatever order the parts are selected in', async () => {
    const a = (await importFixture('two-parts.musicxml', { partIds: ['P3', 'P2'] })).package.model
    expect(a.staves.map((s) => s.partId)).toEqual(['P2', 'P3'])
  })

  it('refuses invalid selections with a reason', async () => {
    await expect(importFixture('two-parts.musicxml', { partIds: ['P1', 'P2', 'P3'] })).rejects.toMatchObject({
      code: 'selection-invalid',
    })
    await expect(importFixture('two-parts.musicxml', { partIds: [] })).rejects.toMatchObject({
      code: 'selection-invalid',
    })
    await expect(importFixture('two-parts.musicxml', { partIds: ['P9'] })).rejects.toMatchObject({
      code: 'selection-invalid',
    })
  })

  it('keeps only the selected parts (and their brace) in the render XML', async () => {
    const xml = (await importFixture('two-parts.musicxml')).package.renderXml
    expect(xml).not.toContain('id="P1"')
    expect(xml).toContain('<score-part id="P2">')
    expect(xml).toContain('<part-group type="start" number="1">')
  })
})
