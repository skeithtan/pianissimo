import { describe, expect, it } from 'vitest'
import type { OnsetGroup, Timeline } from '../../core/engine/timeline'
import type { AttemptRecord, GroupOutcome } from '../../core/model/practice'
import { type Rational, ZERO, rat } from '../../core/music/rational'
import { QUARTER, type TempoMapData, quarterBpmFromBeat, userTempoMap } from '../../core/music/tempo'
import { LATE_MARK_MS, PAUSE_MAX_MS, PAUSE_MIN_MS, pauseThresholdMs, pausedGroups } from './pauses'

const groupAt = (position: Rational): Pick<OnsetGroup, 'position'> => ({ position })

const tempoTimeline = (tempo: TempoMapData, multiplier = 1, positions: Rational[] = [ZERO]): Timeline =>
  ({
    tempo,
    multiplier,
    groups: positions.map((position, index) => ({ index, position })),
  }) as unknown as Timeline

const outcome = (group: number, lateMs: number, wrongAttacks = 0, earlyAttacks = 0): GroupOutcome => ({
  group,
  wrongAttacks,
  earlyAttacks,
  lateMs,
})

const gatedRecord = (groups?: GroupOutcome[]): AttemptRecord =>
  ({
    groups,
    context: { transport: 'accompaniment' },
  }) as unknown as AttemptRecord

describe('pauseThresholdMs', () => {
  it('returns half a beat at the practice speed for standard tempos', () => {
    expect(pauseThresholdMs(tempoTimeline(userTempoMap(60), 1), groupAt(ZERO))).toBe(500)
    expect(pauseThresholdMs(tempoTimeline(userTempoMap(120), 1), groupAt(ZERO))).toBe(250)
    expect(pauseThresholdMs(tempoTimeline(userTempoMap(120), 0.5), groupAt(ZERO))).toBe(500)
  })

  it('clamps to [PAUSE_MIN_MS, PAUSE_MAX_MS] at very slow and very fast speeds', () => {
    // 40 bpm -> half beat is 750 ms -> clamped to 600 ms
    expect(pauseThresholdMs(tempoTimeline(userTempoMap(40), 1), groupAt(ZERO))).toBe(PAUSE_MAX_MS)
    // 180 bpm -> half beat is 166.7 ms -> clamped to 250 ms
    expect(pauseThresholdMs(tempoTimeline(userTempoMap(180), 1), groupAt(ZERO))).toBe(PAUSE_MIN_MS)
  })

  it('uses the tempo at the group position across a tempo change', () => {
    const tempo: TempoMapData = {
      segments: [
        { start: ZERO, quarterBpm: 60, beatUnit: QUARTER, beatBpm: 60, source: 'metronome' },
        { start: rat(1), quarterBpm: 120, beatUnit: QUARTER, beatBpm: 120, source: 'metronome' },
      ],
    }
    const tl = tempoTimeline(tempo, 1, [ZERO, rat(1)])
    expect(pauseThresholdMs(tl, groupAt(ZERO))).toBe(500)
    expect(pauseThresholdMs(tl, groupAt(rat(1)))).toBe(250)
  })

  it('counts half of the displayed beat unit (e.g. dotted quarter in compound time)', () => {
    const dottedQuarter = rat(3, 8)
    const tempo: TempoMapData = {
      segments: [
        {
          start: ZERO,
          quarterBpm: quarterBpmFromBeat(60, dottedQuarter),
          beatUnit: dottedQuarter,
          beatBpm: 60,
          source: 'metronome',
        },
      ],
    }
    expect(pauseThresholdMs(tempoTimeline(tempo, 1), groupAt(ZERO))).toBe(500)
  })

  it('falls back to LATE_MARK_MS when there is no tempo', () => {
    const empty: TempoMapData = { segments: [] }
    expect(pauseThresholdMs(tempoTimeline(empty, 1), groupAt(ZERO))).toBe(LATE_MARK_MS)
  })
})

describe('pausedGroups', () => {
  const tl = tempoTimeline(userTempoMap(120), 1, [ZERO, rat(1, 4), rat(1, 2), rat(3, 4), rat(1)])
  // Threshold at 120 bpm speed 1 is 250 ms.

  it('returns ascending group indices at or above threshold with zero wrongAttacks', () => {
    const record = gatedRecord([
      outcome(0, 0),
      outcome(1, 249), // below threshold
      outcome(2, 250), // at threshold
      outcome(3, 400, 1, 0), // wrong key -> not a pause
      outcome(4, 400, 1, 1), // early press (counted in wrongAttacks) -> not a pause
    ])
    expect(pausedGroups(record, tl)).toEqual([2])
  })

  it('returns groups in ascending order', () => {
    const record = gatedRecord([outcome(4, 300), outcome(1, 250)])
    expect(pausedGroups(record, tl)).toEqual([1, 4])
  })

  it('returns empty for strict (Keep time) records', () => {
    const strictByTransport = {
      groups: [outcome(1, 500)],
      context: { transport: 'strict' },
    } as unknown as AttemptRecord
    const strictByRhythm = {
      groups: [outcome(1, 500)],
      rhythm: { toleranceMs: 150 },
      context: { transport: 'strict' },
    } as unknown as AttemptRecord
    expect(pausedGroups(strictByTransport, tl)).toEqual([])
    expect(pausedGroups(strictByRhythm, tl)).toEqual([])
  })

  it('returns empty for records without per-group outcomes', () => {
    expect(pausedGroups(gatedRecord(undefined), tl)).toEqual([])
    expect(pausedGroups(gatedRecord([]), tl)).toEqual([])
  })
})
