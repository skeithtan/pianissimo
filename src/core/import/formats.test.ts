import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { fixtureBytes, utf8 } from '../../../tests/unit/import/fixtures'
import { DiagnosticSink } from './diagnostics'
import { ImportError } from './errors'
import { DEFAULT_IMPORT_LIMITS, resolveLimits } from './limits'
import { ZipReader, crc32, mxlRootfiles } from './mxl'
import { buildScorePackage, inspectSource } from './pipeline'
import { openSource } from './source'

const TWO_HANDS = fixtureBytes('two-hands.musicxml')
const TIMEWISE = fixtureBytes('timewise.musicxml')

function container(...rootfiles: string[]): Uint8Array {
  return utf8(
    `<?xml version="1.0"?><container><rootfiles>${rootfiles
      .map((p) => `<rootfile full-path="${p}" media-type="application/vnd.recordare.musicxml+xml"/>`)
      .join('')}</rootfiles></container>`,
  )
}

function mxl(entries: Record<string, Uint8Array>, stored = false): Uint8Array {
  const input: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  for (const [k, v] of Object.entries(entries)) input[k] = [v, { level: stored ? 0 : 6 }]
  return zipSync(input)
}

async function failure(name: string, bytes: Uint8Array): Promise<ImportError> {
  const e = await inspectSource({ name, bytes }).catch((err: unknown) => err)
  expect(e).toBeInstanceOf(ImportError)
  return e as ImportError
}

describe('supported file formats (spec acceptance: Supported file formats)', () => {
  it('imports .musicxml directly', async () => {
    const r = await inspectSource({ name: 'two-hands.musicxml', bytes: TWO_HANDS })
    expect(r.packaging).toBe('musicxml')
    expect(r.candidates.map((c) => c.title)).toEqual(['Two Hands'])
  })

  it('accepts .xml only when it holds a MusicXML score', async () => {
    const r = await inspectSource({ name: 'two-hands.xml', bytes: TWO_HANDS })
    expect(r.packaging).toBe('xml')
    const e = await failure('unrelated.xml', fixtureBytes('unrelated.xml'))
    expect(e.code).toBe('not-musicxml')
    expect(e.message).toContain('<svg>')
  })

  it('rejects files that are not XML at all, whatever their extension', async () => {
    const e = await failure('song.mid', new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]))
    expect(['unsupported-format', 'xml-encoding']).toContain(e.code)
    expect((await failure('empty.musicxml', new Uint8Array())).code).toBe('file-empty')
  })

  it('reports malformed XML with its position', async () => {
    const e = await failure('malformed.musicxml', fixtureBytes('malformed.musicxml'))
    expect(e.code).toBe('xml-malformed')
    expect(e.message).toMatch(/line 9/)
  })

  it('refuses an opus file (a list of other files) with an explanation', async () => {
    const e = await failure(
      'set.musicxml',
      utf8('<?xml version="1.0"?><opus><title>Set</title><score xlink:href="a.musicxml"/></opus>'),
    )
    expect(e.code).toBe('opus-external')
  })

  it('refuses oversized input before parsing', async () => {
    const e = await inspectSource({ name: 'big.musicxml', bytes: TWO_HANDS }, { limits: { maxInputBytes: 100 } }).catch(
      (x: unknown) => x,
    )
    expect((e as ImportError).code).toBe('file-too-large')
  })

  it('converts score-timewise to partwise with the same music', async () => {
    const r = await inspectSource({ name: 'timewise.musicxml', bytes: TIMEWISE })
    expect(r.candidates[0]!.originalRoot).toBe('score-timewise')
    expect(r.diagnostics.some((d) => d.code === 'timewise-converted')).toBe(true)
    const built = await buildScorePackage(
      { name: 'timewise.musicxml', bytes: TIMEWISE },
      { candidate: 'score', partIds: ['P1'] },
    )
    // Sorted by onset, then staff (top first), then pitch.
    expect(built.package.model.notes.map((n) => n.midi)).toEqual([60, 48, 62, 64, 65, 67, 43])
    expect(built.package.renderXml).toContain('<score-partwise')
    expect(built.package.renderXml).not.toContain('score-timewise')
  })
})

