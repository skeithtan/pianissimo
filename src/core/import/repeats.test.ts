import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { DiagnosticSink } from './diagnostics'
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

function order(barlines: RawBarlines[], diag = new DiagnosticSink()): string {
  return unfoldRepeats(
    barlines,
    barlines.map((_, i) => String(i + 1)),
    1000,
    diag,
  )
    .map((u) => `${u.m + 1}${u.pass > 1 ? `p${u.pass}` : ''}${u.ending ? `[${u.ending}]` : ''}`)
    .join(' ')
}

describe('repeat unfolding (spec: Unfold written repeats; DECISIONS M5)', () => {
  it('plays straight through without repeats', () => {
    expect(order(bars({}, {}, {}))).toBe('1 2 3')
  })

  it('repeats from the start when there is no forward repeat', () => {
    expect(order(bars({}, { back: true }, {}))).toBe('1 2 1p2 2p2 3')
  })

  it('repeats a section between forward and backward signs', () => {
    expect(order(bars({}, { fwd: true }, { back: true }, {}))).toBe('1 2 3 2p2 3p2 4')
  })

  it('honors times="3"', () => {
    expect(order(bars({}, { fwd: true, back: 3 }, {}))).toBe('1 2 2p2 2p3 3')
  })

  it('plays first and second endings', () => {
    expect(order(bars({}, { fwd: true }, { start: [1], stop: true, back: true }, { start: [2], stop: true }, {}))).toBe(
      '1 2 3[1] 2p2 4[2] 5',
    )
  })

  it('handles a shared ending "1, 2" with a third ending', () => {
    expect(order(bars({ fwd: true }, { start: [1, 2], stop: true, back: true }, { start: [3], stop: true }))).toBe(
      '1 2[1, 2] 1p2 2p2[1, 2] 1p3 3[3]',
    )
  })

  it('handles multi-bar endings', () => {
    expect(
      order(bars({ fwd: true }, { start: [1] }, { stop: true, back: true }, { start: [2] }, { stop: true }, {})),
    ).toBe('1 2[1] 3[1] 1p2 4[2] 5[2] 6')
  })

  it('starts a new section after a finished repeat', () => {
    expect(order(bars({ back: true }, { back: true }))).toBe('1 1p2 2 2p2')
  })

  it('plays endings without any repeat sign in written order, with a warning', () => {
    const diag = new DiagnosticSink()
    expect(order(bars({}, { start: [1], stop: true }, { start: [2], stop: true }), diag)).toBe('1 2 3')
    expect(diag.has('ending-without-repeat')).toBe(true)
  })

  it('warns about nested repeats and still terminates', () => {
    const diag = new DiagnosticSink()
    const out = order(bars({ fwd: true }, { fwd: true }, { back: true }, { back: true }), diag)
    expect(out.split(' ').length).toBeLessThan(20)
    expect(diag.has('repeat-nested')).toBe(true)
  })

  it('refuses an unfolding beyond the occurrence limit', () => {
    expect(() => unfoldRepeats(bars({ back: 5000 }), ['1'], 100, new DiagnosticSink())).toThrow(
      expect.objectContaining({ code: 'score-too-large' }),
    )
  })
})

describe('repeats fixture end to end', async () => {
  const { package: pkg, summary } = await importFixture('repeats.musicxml')
  const model = pkg.model

  it('unfolds 1 |: 2 3 [1. 4 :| [2. 5 ] 6 with printed numbers, passes and endings', () => {
    expect(model.occurrences.map((o) => [o.number, o.pass, o.endingNumber ?? ''])).toEqual([
      ['1', 1, ''],
      ['2', 1, ''],
      ['3', 1, ''],
      ['4', 1, '1'],
      ['2', 2, ''],
      ['3', 2, ''],
      ['5', 1, '2'],
      ['6', 1, ''],
    ])
    expect(model.occurrences.map((o) => o.start.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(summary.repeats).toEqual({
      unfolded: true,
      repeatedBars: [
        { bar: '2', passes: 2 },
        { bar: '3', passes: 2 },
      ],
      endings: ['1', '2'],
    })
  })

  it('performs every source note once per occurrence, with distinct ids', () => {
    expect(model.sourceNotes).toHaveLength(15)
    expect(model.notes).toHaveLength(20)
    expect(new Set(model.notes.map((n) => n.id)).size).toBe(20)
    const d5 = model.notes.filter((n) => n.midi === 74)
    expect(d5.map((n) => [n.occ, n.src])).toEqual([
      [1, d5[0]!.src],
      [4, d5[0]!.src],
    ])
  })

  it('ties from bar 3 into each ending on its own pass', () => {
    const g5 = model.notes.filter((n) => n.midi === 79)
    expect(g5.map((n) => [n.occ, n.tieContinuation])).toEqual([
      [2, false],
      [3, true],
      [5, false],
      [6, true],
    ])
    expect(g5[3]!.tieHead).toBe(g5[2]!.index)
  })

  it('restores the clef at the jump back and follows the written clef map', () => {
    expect(model.clefs.filter((c) => c.staff === 1).map((c) => [c.occ, c.key])).toEqual([
      [0, 'F4'],
      [3, 'G2'],
      [4, 'F4'],
    ])
    expect(model.notes.filter((n) => n.occ === 4 && n.staff === 1).every((n) => n.clef === 'F4')).toBe(true)
  })
})
