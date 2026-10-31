import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { rat } from '../music/rational'
import { DiagnosticSink } from './diagnostics'
import { OttavaLookup, sourceOttavaSpans } from './ottava'
import type { RawOttava } from './read/types'
import { el } from './xml'

describe('ottava import consistency (spec acceptance: Ottava import consistency; DECISIONS M1)', async () => {
  const { package: pkg, summary } = await importFixture('ottava.musicxml')
  const model = pkg.model
  const byMidi = (midi: number, occ: number) => model.notes.find((n) => n.midi === midi && n.occ === occ)!

  it('8va: written C4 sounds C5 (displacement applied once, to the written spelling)', () => {
    const c = byMidi(72, 0)
    expect(c.sounding).toEqual({ step: 'C', alter: 0, octave: 5 })
    expect(c.written).toEqual({ step: 'C', alter: 0, octave: 4 })
    expect(c.ottavaShift).toBe(1)
    expect(c.ottava).toBe(0)
  })

  it('15ma, 8vb and 15mb shift by +2, −1 and −2 octaves', () => {
    expect(byMidi(84, 1)).toMatchObject({ ottavaShift: 2, written: { step: 'C', alter: 0, octave: 4 } })
    expect(byMidi(36, 2)).toMatchObject({ ottavaShift: -1, written: { step: 'C', alter: 0, octave: 3 } })
    expect(byMidi(31, 2)).toMatchObject({ ottavaShift: -1, written: { step: 'G', alter: 0, octave: 2 } })
    expect(byMidi(24, 3)).toMatchObject({ ottavaShift: -2, written: { step: 'C', alter: 0, octave: 3 } })
  })

  it('keeps each span on its own staff with half-open performance positions', () => {
    expect(
      model.ottavas.map((o) => [
        o.staff,
        o.size,
        o.sounds,
        `${o.start.n}/${o.start.d}`,
        `${o.end.n}/${o.end.d}`,
        o.startOcc,
        o.endOcc,
      ]),
    ).toEqual([
      [0, 8, 'up', '0/1', '1/1', 0, 0],
      [0, 15, 'up', '3/2', '2/1', 1, 1],
      [1, 8, 'down', '2/1', '3/1', 2, 2],
      [1, 15, 'down', '3/1', '4/1', 3, 3],
    ])
    // Upper-staff notes in bars 3–4 and lower-staff notes in bars 1–2 are never displaced.
    expect(model.notes.filter((n) => n.staff === 0 && n.occ >= 2).every((n) => n.ottavaShift === 0)).toBe(true)
    expect(model.notes.filter((n) => n.staff === 1 && n.occ <= 1).every((n) => n.ottavaShift === 0)).toBe(true)
  })

  it('a tie continuing past the bracket end is not displaced (scope is not extended)', () => {
    const head = byMidi(76, 0)
    const cont = byMidi(76, 1)
    expect(head.ottavaShift).toBe(1)
    expect(cont.tieContinuation).toBe(true)
    expect(cont.ottavaShift).toBe(0)
    expect(cont.written.octave).toBe(5)
    expect(model.ottavas[0]!.notes).toEqual([0, 2, 3])
  })

  it('lists every displaced note in its span and nothing else', () => {
    const listed = new Set(model.ottavas.flatMap((o) => o.notes))
    for (const n of model.notes) expect(listed.has(n.index)).toBe(n.ottavaShift !== 0)
    expect(summary.ottavas.map((o) => [o.label, o.fromBar, o.toBar])).toEqual([
      ['8va', '1', '1'],
      ['15ma', '2', '2'],
      ['8vb', '3', '3'],
      ['15mb', '4', '4'],
    ])
  })

  it('keeps the octave-shift markup (type, size, number) and pitches in the render XML', () => {
    const xml = pkg.renderXml
    expect(xml.match(/<octave-shift [^>]*>/g)).toEqual([
      '<octave-shift type="down" size="8" number="1"/>',
      '<octave-shift type="stop" size="8" number="1"/>',
      '<octave-shift type="down" size="15" number="1"/>',
      '<octave-shift type="stop" size="15" number="1"/>',
      '<octave-shift type="up" size="8" number="1"/>',
      '<octave-shift type="stop" size="8" number="1"/>',
      '<octave-shift type="up" size="15" number="2"/>',
      '<octave-shift type="stop" size="15" number="2"/>',
    ])
    expect(xml).toContain('<pitch><step>C</step><octave>6</octave></pitch>')
    expect(xml).toContain('<pitch><step>C</step><octave>1</octave></pitch>')
  })
})

