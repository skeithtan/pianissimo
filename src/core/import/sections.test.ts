import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REFERENCE_PIECE, fixtureExists, importBytes } from '../../../tests/unit/import/fixtures'
import { isSectionHeading, scoreSections } from './sections'
import { ZERO } from '../music/rational'

/** A one-staff 2/4 score: one half note per bar, `extra[i]` written at the start of bar i + 1. */
function score(extra: readonly string[], barlines: Readonly<Record<number, string>> = {}): Uint8Array {
  const measures = extra.map((x, i) => {
    const attrs =
      i === 0
        ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><sound tempo="60"/>'
        : ''
    return `<measure number="${i + 1}">${attrs}${x}<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>${barlines[i] ?? ''}</measure>`
  })
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`
  return new TextEncoder().encode(xml)
}

const rehearsal = (text: string) =>
  `<direction placement="above"><direction-type><rehearsal>${text}</rehearsal></direction-type></direction>`
const words = (text: string, attrs = 'font-style="normal"', placement = 'above') =>
  `<direction placement="${placement}"><direction-type><words ${attrs}>${text}</words></direction-type></direction>`
const REPEAT_START = '<barline location="left"><repeat direction="forward"/></barline>'
const REPEAT_END = '<barline location="right"><repeat direction="backward"/></barline>'

describe('section headings (DECISIONS I12)', () => {
  it('accepts emphasized upright headings above the staff', () => {
    expect(isSectionHeading('Verse', { placement: 'above', fontStyle: 'normal' })).toBe(true)
    expect(isSectionHeading('Chorus', { placement: 'above', fontStyle: 'normal' })).toBe(true)
    expect(isSectionHeading('Chorus', { placement: 'above', fontWeight: 'bold' })).toBe(true)
    expect(isSectionHeading('B', { placement: 'above', enclosure: 'rectangle' })).toBe(true)
    expect(isSectionHeading('Coda', { placement: 'above', fontStyle: 'normal' })).toBe(true)
  })

  it('rejects expression, tempo, hand, ottava and navigation words, and unstyled or misplaced text', () => {
    const style = { placement: 'above', fontStyle: 'normal' }
    for (const t of [
      'rit.',
      'Allegro',
      'a tempo',
      'Tempo I',
      'cresc.',
      'Espressivo',
      'L.H.',
      'R.H. over',
      '8va',
      'D.S. al Coda',
      'Fine',
      'To Coda',
      '3+3+2',
      'dolce',
    ]) {
      expect(isSectionHeading(t, style), t).toBe(false)
    }
    expect(isSectionHeading('Verse', { placement: 'above', fontStyle: 'italic' })).toBe(false)
    expect(isSectionHeading('Verse', { placement: 'above' })).toBe(false)
    expect(isSectionHeading('Verse', { placement: 'below', fontStyle: 'normal' })).toBe(false)
    expect(isSectionHeading('A very long sentence that is certainly not a heading at all', style)).toBe(false)
  })

  it('maps marks to every performed pass of their bar, rehearsal marks first', () => {
    const occurrences = [0, 1, 2, 1, 2, 3].map((sourceMeasure, index) => ({ index, sourceMeasure }))
    const marks = [
      { m: 1, at: ZERO, label: 'Verse', source: 'words' as const },
      { m: 1, at: ZERO, label: 'A', source: 'rehearsal' as const },
      { m: 3, at: ZERO, label: ' Coda ', source: 'words' as const },
    ]
    expect(scoreSections(marks, occurrences)).toEqual([
      { occ: 1, label: 'A' },
      { occ: 3, label: 'A' },
      { occ: 5, label: 'Coda' },
    ])
    expect(scoreSections([], occurrences)).toEqual([])
  })
})

describe('sections in imported scores', () => {
  it('reads rehearsal marks and heading words, per repeat pass', async () => {
    // Bars 1 2 |: 3 4 :| 5 → performed 1 2 3 4 3 4 5.
    const bytes = score(
      [
        rehearsal('A'),
        words('dolce', 'font-style="italic"'),
        words('Verse') + REPEAT_START,
        '',
        words('Allegro', 'font-weight="bold"'),
      ],
      {
        3: REPEAT_END,
      },
    )
    const model = (await importBytes('sections.musicxml', bytes)).package.model
    expect(model.sections).toEqual(
      model.occurrences
        .filter((o) => o.sourceMeasure === 0 || o.sourceMeasure === 2)
        .map((o) => ({ occ: o.index, label: o.sourceMeasure === 0 ? 'A' : 'Verse' })),
    )
    expect(model.sections!.filter((s) => s.label === 'Verse')).toHaveLength(2)
  })

  it('leaves the field out when the score has no sections', async () => {
    const model = (await importBytes('plain.musicxml', score(['', words('rit.', 'font-style="italic"')]))).package.model
    expect(model.sections).toBeUndefined()
    expect('sections' in model).toBe(false)
  })
})

describe.skipIf(!fixtureExists(REFERENCE_PIECE))('sections in the supplied reference piece', () => {
  it('finds the song headings', async () => {
    const bytes = new Uint8Array(readFileSync(REFERENCE_PIECE))
    const model = (await importBytes('reference-piece.musicxml', bytes)).package.model
    const labels = (model.sections ?? []).map((s) => `${model.occurrences[s.occ]!.number}:${s.label}`)
    expect(labels).toContain('2:Yume Tōrō')
    expect(labels.some((l) => l.startsWith('6:'))).toBe(true) // a titled section starts at bar 6
    expect(labels).toContain('31:Dēto')
    expect(labels.some((l) => l.endsWith(':Coda'))).toBe(true)
    expect(labels.every((l) => !/rit|Gently|Espressivo|L\.H\./.test(l))).toBe(true)
  })
})
