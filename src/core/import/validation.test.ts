import { describe, expect, it } from 'vitest'
import { fixtureBytes, importBytes, scoreXml, utf8 } from '../../../tests/unit/import/fixtures'
import { buildScorePackage, inspectSource } from './pipeline'

const ATTRS =
  '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
const TEMPO =
  '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type><sound tempo="60"/></direction>'
const n = (step: string, octave: number, duration: number, extra = '') =>
  `<note>${extra}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>1</voice></note>`
const part = (...measures: string[]) =>
  `<part id="P1">${measures.map((m, i) => `<measure number="${i + 1}">${m}</measure>`).join('')}</part>`
const codes = async (xml: string) =>
  (await importBytes('t.musicxml', utf8(xml))).package.model.diagnostics.map((d) => d.code)

describe('MusicXML import validation (spec acceptance: MusicXML import validation)', () => {
  it('reports bars shorter or longer than their time signature', async () => {
    const xml = scoreXml(part(ATTRS + TEMPO + n('C', 5, 4), n('D', 5, 2), n('E', 5, 6), n('F', 5, 4)))
    const c = await codes(xml)
    expect(c).toContain('measure-underfull')
    expect(c).toContain('measure-overfull')
  })

  it('reports an unmatched tie instead of silently joining notes', async () => {
    const xml = scoreXml(
      part(ATTRS + TEMPO + n('C', 5, 4).replace('<voice>', '<tie type="start"/><voice>'), n('D', 5, 4)),
    )
    const r = await importBytes('t.musicxml', utf8(xml))
    expect(r.package.model.diagnostics.map((d) => d.code)).toContain('tie-unmatched')
    expect(r.package.model.notes.every((x) => !x.tieContinuation)).toBe(true)
  })

  it('clamps a <backup> past the bar start and warns', async () => {
    const xml = scoreXml(part(ATTRS + TEMPO + n('C', 5, 4) + '<backup><duration>8</duration></backup>' + n('E', 4, 4)))
    const r = await importBytes('t.musicxml', utf8(xml))
    expect(r.package.model.diagnostics.map((d) => d.code)).toContain('backup-before-measure')
    expect(r.package.model.notes.map((x) => x.onset.n)).toEqual([0, 0])
  })

  it('assumes divisions and missing durations with a warning rather than failing', async () => {
    const xml = scoreXml(
      part(
        '<attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' + TEMPO + n('C', 5, 4),
        '<note><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>whole</type></note>',
      ),
    )
    const r = await importBytes('t.musicxml', utf8(xml))
    const c = r.package.model.diagnostics.map((d) => d.code)
    expect(c).toContain('divisions-missing')
    expect(c).toContain('note-duration-missing')
    expect(c).toContain('clef-missing')
    expect(r.package.model.notes).toHaveLength(2)
    expect(r.package.model.notes[1]!.duration.n).toBe(1)
  })

  it('flags parts missing from the part list and listed parts without music', async () => {
    const xml = scoreXml(
      part(ATTRS + TEMPO + n('C', 5, 4)),
      '<score-part id="P0"><part-name>Ghost</part-name></score-part>',
    )
    const r = await inspectSource({ name: 't.musicxml', bytes: utf8(xml) })
    expect(r.diagnostics.map((d) => d.code).filter((x) => x === 'part-list-mismatch')).toHaveLength(2)
  })

  it('pads a part with fewer bars and warns', async () => {
    const xml = scoreXml(
      `${part(ATTRS + TEMPO + n('C', 5, 4), n('D', 5, 4))}<part id="P2"><measure number="1">${ATTRS.replace('<sign>G</sign><line>2</line>', '<sign>F</sign><line>4</line>')}${n('C', 3, 4)}</measure></part>`,
      '<score-part id="P1"><part-name>Piano RH</part-name></score-part><score-part id="P2"><part-name>Piano LH</part-name></score-part>',
    )
    const r = await importBytes('t.musicxml', utf8(xml), { partIds: ['P1', 'P2'] })
    expect(r.package.model.diagnostics.map((d) => d.code)).toContain('part-measure-mismatch')
    expect(r.package.model.occurrences).toHaveLength(2)
    // The missing bar is engraved as a whole-bar rest so every occurrence exists in every part.
    expect(r.package.renderXml.match(/<measure /g)).toHaveLength(4)
    expect(r.package.renderXml).toContain('<rest measure="yes"/>')
  })

  it('refuses scores beyond the processing limits', async () => {
    const bytes = fixtureBytes('two-hands.musicxml')
    const file = { name: 'two-hands.musicxml', bytes }
    await expect(
      buildScorePackage(file, { candidate: 'score', partIds: ['P1'] }, { limits: { maxMeasures: 1 } }),
    ).rejects.toMatchObject({ code: 'score-too-large' })
    await expect(
      buildScorePackage(file, { candidate: 'score', partIds: ['P1'] }, { limits: { maxNotes: 3 } }),
    ).rejects.toMatchObject({ code: 'score-too-large' })
    await expect(buildScorePackage(file, { candidate: 'nope', partIds: ['P1'] })).rejects.toMatchObject({
      code: 'selection-invalid',
    })
  })

  it('honors an abort signal between stages', async () => {
    const controller = new AbortController()
    controller.abort()
    const file = { name: 'two-hands.musicxml', bytes: fixtureBytes('two-hands.musicxml') }
    await expect(inspectSource(file, { signal: controller.signal })).rejects.toMatchObject({ code: 'canceled' })
    await expect(
      buildScorePackage(file, { candidate: 'score', partIds: ['P1'] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'canceled' })
  })
})

describe('score version identity (deliverable: scoreVersionId)', () => {
  const bytes = fixtureBytes('two-parts.musicxml')
  const build = (partIds: string[], b = bytes) =>
    buildScorePackage({ name: 'x.musicxml', bytes: b }, { candidate: 'score', partIds })

  it('is stable for the same bytes and parts, and differs for other parts or bytes', async () => {
    const a = (await build(['P2', 'P3'])).package.model.scoreVersionId
    const again = (await build(['P3', 'P2'])).package.model.scoreVersionId
    const other = (await build(['P2'])).package.model.scoreVersionId
    const changed = new Uint8Array([...bytes, 0x20])
    const otherBytes = (await build(['P2', 'P3'], changed)).package.model.scoreVersionId
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(again).toBe(a)
    expect(other).not.toBe(a)
    expect(otherBytes).not.toBe(a)
  })

  it('records the source SHA-256 with the original bytes and packaging', async () => {
    const r = await build(['P2', 'P3'])
    expect(r.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(new Uint8Array(r.source.bytes)).toEqual(bytes)
    expect(r.source.packaging).toBe('musicxml')
    const differentName = await buildScorePackage(
      { name: 'renamed.musicxml', bytes },
      { candidate: 'score', partIds: ['P2', 'P3'] },
    )
    expect(differentName.source.sha256).toBe(r.source.sha256)
  })
})
