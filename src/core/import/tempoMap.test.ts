import { describe, expect, it } from 'vitest'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { rat } from '../music/rational'
import { secondsBetween } from '../music/tempo'
import { DiagnosticSink } from './diagnostics'
import type { RawTempo } from './read/types'
import { buildTempoMap, resolveTempos } from './tempoMap'

describe('MusicXML timing (spec acceptance: MusicXML timing, Tempo mathematics)', () => {
  it('normalizes sound tempo and dotted metronome beats into one map', async () => {
    const model = (await importFixture('tempo-changes.musicxml')).package.model
    expect(
      model.tempo.segments.map((s) => [
        `${s.start.n}/${s.start.d}`,
        s.quarterBpm,
        `${s.beatUnit.n}/${s.beatUnit.d}`,
        s.beatBpm,
        s.source,
      ]),
    ).toEqual([
      ['0/1', 120, '1/4', 120, 'both'],
      ['1/1', 90, '1/4', 90, 'both'],
      ['2/1', 90, '3/8', 60, 'both'],
      ['11/4', 120, '3/8', 80, 'sound'],
    ])
    // A complete 6/8 bar at dotted quarter = 60 lasts 2 seconds.
    expect(secondsBetween(model.tempo, rat(2), rat(11, 4))).toBeCloseTo(2)
    // Four quarter attacks at quarter = 120: 1.5 s attack span, 2 s bar.
    expect(secondsBetween(model.tempo, rat(0), rat(3, 4))).toBeCloseTo(1.5)
    expect(model.diagnostics).toEqual([])
    // "Allegro" stated with a number is not a timing issue.
    expect(model.timingIssues).toEqual([])
  })

  it('reports a sound/metronome conflict and uses the printed metronome mark', async () => {
    const { package: pkg, summary } = await importFixture('tempo-conflict.musicxml')
    const model = pkg.model
    expect(model.tempo.segments).toEqual([
      { start: rat(0), quarterBpm: 90, beatUnit: rat(3, 8), beatBpm: 60, source: 'metronome' },
    ])
    const conflict = model.diagnostics.find((d) => d.code === 'tempo-conflict')!
    expect(conflict.severity).toBe('warning')
    expect(conflict.message).toContain('♩. = 60')
    expect(conflict.message).toContain('90 quarter notes per minute')
    expect(conflict.message).toContain('playback tempo of 60')
    expect(summary.tempo.conflicts).toBe(1)
  })

  it('turns unrealized verbal tempo and fermatas into timing issues', async () => {
    const model = (await importFixture('timing-marks.musicxml')).package.model
    expect(model.timingIssues.map((t) => [t.kind, model.occurrences[t.occ]!.number, t.text])).toEqual([
      ['verbal-tempo', '2', 'rit.'],
      ['fermata', '3', 'fermata'],
      ['verbal-tempo', '4', 'a tempo'],
    ])
    // The realized "rall." in bar 5 adds a numeric segment, not an issue.
    expect(model.tempo.segments.map((s) => s.quarterBpm)).toEqual([100, 80])
  })
})

describe('tempo statement resolution', () => {
  const measures = [0, 1, 2].map((index) => ({
    index,
    number: String(index + 1),
    implicit: false,
    nominalDuration: rat(1),
    duration: rat(1),
  }))
  const t = (
    m: number,
    at: number,
    sound?: number,
    metronome?: { unit: [number, number]; bpm: number; printed?: boolean },
  ): RawTempo => ({
    partId: 'P1',
    m,
    at: rat(at),
    ...(sound !== undefined ? { sound } : {}),
    ...(metronome
      ? {
          metronome: { beatUnit: rat(...metronome.unit), perMinute: metronome.bpm, printed: metronome.printed ?? true },
        }
      : {}),
  })

  it('lets the last statement at one position win; a hidden realization is only informational', () => {
    const diag = new DiagnosticSink()
    const r = resolveTempos(
      [t(0, 0, 66, { unit: [1, 4], bpm: 66 }), t(0, 0, 63, { unit: [1, 4], bpm: 63, printed: false })],
      measures,
      diag,
    )
    expect(r.map((x) => x.quarterBpm)).toEqual([63])
    expect(diag.has('tempo-realized')).toBe(true)
    expect(diag.has('tempo-conflict')).toBe(false)
  })

  it('warns when two printed marks disagree at one position', () => {
    const diag = new DiagnosticSink()
    resolveTempos(
      [t(0, 0, undefined, { unit: [1, 4], bpm: 60 }), t(0, 0, undefined, { unit: [1, 4], bpm: 72 })],
      measures,
      diag,
    )
    expect(diag.has('tempo-conflict')).toBe(true)
  })

  it('uses the first tempo for music before it, with a note', () => {
    const diag = new DiagnosticSink()
    const resolved = resolveTempos([t(1, 0, 100)], measures, diag)
    const occurrences = measures.map((m) => ({
      index: m.index,
      sourceMeasure: m.index,
      number: m.number,
      pass: 1,
      start: rat(m.index),
      duration: rat(1),
    }))
    const map = buildTempoMap(resolved, occurrences, measures, diag)
    expect(map.segments).toEqual([
      { start: rat(0), quarterBpm: 100, beatUnit: rat(1, 4), beatBpm: 100, source: 'sound' },
    ])
    expect(diag.has('tempo-late-start')).toBe(true)
  })

  it('restates the written tempo after a repeat jump', () => {
    const diag = new DiagnosticSink()
    const resolved = resolveTempos([t(0, 0, 60), t(1, 0, 120)], measures, diag)
    // Performance 1 2 1 2: the jump back to bar 1 returns to 60.
    const occurrences = [0, 1, 0, 1].map((m, i) => ({
      index: i,
      sourceMeasure: m,
      number: String(m + 1),
      pass: i < 2 ? 1 : 2,
      start: rat(i),
      duration: rat(1),
    }))
    const map = buildTempoMap(resolved, occurrences, measures, diag)
    expect(map.segments.map((s) => [s.start.n, s.quarterBpm])).toEqual([
      [0, 60],
      [1, 120],
      [2, 60],
      [3, 120],
    ])
  })
})
