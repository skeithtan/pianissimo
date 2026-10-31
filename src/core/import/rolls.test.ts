import { describe, expect, it } from 'vitest'
import { fixtureBytes, importBytes, importFixture } from '../../../tests/unit/import/fixtures'
import { rat } from '../music/rational'
import { IMPORTER_VERSION, ROLL_POLICY_VERSION, type ScoreModel } from '../model/score'
import { ROLL_SPREAD_SEC, withUserTempo } from './rolls'

const offsetsOf = (model: ScoreModel, group: number) =>
  model.arpeggios[group]!.notes.map((i) => [model.notes[i]!.midi, Number(model.notes[i]!.refOffsetSec.toFixed(6))])

describe('reference roll realization (spec: Roll reference and timing; ROLL_POLICY_VERSION)', async () => {
  const { package: pkg, summary } = await importFixture('rolls.musicxml')
  const model = pkg.model

  it('a shared number across staves is one low → high sweep of 120 ms', () => {
    const g = model.arpeggios[0]!
    expect(g).toMatchObject({
      crossStaff: true,
      direction: 'up',
      directionDefaulted: true,
      number: '1',
      spreadSec: ROLL_SPREAD_SEC,
      occ: 0,
    })
    expect(offsetsOf(model, 0)).toEqual([
      [48, 0],
      [55, 0.03],
      [64, 0.06],
      [67, 0.09],
      [72, 0.12],
    ])
  })

  it('independently numbered rolls at one onset start together, each in its own direction', () => {
    const [down, up] = [model.arpeggios[1]!, model.arpeggios[2]!]
    expect(down.at).toEqual(up.at)
    expect(down).toMatchObject({ direction: 'down', directionDefaulted: false, crossStaff: false })
    expect(offsetsOf(model, 1)).toEqual([
      [74, 0.12],
      [77, 0],
    ])
    expect(offsetsOf(model, 2)).toEqual([
      [50, 0],
      [57, 0.12],
    ])
  })

  it('shortens the spread to half of the earliest member ending', () => {
    // 32nd notes at quarter = 60 last 125 ms → spread 62.5 ms.
    expect(model.arpeggios[3]!.spreadSec).toBeCloseTo(0.0625)
    expect(offsetsOf(model, 3)).toEqual([
      [72, 0],
      [76, 0.03125],
      [79, 0.0625],
    ])
  })

  it('gives a single fresh pitch no spread and counts a pitch shared by two voices once', () => {
    expect(model.arpeggios[4]!.spreadSec).toBe(0)
    expect(offsetsOf(model, 5)).toEqual([
      [72, 0],
      [76, 0.12],
      [76, 0.12],
    ])
  })

  it('keeps explicit attack offsets from the file instead of adding a spread', () => {
    expect(model.arpeggios[6]!.spreadSec).toBeCloseTo(0.25)
    expect(offsetsOf(model, 6)).toEqual([
      [67, 0],
      [71, 0.125],
      [74, 0.25],
    ])
  })

  it('never moves written positions and leaves notes outside rolls at offset 0', () => {
    for (const g of model.arpeggios) for (const i of g.notes) expect(model.notes[i]!.onset).toEqual(g.at)
    expect(model.notes.filter((n) => n.arpeggio === undefined).every((n) => n.refOffsetSec === 0)).toBe(true)
    expect(summary.rolls.map((r) => r.spreadMs)).toEqual([120, 120, 120, 63, 0, 120, 250])
  })

  it('shortens to half the interval before the next written attack', async () => {
    // Reference-piece-like case built from the fixture: at quarter = 240 the next attack is 250 ms away.
    const fast = withUserTempo(model, 240, rat(1, 4))
    expect(fast.arpeggios[0]!.spreadSec).toBeCloseTo(0.12)
    const faster = withUserTempo(model, 600, rat(1, 4))
    // A quarter at 600 BPM lasts 100 ms → half the interval is 50 ms.
    expect(faster.arpeggios[0]!.spreadSec).toBeCloseTo(0.05)
  })
})

