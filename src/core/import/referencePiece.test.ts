import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IMPORTER_VERSION, ROLL_POLICY_VERSION } from '../model/score'
import { rat, toNumber } from '../music/rational'
import { REFERENCE_PIECE, fixtureExists, importBytes } from '../../../tests/unit/import/fixtures'
import { applyHandAssignment } from './hands'

const present = fixtureExists(REFERENCE_PIECE)

describe.skipIf(!present)('supplied reference piece (tests/fixtures/private)', async () => {
  const bytes = present ? new Uint8Array(readFileSync(REFERENCE_PIECE)) : new Uint8Array()
  const text = new TextDecoder().decode(bytes)
  const result = present ? await importBytes('reference-piece.musicxml', bytes) : undefined
  const model = result!.package.model
  const bar = (n: string) => model.occurrences.find((o) => o.number === n)!

  it('has 59 measure occurrences in written order (no repeats)', () => {
    expect(model.sourceMeasures).toHaveLength(59)
    expect(model.occurrences).toHaveLength(59)
    expect(model.occurrences.every((o, i) => o.sourceMeasure === i && o.pass === 1)).toBe(true)
    expect(toNumber(model.totalDuration)).toBeGreaterThan(50)
  })

  it('drops no notes: every pitched <note> becomes one source and one performed note', () => {
    const pitched = text.match(/<pitch>/g)?.length ?? 0
    expect(pitched).toBe(1353)
    expect(model.sourceNotes).toHaveLength(pitched)
    expect(model.notes).toHaveLength(pitched)
    expect(result!.package.renderXml.match(/<pitch>/g)?.length).toBe(pitched)
    expect(model.unsupported).toEqual([])
  })

  it('has the 8va on staff 1 in bar 3 (its stop is written at the start of bar 4)', () => {
    expect(model.ottavas).toHaveLength(1)
    const o = model.ottavas[0]!
    expect(o).toMatchObject({ staff: 0, size: 8, sounds: 'up', startOcc: 2, endOcc: 2 })
    expect(o.start).toEqual(rat(21, 8))
    expect(o.end).toEqual(rat(3))
    expect(o.notes.length).toBeGreaterThan(0)
    for (const i of o.notes) {
      const n = model.notes[i]!
      expect(n.ottavaShift).toBe(1)
      expect(n.written.octave).toBe(n.sounding.octave - 1)
      expect(n.occ).toBe(2)
    }
    // The first displaced note is G6 sounding, written G5.
    const first = model.notes[o.notes[0]!]!
    expect(first.sounding).toEqual({ step: 'G', alter: 0, octave: 6 })
    expect(first.written).toEqual({ step: 'G', alter: 0, octave: 5 })
    expect(first.midi).toBe(91)
    // Bar 4 is not displaced.
    expect(model.notes.filter((n) => n.occ === 3).every((n) => n.ottavaShift === 0)).toBe(true)
  })

  it('rolls bar 23 as A2–E3–C4 on the lower staff', () => {
    const g = model.arpeggios.find((a) => a.occ === bar('23').index)!
    expect(g.notes.map((i) => model.notes[i]!.midi)).toEqual([45, 52, 60])
    expect(g.crossStaff).toBe(false)
    expect(g.direction).toBe('up')
    expect(g.directionDefaulted).toBe(true)
    expect(g.spreadSec).toBeGreaterThan(0)
    expect(g.spreadSec).toBeLessThanOrEqual(0.12)
    const offsets = g.notes.map((i) => model.notes[i]!.refOffsetSec)
    expect(offsets[0]).toBe(0)
    expect(offsets[2]).toBeCloseTo(g.spreadSec)
  })

  it('has one cross-staff roll group in bar 59', () => {
    const groups = model.arpeggios.filter((a) => a.occ === bar('59').index)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.crossStaff).toBe(true)
    expect(new Set(groups[0]!.notes.map((i) => model.notes[i]!.staff))).toEqual(new Set([0, 1]))
    expect(model.arpeggios).toHaveLength(2)
  })

  it('keeps voice P1:5 as the left hand through its cross-staff run in bar 22, with no confirmation', () => {
    expect(model.hands.ambiguousVoices).toEqual([])
    expect(model.hands.confirmed).toBe(true)
    expect(model.hands.byVoice).toEqual({ 'P1:1': 'R', 'P1:2': 'R', 'P1:5': 'L', 'P1:6': 'L' })
    expect(model.voices.find((v) => v.key === 'P1:5')!.notesPerStaff).toEqual({ 0: 6, 1: 566 })
    expect(model.diagnostics.some((d) => d.code === 'hand-ambiguous')).toBe(false)
    expect(model.diagnostics.find((d) => d.code === 'hand-cross-staff')).toMatchObject({
      severity: 'info',
      measure: '22',
    })
    expect(result!.summary.readiness.hands).toBe(true)
    const confirmed = applyHandAssignment(model, { 'P1:5': 'L' })
    expect(confirmed.hands.confirmed).toBe(true)
    expect(confirmed.meta.rollPolicyVersion).toBe(ROLL_POLICY_VERSION)
  })

  it('starts at quarter = 66 with tempo changes and fermatas reported as timing issues', () => {
    const first = model.tempo.segments[0]!
    expect(first).toMatchObject({ quarterBpm: 66, beatBpm: 66, source: 'both' })
    expect(first.beatUnit).toEqual(rat(1, 4))
    expect(model.tempo.segments.length).toBeGreaterThan(10)
    expect(model.timingIssues.every((t) => t.kind === 'fermata')).toBe(true)
    expect(model.timingIssues.map((t) => model.occurrences[t.occ]!.number)).toEqual(['30', '30', '59'])
    expect(model.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('records versions and renders one measure per occurrence', () => {
    expect(model.meta.importerVersion).toBe(IMPORTER_VERSION)
    expect(model.meta.rollPolicyVersion).toBe(ROLL_POLICY_VERSION)
    expect(model.scoreVersionId).toMatch(/^[0-9a-f]{64}$/)
    const xml = result!.package.renderXml
    expect(xml.match(/<measure /g)).toHaveLength(59)
    expect(xml).not.toContain('<print')
    expect(xml.match(/<octave-shift type="down" size="8" number="1"\/>/g)).toHaveLength(1)
    expect(xml.match(/<octave-shift type="stop"/g)).toHaveLength(1)
  })

  it('assigns the clef at each note (bar 12 lower staff in treble)', () => {
    const lower12 = model.notes.filter((n) => n.occ === bar('12').index && n.staff === 1)
    expect(lower12.length).toBeGreaterThan(0)
    expect(lower12.every((n) => n.clef === 'G2')).toBe(true)
    expect(model.notes.filter((n) => n.occ === 0 && n.staff === 1).every((n) => n.clef === 'F4')).toBe(true)
  })
})
