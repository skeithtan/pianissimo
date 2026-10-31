import { describe, expect, it } from 'vitest'
import { importBytes, importFixture, scoreXml, utf8 } from '../../../tests/unit/import/fixtures'
import { DEFAULT_IMPORT_LIMITS } from './limits'
import { attr, child, childrenNamed, elements, parseXmlDocument, textOf, type XmlElement } from './xml'

function parse(xml: string): XmlElement {
  return parseXmlDocument(xml, DEFAULT_IMPORT_LIMITS)
}

function measuresOf(xml: string): XmlElement[] {
  return childrenNamed(child(parse(xml), 'part')!, 'measure')
}

describe('render XML (ScorePackage.renderXml; DECISIONS M5, R1)', async () => {
  const repeats = await importFixture('repeats.musicxml')
  const xml = repeats.package.renderXml
  const measures = measuresOf(xml)

  it('is well-formed partwise MusicXML with one uniquely numbered measure per occurrence', () => {
    const root = parse(xml)
    expect(root.name).toBe('score-partwise')
    expect(attr(root, 'version')).toBe('4.0')
    expect(measures).toHaveLength(repeats.package.model.occurrences.length)
    expect(measures.map((m) => attr(m, 'number'))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('drops repeat and ending barlines but keeps the final barline', () => {
    expect(xml).not.toMatch(/<repeat|<ending/)
    expect(xml.match(/<barline/g)).toHaveLength(1)
    expect(xml).toContain('<bar-style>light-heavy</bar-style>')
  })

  it('keeps each occurrence’s notes in performance order with unchanged pitches', () => {
    const firstPitch = measures.map((m) => {
      const p = child(childrenNamed(m, 'note')[0]!, 'pitch')!
      return `${textOf(child(p, 'step'))}${textOf(child(p, 'octave'))}`
    })
    expect(firstPitch).toEqual(['C5', 'D5', 'E5', 'G5', 'D5', 'E5', 'G5', 'C6'])
  })

  it('restates the bass clef where the repeat jumps back after the treble-clef ending', () => {
    const fifth = measures[4]!
    const attrs = child(fifth, 'attributes')!
    expect(
      childrenNamed(attrs, 'clef').map((c) => `${attr(c, 'number')}:${childrenNamed(c, 'sign')[0]!.children[0]}`),
    ).toEqual(['2:F'])
    // The second ending keeps its own clef element (no duplicate).
    const seventh = measures[6]!
    expect(childrenNamed(child(seventh, 'attributes')!, 'clef')).toHaveLength(1)
    // Adjacent bars get nothing extra.
    expect(child(measures[5]!, 'attributes')).toBeUndefined()
  })

  it('removes print layout and page credits, keeps work/identification', async () => {
    const two = await importFixture('two-hands.musicxml')
    expect(two.package.renderXml).not.toContain('<print')
    expect(two.package.renderXml).not.toContain('<credit')
    expect(two.package.renderXml).toContain('<work-title>Two Hands</work-title>')
  })

  it('removes multi-measure rest styles so every occurrence is engraved as its own bar', async () => {
    const doc = scoreXml(
      `<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef><measure-style><multiple-rest>2</multiple-rest></measure-style></attributes><note><rest measure="yes"/><duration>4</duration><voice>1</voice></note></measure><measure number="2"><print new-system="yes"/><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note></measure></part>`,
    )
    const r = await importBytes('multi.musicxml', utf8(doc))
    expect(r.package.renderXml).not.toContain('multiple-rest')
    expect(r.package.renderXml).not.toContain('measure-style')
    expect(r.package.renderXml).not.toContain('<print')
    expect(measuresOf(r.package.renderXml)).toHaveLength(2)
  })

  it('restates a key and time change in force at a jump target', async () => {
    const doc = scoreXml(
      `<part id="P1">
        <measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note></measure>
        <measure number="2"><barline location="left"><repeat direction="forward"/></barline>
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note></measure>
        <measure number="3"><attributes><key><fifths>3</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
          <note><pitch><step>A</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><type>half</type><dot/></note>
          <barline location="right"><repeat direction="backward"/></barline></measure>
      </part>`,
    )
    const r = await importBytes('jump.musicxml', utf8(doc))
    const ms = measuresOf(r.package.renderXml)
    expect(ms).toHaveLength(5)
    const jumpTarget = child(ms[3]!, 'attributes')!
    expect(elements(jumpTarget).map((e) => e.name)).toEqual(['key', 'time'])
    expect(child(ms[1]!, 'attributes')).toBeUndefined()
    expect(r.package.model.keys.map((k) => [k.occ, k.fifths])).toEqual([
      [0, 0],
      [2, 3],
      [3, 0],
      [4, 3],
    ])
    expect(r.package.model.meters.map((m) => [m.occ, m.beats])).toEqual([
      [0, 2],
      [2, 3],
      [3, 2],
      [4, 3],
    ])
  })

  it('is accepted again by the importer (round trip keeps the music)', async () => {
    const r = await importBytes('render.musicxml', utf8(xml))
    const again = r.package.model
    const orig = repeats.package.model
    expect(again.occurrences).toHaveLength(orig.occurrences.length)
    expect(again.notes.map((n) => [n.midi, n.onset.n, n.onset.d, n.staff, n.tieContinuation])).toEqual(
      orig.notes.map((n) => [n.midi, n.onset.n, n.onset.d, n.staff, n.tieContinuation]),
    )
  })
})