describe('compressed MusicXML (.mxl)', () => {
  it('reads the rootfile named by META-INF/container.xml', async () => {
    const bytes = mxl({
      'META-INF/container.xml': container('music/score.musicxml'),
      'music/score.musicxml': TWO_HANDS,
    })
    const r = await inspectSource({ name: 'song.mxl', bytes })
    expect(r.packaging).toBe('mxl')
    expect(r.candidates.map((c) => [c.id, c.entry])).toEqual([['music/score.musicxml', 'music/score.musicxml']])
    const built = await buildScorePackage(
      { name: 'song.mxl', bytes },
      { candidate: 'music/score.musicxml', partIds: ['P1'] },
    )
    expect(built.package.model.meta.packaging).toBe('mxl')
    expect(built.package.model.meta.sourceEntry).toBe('music/score.musicxml')
    expect(built.source.packaging).toBe('mxl')
  })

  it('offers every score when the container lists several (movements)', async () => {
    const bytes = mxl({
      'META-INF/container.xml': container('one.musicxml', 'two.musicxml'),
      'one.musicxml': TWO_HANDS,
      'two.musicxml': TIMEWISE,
    })
    const r = await inspectSource({ name: 'suite.mxl', bytes })
    expect(r.candidates.map((c) => c.id)).toEqual(['one.musicxml', 'two.musicxml'])
    expect(r.candidates.map((c) => c.title)).toEqual(['Two Hands', 'Timewise'])
    const second = await buildScorePackage({ name: 'suite.mxl', bytes }, { candidate: 'two.musicxml', partIds: ['P1'] })
    expect(second.package.model.meta.title).toBe('Timewise')
  })

  it('follows an opus inside the archive to its scores', async () => {
    const opus = utf8(
      '<?xml version="1.0"?><opus xmlns:xlink="http://www.w3.org/1999/xlink"><score xlink:href="a.musicxml"/><score xlink:href="b.musicxml"/></opus>',
    )
    const bytes = mxl({
      'META-INF/container.xml': container('set.xml'),
      'set.xml': opus,
      'a.musicxml': TWO_HANDS,
      'b.musicxml': TIMEWISE,
    })
    const r = await inspectSource({ name: 'set.mxl', bytes })
    expect(r.candidates.map((c) => c.id)).toEqual(['a.musicxml', 'b.musicxml'])
  })

  it('falls back to the only top-level score when the container is missing', async () => {
    const bytes = mxl({ 'score.musicxml': TWO_HANDS })
    const r = await inspectSource({ name: 'nocontainer.mxl', bytes })
    expect(r.candidates).toHaveLength(1)
    expect(r.diagnostics.some((d) => d.code === 'mxl-no-container')).toBe(true)
  })

  it('explains a missing rootfile', async () => {
    const bytes = mxl({ 'META-INF/container.xml': container('missing.musicxml'), 'other.txt': utf8('x') })
    const e = await failure('broken.mxl', bytes)
    expect(e.code).toBe('mxl-rootfile-missing')
    expect(e.message).toContain('missing.musicxml')
  })

  it('reports a truncated archive as damaged', async () => {
    const bytes = mxl({ 'META-INF/container.xml': container('s.musicxml'), 's.musicxml': TWO_HANDS })
    const e = await failure('cut.mxl', bytes.slice(0, Math.floor(bytes.length / 2)))
    expect(['mxl-damaged', 'mxl-no-container', 'mxl-rootfile-missing']).toContain(e.code)
    expect(e.message.length).toBeGreaterThan(20)
  })

  it('detects corrupted contents through the CRC', () => {
    const bytes = mxl({ 'META-INF/container.xml': container('s.musicxml'), 's.musicxml': TWO_HANDS }, true)
    const marker = new TextEncoder().encode('Two Hands')
    let at = -1
    for (let i = 0; i < bytes.length - marker.length && at < 0; i++) {
      if (marker.every((b, k) => bytes[i + k] === b)) at = i
    }
    expect(at).toBeGreaterThan(0)
    const corrupt = bytes.slice()
    corrupt[at] = 0x58
    const reader = new ZipReader(corrupt, DEFAULT_IMPORT_LIMITS)
    expect(() => reader.read('s.musicxml')).toThrow(expect.objectContaining({ code: 'mxl-damaged' }))
  })

  it('refuses entries above the expansion limits before inflating them', () => {
    const big = new Uint8Array(2 * 1024 * 1024)
    const bytes = mxl({ 'META-INF/container.xml': container('s.musicxml'), 's.musicxml': big })
    const reader = new ZipReader(bytes, DEFAULT_IMPORT_LIMITS)
    expect(() => reader.read('s.musicxml')).toThrow(expect.objectContaining({ code: 'mxl-limits' }))
    const small = new ZipReader(mxl({ 'a.xml': TWO_HANDS }), resolveLimits({ maxZipEntryBytes: 100 }))
    expect(() => small.read('a.xml')).toThrow(/limit/)
    expect(
      () => new ZipReader(mxl({ a: utf8('1'), b: utf8('2'), c: utf8('3') }), resolveLimits({ maxZipEntries: 2 })),
    ).toThrow(expect.objectContaining({ code: 'mxl-limits' }))
  })

  it('reads a zip even when it is named .musicxml, and refuses a non-zip .mxl', async () => {
    const bytes = mxl({ 'META-INF/container.xml': container('s.musicxml'), 's.musicxml': TWO_HANDS })
    const r = await inspectSource({ name: 'renamed.musicxml', bytes })
    expect(r.packaging).toBe('mxl')
    const e = await failure('fake.mxl', new Uint8Array([1, 2, 3, 4, 5]))
    expect(e.code).toBe('mxl-damaged')
  })

  it('lists rootfiles in container order and computes CRC-32 like zip', () => {
    const diag = new DiagnosticSink()
    const bytes = mxl({
      'META-INF/container.xml': container('b.musicxml', 'a.musicxml'),
      'a.musicxml': TWO_HANDS,
      'b.musicxml': TWO_HANDS,
    })
    expect(mxlRootfiles(new ZipReader(bytes, DEFAULT_IMPORT_LIMITS), DEFAULT_IMPORT_LIMITS, diag)).toEqual([
      'b.musicxml',
      'a.musicxml',
    ])
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926)
  })

  it('opens only the selected candidate when building', () => {
    const bytes = mxl({
      'META-INF/container.xml': container('one.musicxml', 'two.musicxml'),
      'one.musicxml': TWO_HANDS,
      'two.musicxml': TIMEWISE,
    })
    const opened = openSource(bytes, 'suite.mxl', DEFAULT_IMPORT_LIMITS, new DiagnosticSink(), 'two.musicxml')
    expect(opened.documents.map((d) => d.id)).toEqual(['two.musicxml'])
  })
})
