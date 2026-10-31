import { describe, expect, it } from 'vitest'
import { importBytes, importFixture } from '../../../tests/unit/import/fixtures'
import { DiagnosticSink } from './diagnostics'
import { classifyNavWords, type NavigationPlan, type NavJump } from './navigation'
import type { RawBarlines } from './read/types'
import { unfoldRepeats } from './repeats'

type Spec = { fwd?: boolean; back?: number | true; start?: number[]; stop?: boolean }

function bars(...specs: Spec[]): RawBarlines[] {
  return specs.map((s) => {
    const b: { -readonly [K in keyof RawBarlines]: RawBarlines[K] } = {
      forwardRepeat: s.fwd ?? false,
      endingStop: s.stop ?? false,
    }
    if (s.back !== undefined) b.backwardRepeat = s.back === true ? {} : { times: s.back }
    if (s.start) b.endingStart = { numbers: s.start, text: s.start.join(', ') }
    return b
  })
}

function plan(p: {
  jumps?: [number, Partial<NavJump>][]
  fine?: number[]
  toCoda?: [number, number][]
}): NavigationPlan {
  return {
    jumps: new Map(
      (p.jumps ?? []).map(([m, j]) => [
        m,
        { kind: 'dc', target: 0, mode: 'end', withRepeats: false, text: 'D.C.', ...j },
      ]),
    ),
    fine: new Set(p.fine ?? []),
    toCoda: new Map(p.toCoda ?? []),
  }
}

function order(barlines: RawBarlines[], nav: NavigationPlan, diag = new DiagnosticSink()): string {
  return unfoldRepeats(
    barlines,
    barlines.map((_, i) => String(i + 1)),
    1000,
    diag,
    nav,
  )
    .map(
      (u) =>
        `${u.m + 1}${u.pass > 1 ? `p${u.pass}` : ''}${u.ending ? `[${u.ending}]` : ''}${u.nav ? `{${u.nav}}` : ''}`,
    )
    .join(' ')
}

const occs = (model: { occurrences: readonly { number: string; pass: number }[] }) =>
  model.occurrences.map((o) => `${o.number}${o.pass > 1 ? `p${o.pass}` : ''}`).join(' ')

