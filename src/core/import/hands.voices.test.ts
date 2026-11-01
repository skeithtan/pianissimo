import { describe, expect, it } from 'vitest'
import { importBytes, scoreXml, utf8 } from '../../../tests/unit/import/fixtures'

const note = (step: string, octave: number, staff: number, voice?: string) =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>1</duration>${voice ? `<voice>${voice}</voice>` : ''}<type>quarter</type><staff>${staff}</staff></note>`

const bar = (n: number, rh: string[], lh: string[]) =>
  `<measure number="${n}">${n === 1 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>' : ''}${rh.join('')}<backup><duration>4</duration></backup>${lh.join('')}</measure>`

/** Two bars of a piano part: four right-hand quarters per bar, seven left-hand quarters in all. */
function piano(voice?: (staff: number) => string): string {
  const v = voice ?? (() => undefined)
  const rh = [note('C', 5, 1, v(1)), note('D', 5, 1, v(1)), note('E', 5, 1, v(1)), note('F', 5, 1, v(1))]
  const lh = [note('C', 3, 2, v(2)), note('D', 3, 2, v(2)), note('E', 3, 2, v(2))]
  return scoreXml(
    `<part id="P1">${bar(1, rh, [...lh, note('F', 3, 2, v(2))])}${bar(2, rh, [...lh, '<forward><duration>1</duration></forward>'])}</part>`,
  )
}

describe('hands for parts without usable voice numbers (DECISIONS M2)', () => {
  it('a piano part without <voice> elements does not put the bass staff in the right hand', async () => {
    const { package: pkg, summary } = await importBytes('novoice.musicxml', utf8(piano()))
    const m = pkg.model
    const lhHands = m.notes.filter((n) => n.staffNumber === 2).map((n) => n.hand)
    expect(lhHands.length).toBe(7)
    expect(lhHands.every((h) => h === 'L')).toBe(true)
    expect(m.notes.filter((n) => n.staffNumber === 1).every((n) => n.hand === 'R')).toBe(true)
    expect(m.hands.confirmed).toBe(true)
    expect(m.hands.byVoice).toEqual({ 'P1:1': 'R', 'P1:5': 'L' })
    expect(m.voices.map((v) => v.key)).toEqual(['P1:1', 'P1:5'])
    expect(summary.voices.map((v) => v.voice)).toEqual(['1', '5'])
    // The engraver reads the same voices: bass notes carry the synthesized voice 5.
    expect(pkg.renderXml.match(/<voice>5<\/voice>/g)?.length).toBe(7)
    expect(pkg.renderXml).not.toContain('<voice>1</voice>')
    expect(m.diagnostics.some((d) => d.code === 'voice-underfull' || d.code === 'voice-overfull')).toBe(false)
  })

  it('an explicit voice 1 on both staves asks which hand plays it instead of guessing', async () => {
    const m = (await importBytes('voice1.musicxml', utf8(piano(() => '1')))).package.model
    expect(m.voices.map((v) => v.key)).toEqual(['P1:1'])
    expect(m.hands.ambiguousVoices).toEqual(['P1:1'])
    expect(m.hands.confirmed).toBe(false)
    expect(m.diagnostics.some((d) => d.code === 'hand-ambiguous')).toBe(true)
  })

  it('a single-staff part without <voice> keeps voice 1 and an unchanged engraving', async () => {
    const xml = scoreXml(
      `<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note></measure></part>`,
    )
    const pkg = (await importBytes('single.musicxml', utf8(xml))).package
    expect(pkg.model.voices.map((v) => v.key)).toEqual(['P1:1'])
    expect(pkg.renderXml).not.toContain('<voice>')
  })
})
