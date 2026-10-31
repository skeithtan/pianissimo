/**
 * Acceptance rows "Ottava error emphasis" and "Ottava scope and visibility" (engine side).
 * Pitches in the model are sounding (DECISIONS M1): written C4 under 8va is MIDI 72.
 */
import { describe, expect, it } from 'vitest'
import type { OttavaSpec, ScoreSpec } from './testkit'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { LearnerHands } from './timeline'

const C2 = 36
const C3 = 48
const C4 = 60
const D4 = 62
const C5 = 72
const D5 = 74
const C6 = 84

function driver(spec: ScoreSpec, hands: LearnerHands = 'both', mode: 'reading' | 'scored' = 'reading'): EngineDriver {
  const t = buildTimeline(buildScore(spec), { hands, range: null, multiplier: 1 })
  return new EngineDriver(t, { mode, pieceId: 'p', transport: 'free', prepared: true })
}

describe('Acceptance: Ottava error emphasis', () => {
  const under = (shift: OttavaSpec['shift'], sounding: number): ScoreSpec => ({
    notes: [
      { at: 0, midi: sounding },
      { at: 1, midi: D4 },
    ],
    ottavas: [{ staff: 0, start: 0, end: 1, shift }],
  })

  it('8va: written C4 (sounding C5) — C4 and unrelated D5 both highlight at once; C5 advances cleanly', () => {
    const d = driver(under(1, C5))
    d.tap(C4)
    expect(d.of('ottava-warning')).toEqual([{ type: 'ottava-warning', group: 0, spans: [0] }])
    expect(d.state.ottavaWarning).toEqual([0])
    // One mistake reveals the names (default threshold 1); the emphasis is independent of it.
    expect(d.of('hint-shown')).toHaveLength(1)
    d.tap(D5)
    expect(d.of('ottava-warning')).toHaveLength(1)
    expect(d.state.ottavaWarning).toEqual([0])
    d.tap(C5)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.ottavaWarning).toEqual([])
    expect(d.of('ottava-cleared')).toHaveLength(1)
  })

  it('correct sounding pitch under 8va advances with no error and no warning', () => {
    const d = driver(under(1, C5))
    d.tap(C5)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.wrongAttacks).toBe(0)
    expect(d.of('ottava-warning')).toHaveLength(0)
  })

  for (const [shift, sounding, name] of [
    [-1, C3, '8vb'],
    [2, C6, '15ma'],
    [-2, C2, '15mb'],
  ] as const) {
    it(`${name}: the first wrong attack highlights; the sounding pitch advances`, () => {
      const d = driver(under(shift, sounding))
      d.tap(C4)
      expect(d.state.ottavaWarning).toEqual([0])
      d.tap(sounding)
      expect(d.state.groupIndex).toBe(1)
      expect(d.state.ottavaWarning).toEqual([])
    })
  }

  it('without an applicable span the ordinary feedback is used', () => {
    const d = driver(under(1, C5))
    d.tap(C5).tap(C4)
    expect(d.of('wrong')).toHaveLength(1)
    expect(d.of('ottava-warning')).toHaveLength(0)
  })
})

describe('Acceptance: Ottava scope and visibility (engine side)', () => {
  const twoSpans: ScoreSpec = {
    notes: [
      { at: 0, midi: C5, hand: 'R' },
      { at: 0, midi: C3, hand: 'L', dur: 2 },
      { at: 1, midi: D5, hand: 'R' },
      { at: 2, midi: D4, hand: 'R' },
    ],
    ottavas: [
      { staff: 0, start: 0, end: 2, shift: 1 },
      { staff: 1, start: 0, end: 3, shift: -1 },
    ],
  }

  it('both hands: every applicable active span, including a staff that is holding or resting', () => {
    const d = driver(twoSpans)
    d.tap(C3, C5)
    d.tap(C4)
    expect(d.state.ottavaWarning).toEqual([0, 1])
  })

  it('one hand: only the selected part’s spans', () => {
    const d = driver(twoSpans, 'right')
    d.tap(C4)
    expect(d.state.ottavaWarning).toEqual([0])
  })

  it('a span never extends past its end, even under a held note', () => {
    const d = driver(twoSpans)
    d.tap(C3, C5).tap(D5)
    expect(d.state.groupIndex).toBe(2)
    d.tap(C4)
    expect(d.state.ottavaWarning).toEqual([1])
  })

  it('persists through repeated errors until correct completion', () => {
    const d = driver(twoSpans, 'right')
    d.tap(C4).wait(500).tap(C4).wait(500).tap(D4)
    expect(d.state.ottavaWarning).toEqual([0])
    expect(d.of('ottava-warning')).toHaveLength(1)
    d.tap(C5)
    expect(d.state.ottavaWarning).toEqual([])
  })

  it('clears on seeking', () => {
    const d = driver(twoSpans, 'right')
    d.tap(C4)
    d.engine.seek(1, d.now)
    expect(d.state.ottavaWarning).toEqual([])
    expect(d.of('ottava-cleared')).toHaveLength(1)
  })

  it('clears on restart and on interruption', () => {
    const d = driver(twoSpans, 'right', 'scored')
    d.tap(C4)
    expect(d.state.ottavaWarning).toEqual([0])
    d.engine.restart(d.now)
    expect(d.state.ottavaWarning).toEqual([])
    d.engine.markPrepared(d.now)
    d.wait(300) // the retired automatic hint fades before Ready
    d.tap(C4)
    expect(d.state.ottavaWarning).toEqual([0])
    d.engine.interrupt('disconnect', d.now)
    expect(d.state.ottavaWarning).toEqual([])
  })
})