/** A one-staff 2/4 score: one half note per bar, `extra[i]` written at the start of bar i + 1. */
function score(extra: readonly string[]): Uint8Array {
  const measures = extra.map((x, i) => {
    const attrs =
      i === 0
        ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><sound tempo="60"/>'
        : ''
    return `<measure number="${i + 1}">${attrs}${x}<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note></measure>`
  })
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`
  return new TextEncoder().encode(xml)
}

const words = (text: string, sound = '') =>
  `<direction><direction-type><words>${text}</words></direction-type>${sound}</direction>`
const SEGNO = '<direction><direction-type><segno/></direction-type></direction>'
const CODA = '<direction><direction-type><coda/></direction-type></direction>'

describe('navigation words (DECISIONS I4)', () => {
  it('recognizes the common jump instructions and their modifiers', () => {
    expect(classifyNavWords('D.C. al Fine')).toEqual({
      kinds: ['dacapo'],
      alFine: true,
      alCoda: false,
      withRepeats: false,
    })
    expect(classifyNavWords('D.S. al Coda')).toMatchObject({ kinds: ['dalsegno'], alCoda: true })
    expect(classifyNavWords('Da Capo')).toMatchObject({ kinds: ['dacapo'], alFine: false, alCoda: false })
    expect(classifyNavWords('Dal Segno al Fine')).toMatchObject({ kinds: ['dalsegno'], alFine: true })
    expect(classifyNavWords('D.C. con repetizione')).toMatchObject({ kinds: ['dacapo'], withRepeats: true })
    expect(classifyNavWords('DC al 𝄌')).toMatchObject({ kinds: ['dacapo'], alCoda: true })
    expect(classifyNavWords('To Coda').kinds).toEqual(['tocoda'])
    expect(classifyNavWords('to 𝄌').kinds).toEqual(['tocoda'])
    expect(classifyNavWords('Fine').kinds).toEqual(['fine'])
    expect(classifyNavWords('𝄌 Coda').kinds).toEqual(['coda'])
    expect(classifyNavWords('𝄋').kinds).toEqual(['segno'])
  })

  it('ignores other words', () => {
    for (const t of ['dolce', 'Fine e dolce', 'cresc.', 'Allegro', 'a tempo', 'Codetta in G'])
      expect(classifyNavWords(t).kinds, t).toEqual([])
  })
})

describe('unfolding with a navigation plan', () => {
  it('D.C. al Fine stops at the end of the Fine bar after the jump only', () => {
    expect(order(bars({}, {}, {}), plan({ jumps: [[2, { mode: 'fine' }]], fine: [1] }))).toBe(
      '1 2 3{jump} 1p2 2p2{fine}',
    )
  })

  it('D.S. al Coda takes To Coda only after the jump', () => {
    const nav = plan({ jumps: [[4, { kind: 'ds', target: 1, mode: 'coda' }]], toCoda: [[2, 5]] })
    expect(order(bars({}, {}, {}, {}, {}, {}, {}), nav)).toBe('1 2 3 4 5{jump} 2p2 3p2{to-coda} 6 7')
  })

  it('a plain D.C. plays to the end, taking each jump once', () => {
    expect(order(bars({}, {}), plan({ jumps: [[1, {}]] }))).toBe('1 2{jump} 1p2 2p2')
  })

  it('takes a repeat on the jump bar before the jump', () => {
    expect(order(bars({}, { fwd: true, back: true }), plan({ jumps: [[1, {}]] }))).toBe('1 2 2p2{jump} 1p2 2p3')
  })

  it('does not take completed repeats again after the jump; endings go to the last one', () => {
    const b = bars({ fwd: true }, {}, { start: [1], stop: true, back: true }, { start: [2], stop: true }, {})
    expect(order(b, plan({ jumps: [[4, { mode: 'fine' }]], fine: [3] }))).toBe(
      '1 2 3[1] 1p2 2p2 4[2] 5{jump} 1p3 2p3 4p2[2]{fine}',
    )
  })

  it('takes repeats again when the jump asks for them', () => {
    const b = bars({ fwd: true }, { back: true }, {})
    expect(order(b, plan({ jumps: [[2, { withRepeats: true }]] }))).toBe('1 2 1p2 2p2 3{jump} 1p3 2p3 1p4 2p4 3p2')
    expect(order(b, plan({ jumps: [[2, {}]] }))).toBe('1 2 1p2 2p2 3{jump} 1p3 2p3 3p2')
  })

  it('takes repeats first reached after the jump (in the coda)', () => {
    const nav = plan({ jumps: [[1, { mode: 'coda' }]], toCoda: [[0, 2]] })
    expect(order(bars({}, {}, { fwd: true }, { back: true }), nav)).toBe('1 2{jump} 1p2{to-coda} 3 4 3p2 4p2')
  })

  it('reports each followed instruction as info', () => {
    const diag = new DiagnosticSink()
    order(bars({}, {}), plan({ jumps: [[1, { mode: 'fine', text: 'D.C. al Fine' }]], fine: [0] }), diag)
    expect(diag.list().map((d) => [d.code, d.severity])).toEqual([
      ['navigation-jump', 'info'],
      ['navigation-fine', 'info'],
    ])
    expect(diag.list()[0]!.message).toBe('“D.C. al Fine” in bar 2 is followed: the performance continues at bar 1.')
  })
})

describe('D.C. al Fine fixture (sound attributes)', async () => {
  const { package: pkg, summary } = await importFixture('dc-al-fine.musicxml')
  const model = pkg.model

  it('follows the jump and ends at Fine, with passes', () => {
    expect(occs(model)).toBe('1 2 3 1p2 2p2')
    expect(model.unsupported).toEqual([])
    expect(summary.readiness.blockers).toEqual([])
    expect(model.notes.map((n) => n.midi)).toEqual([72, 74, 76, 72, 74])
  })

  it('shows D.C. and Fine only where they take effect, without OSMD navigation semantics', () => {
    const measures = pkg.renderXml.match(/<measure .*?<\/measure>/g)!
    expect(measures.map((m) => /D\.C\. al Fine/.test(m))).toEqual([false, false, true, false, false])
    expect(measures.map((m) => /Fine⁠/.test(m) && !/D\.C\./.test(m))).toEqual([false, false, false, false, true])
    expect(pkg.renderXml).not.toMatch(/dacapo=|fine=/)
  })
})

describe('D.C. al Fine fixture with repeats (words only)', async () => {
  const { package: pkg } = await importFixture('dc-repeats.musicxml')
  const model = pkg.model

  it('repeats on the first pass, not after the jump, and stops at Fine', () => {
    expect(occs(model)).toBe('1 2 1p2 2p2 3 4 3p2 5 1p3 2p3')
    expect(model.occurrences.map((o) => o.endingNumber ?? '')).toEqual(['', '', '', '', '', '1', '', '2', '', ''])
    expect(model.unsupported).toEqual([])
  })
})

describe('D.S. al Coda fixture', async () => {
  const { package: pkg, summary } = await importFixture('ds-al-coda.musicxml')
  const model = pkg.model

  it('follows segno, To Coda and coda by their tokens', () => {
    expect(occs(model)).toBe('1 2 3 4 5 6 2p2 3p2 4p2 7 8')
    expect(model.unsupported).toEqual([])
    expect(summary.repeats.unfolded).toBe(true)
    expect(model.diagnostics.filter((d) => d.code.startsWith('navigation-')).map((d) => [d.code, d.measure])).toEqual([
      ['navigation-jump', '6'],
      ['navigation-to-coda', '4'],
    ])
  })

  it('splits the 8va at the To Coda jump (I5)', () => {
    expect(model.ottavas.map((o) => [o.startOcc, o.endOcc, o.notes.length])).toEqual([
      [2, 4, 5],
      [7, 8, 3],
    ])
    expect(model.notes.filter((n) => n.occ === 9 && n.staff === 0).every((n) => n.ottavaShift === 0)).toBe(true)
    const tokens = pkg.renderXml
      .match(/<measure number="\d+"|<octave-shift type="\w+"/g)!
      .map((t) => t.replace(/<measure number="(\d+)"/, 'm$1').replace(/<octave-shift type="(\w+)"/, '$1'))
    expect(tokens.join(' ')).toBe('m1 m2 m3 down m4 m5 stop m6 m7 m8 down m9 stop m10 m11')
  })

  it('uses the written key context at the jump target and in the coda', () => {
    expect(model.keys.map((k) => [k.occ, k.fifths])).toEqual([
      [0, 0],
      [4, 1],
      [6, 0],
      [9, 1],
    ])
    const measures = pkg.renderXml.match(/<measure .*?<\/measure>/g)!
    expect(measures[6]).toMatch(/<key><fifths>0<\/fifths><\/key>/)
    expect(measures[9]).toMatch(/<key><fifths>1<\/fifths><\/key>/)
  })

  it('shows each sign once (where the jump lands) and To Coda / D.S. only where taken', () => {
    const measures = pkg.renderXml.match(/<measure .*?<\/measure>/g)!
    expect(measures.map((m) => /To Coda/.test(m))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ])
    expect(measures.map((m) => /D\.S\. al Coda/.test(m))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ])
    expect(measures.map((m) => /<segno\/>/.test(m))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
    ])
    // Coda signs become words (OSMD draws a <coda/> as its own "To ⊕"); "To Coda" keeps its words.
    expect(pkg.renderXml).not.toMatch(/<coda\/>/)
    expect(measures.map((m) => />Coda\u2060</.test(m))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ])
    expect(pkg.renderXml).not.toMatch(/segno=|coda=|tocoda=|dalsegno=/)
  })
})

describe('navigation that is not followed stays unsupported-repeat', () => {
  const unsupported = async (extra: string[]) => {
    const { package: pkg } = await importBytes('nav.musicxml', score(extra))
    return {
      order: occs(pkg.model),
      regions: pkg.model.unsupported.map((u) => [u.kind, u.fromOcc, u.toOcc, u.message]),
    }
  }

  it('D.S. without a segno', async () => {
    expect(await unsupported(['', words('D.S. al Fine'), words('Fine')])).toEqual({
      order: '1 2 3',
      regions: [
        ['unsupported-repeat', 1, 1, 'Repeat instruction that is not followed (D.S. al Fine: no segno before it)'],
      ],
    })
  })

  it('al Fine without a Fine, al Coda without To Coda or coda', async () => {
    expect((await unsupported(['', words('D.C. al Fine')])).regions[0]?.[3]).toMatch(/no Fine/)
    expect((await unsupported(['', words('D.C. al Coda'), CODA])).regions[0]?.[3]).toMatch(/no To Coda/)
    expect((await unsupported([words('To Coda'), words('D.C. al Coda'), ''])).regions[0]?.[3]).toMatch(/no coda sign/)
  })

  it('a jump inside a repeated section', async () => {
    const back = '<barline location="right"><repeat direction="backward"/></barline>'
    const r = await unsupported([words('D.C.'), back, ''])
    expect(r.order).toBe('1 2 1p2 2p2 3')
    // One region per pass of bar 1.
    expect(r.regions.map((x) => [x[1], x[3]])).toEqual([
      [0, 'Repeat instruction that is not followed (D.C.: inside a repeated section)'],
      [2, 'Repeat instruction that is not followed (D.C.: inside a repeated section)'],
    ])
  })

  it('a To Coda no jump leads to', async () => {
    const r = await unsupported([words('To Coda'), '', CODA])
    expect(r.order).toBe('1 2 3')
    expect(r.regions.map((x) => [x[1], x[3]])).toEqual([
      [0, 'Repeat instruction that is not followed (To Coda: no D.C. or D.S. al Coda leads to it)'],
    ])
  })

  it('follows words-only D.S. al Coda with an implicit To Coda point (Sibelius style)', async () => {
    const r = await unsupported(['', SEGNO, words('To Coda'), words('D.S. al Coda'), `${CODA}`])
    expect(r).toEqual({ order: '1 2 3 4 2p2 3p2 5', regions: [] })
  })

  it('a segno on a right-hand barline marks the next bar', async () => {
    const r = await unsupported(['<barline location="right"><segno/></barline>', '', words('D.S.')])
    expect(r.order).toBe('1 2 3 2p2 3p2')
  })

  it('reads navigation from an unselected part', async () => {
    const piano = new TextDecoder().decode(score(['', '', '']))
    const voiceBar = (i: number, nav: string) =>
      `<measure number="${i}">${nav}<note><rest/><duration>2</duration><voice>1</voice></note></measure>`
    const voice = `<part id="P2">${voiceBar(1, '')}${voiceBar(2, words('Fine'))}${voiceBar(3, words('D.C. al Fine'))}</part>`
    const xml = piano
      .replace('</part-list>', '<score-part id="P2"><part-name>Voice</part-name></score-part></part-list>')
      .replace('</score-partwise>', `${voice}</score-partwise>`)
    const { package: pkg } = await importBytes('two.musicxml', new TextEncoder().encode(xml), { partIds: ['P1'] })
    expect(occs(pkg.model)).toBe('1 2 3 1p2 2p2')
  })
})