describe('withUserTempo (spec: missing numerical tempo requires a practice tempo)', async () => {
  const { package: pkg, summary } = await importFixture('no-tempo.musicxml')
  const model = pkg.model

  it('imports with an empty tempo map, zero roll offsets and a tempo blocker', () => {
    expect(model.tempo.segments).toEqual([])
    expect(model.diagnostics.map((d) => d.code)).toContain('tempo-missing')
    expect(model.arpeggios.map((g) => g.spreadSec)).toEqual([0, 0])
    expect(model.notes.every((n) => n.refOffsetSec === 0)).toBe(true)
    expect(summary.readiness.tempo).toBe(false)
    expect(summary.readiness.blockers[0]).toMatch(/tempo/)
    // The opening "Andante" is not a timing issue: the practice tempo replaces it.
    expect(model.timingIssues).toEqual([])
  })

  it('adds a user segment, realizes the rolls and keeps the versions', () => {
    const withTempo = withUserTempo(model, 60, rat(3, 8))
    expect(withTempo.tempo.segments).toEqual([
      { start: rat(0), quarterBpm: 90, beatUnit: rat(3, 8), beatBpm: 60, source: 'user' },
    ])
    expect(withTempo.arpeggios.map((g) => g.spreadSec)).toEqual([ROLL_SPREAD_SEC, ROLL_SPREAD_SEC])
    expect(withTempo.arpeggios.map((g) => g.crossStaff)).toEqual([false, false])
    expect(withTempo.diagnostics.map((d) => d.code)).not.toContain('tempo-missing')
    expect(withTempo.diagnostics.find((d) => d.code === 'tempo-user')?.message).toContain('dotted quarter = 60')
    expect(withTempo.meta.rollPolicyVersion).toBe(ROLL_POLICY_VERSION)
    expect(withTempo.meta.importerVersion).toBe(IMPORTER_VERSION)
    expect(withTempo.scoreVersionId).toBe(model.scoreVersionId)
    expect(model.tempo.segments).toEqual([])
  })

  it('rejects invalid tempos', () => {
    expect(() => withUserTempo(model, 0, rat(1, 4))).toThrow(RangeError)
    expect(() => withUserTempo(model, Number.NaN, rat(1, 4))).toThrow(RangeError)
    expect(() => withUserTempo(model, -5, rat(1, 4))).toThrow(RangeError)
  })
})

describe('withUserTempo keeps explicit attack offsets (WP12 polish)', async () => {
  // rolls.musicxml without its tempo: one division = a 32nd note.
  const text = new TextDecoder().decode(fixtureBytes('rolls.musicxml'))
  const tempoLess = text.replace(/<direction><direction-type><metronome>.*?<\/direction>/s, '')
  const { package: pkg } = await importBytes('rolls-no-tempo.musicxml', new TextEncoder().encode(tempoLess))
  const model = pkg.model

  it('records the attack on the source notes and imports with zero offsets', () => {
    expect(model.tempo.segments).toEqual([])
    expect(model.sourceNotes.filter((n) => n.attack !== undefined).map((n) => n.attack)).toEqual([
      rat(0),
      rat(1, 32),
      rat(1, 16),
    ])
    expect(model.notes.every((n) => n.refOffsetSec === 0)).toBe(true)
  })

  it('realizes the file’s attacks at the practice tempo instead of the default spread', () => {
    const at60 = withUserTempo(model, 60, rat(1, 4))
    expect(offsetsOf(at60, 6)).toEqual([
      [67, 0],
      [71, 0.125],
      [74, 0.25],
    ])
    expect(at60.arpeggios[6]!.spreadSec).toBeCloseTo(0.25)
    const at120 = withUserTempo(model, 120, rat(1, 4))
    expect(offsetsOf(at120, 6)).toEqual([
      [67, 0],
      [71, 0.0625],
      [74, 0.125],
    ])
    // Rolls without explicit attacks still get the reference spread.
    expect(at120.arpeggios[0]!.spreadSec).toBeCloseTo(ROLL_SPREAD_SEC)
  })

  it('falls back to the default spread for packages stored without attack data', () => {
    const legacy: ScoreModel = { ...model, sourceNotes: model.sourceNotes.map(({ attack: _attack, ...n }) => n) }
    const realized = withUserTempo(legacy, 60, rat(1, 4))
    expect(realized.arpeggios[6]!.spreadSec).toBeCloseTo(ROLL_SPREAD_SEC)
  })
})