describe('ottava across a repeat (spans split at jumps, brackets kept balanced)', async () => {
  const { package: pkg } = await importFixture('repeat-ottava.musicxml')
  const model = pkg.model

  it('creates one performed span per contiguous stretch', () => {
    expect(model.occurrences.map((o) => o.number)).toEqual(['1', '2', '3', '4', '2', '3', '5', '6'])
    expect(model.ottavas.map((o) => [o.startOcc, o.endOcc, o.notes.length])).toEqual([
      [2, 3, 2],
      [5, 5, 1],
      [6, 6, 1],
    ])
    expect(model.notes.filter((n) => n.ottavaShift === 1).map((n) => n.occ)).toEqual([2, 3, 5, 6])
    expect(model.notes.filter((n) => n.occ === 7 || n.occ === 4).every((n) => n.ottavaShift === 0)).toBe(true)
  })

  it('closes and reopens brackets at the jumps in the render XML', () => {
    const tokens = pkg.renderXml
      .match(/<measure number="\d+"|<octave-shift type="\w+"/g)!
      .map((t) => t.replace(/<measure number="(\d+)"/, 'm$1').replace(/<octave-shift type="(\w+)"/, '$1'))
    expect(tokens.join(' ')).toBe('m1 m2 m3 down m4 stop m5 m6 down stop m7 down stop m8')
  })
})

describe('ottava pairing diagnostics', () => {
  const measures = [0, 1, 2].map((index) => ({
    index,
    number: String(index + 1),
    implicit: false,
    nominalDuration: rat(1),
    duration: rat(1),
  }))
  const raw = (m: number, type: RawOttava['type'], size = 8, number = '1'): RawOttava => ({
    m,
    at: rat(0),
    staff: 1,
    type,
    size,
    number,
    el: el('octave-shift'),
  })
  const part = { id: 'P1', name: 'Piano', staffOffset: 0 }

  it('runs an unclosed span to the end of the score and warns', () => {
    const diag = new DiagnosticSink()
    const spans = sourceOttavaSpans([raw(1, 'down')], part, measures, diag)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.stop).toEqual({ m: 2, at: rat(1) })
    expect(diag.has('ottava-unclosed')).toBe(true)
  })

  it('ignores an unmatched stop and an unsupported size, with warnings', () => {
    const diag = new DiagnosticSink()
    expect(sourceOttavaSpans([raw(0, 'stop'), raw(1, 'down', 22), raw(2, 'stop', 22)], part, measures, diag)).toEqual(
      [],
    )
    expect(diag.has('ottava-stop-unmatched')).toBe(true)
    expect(diag.has('ottava-size')).toBe(true)
  })

  it('looks up the displacing span by staff and half-open position', () => {
    const spans = sourceOttavaSpans([raw(0, 'down'), raw(1, 'stop')], part, measures, new DiagnosticSink())
    const lookup = new OttavaLookup(spans)
    expect(lookup.find(0, { m: 0, at: rat(1, 2) })?.shift).toBe(1)
    expect(lookup.find(0, { m: 1, at: rat(0) })).toBeUndefined()
    expect(lookup.find(1, { m: 0, at: rat(0) })).toBeUndefined()
  })
})
