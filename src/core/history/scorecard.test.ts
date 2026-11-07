import { describe, expect, it } from 'vitest'
import type { AttemptRecord, GroupOutcome } from '../model/practice'
import { COMPLETION_TIME_DEFINITION, buildScorecard, formatSeconds } from './scorecard'
import { attemptRecord, comparisonContext, noAssistance } from './testkit'

const row = (card: ReturnType<typeof buildScorecard>, id: string) => card.rows.find((r) => r.id === id)

describe('scorecard', () => {
  it('reports the defined rows without a points total', () => {
    const card = buildScorecard(
      attemptRecord({
        wrongAttacks: 2,
        groupsTotal: 8,
        groupsFirstPass: 6,
        completionTimeSec: 9.5,
        expectedTimeSec: 8,
        notatedDurationSec: 10,
      }),
      { current: 2, best: 5 },
    )
    expect(card.rows.map((r) => r.id)).toEqual([
      'completion',
      'wrong-attacks',
      'first-pass',
      'completion-time',
      'expected-time',
      'time-difference',
      'assistance',
      'streak',
    ])
    expect(row(card, 'completion')?.value).toBe('Completed')
    expect(row(card, 'wrong-attacks')?.value).toBe('2')
    expect(row(card, 'first-pass')).toMatchObject({ value: '75%', detail: '6 of 8' })
    expect(row(card, 'completion-time')).toMatchObject({ label: 'Completion time', value: '9.5 s' })
    expect(row(card, 'completion-time')?.detail).toBe(COMPLETION_TIME_DEFINITION)
    expect(row(card, 'expected-time')).toMatchObject({ value: '8.0 s', detail: 'Notated passage 10.0 s' })
    expect(row(card, 'time-difference')?.value).toBe('+1.5 s (+19%)')
    expect(row(card, 'assistance')?.value).toBe('None')
    expect(row(card, 'streak')).toMatchObject({ value: '2', detail: 'Best 5' })
    expect(card.timing).toBe('scored')
    expect(card.timeDifferenceSec).toBeCloseTo(1.5)
    expect(card.timeDifferencePercent).toBeCloseTo(18.75)
  })

  it('shows a negative difference and omits the streak row without one', () => {
    const card = buildScorecard(attemptRecord({ completionTimeSec: 6, expectedTimeSec: 8 }))
    expect(row(card, 'time-difference')?.value).toBe('-2.0 s (-25%)')
    expect(row(card, 'streak')).toBeUndefined()
  })

  it('has no percentage when the expected time is zero', () => {
    const card = buildScorecard(attemptRecord({ completionTimeSec: 0.5, expectedTimeSec: 0 }))
    expect(card.timeDifferencePercent).toBeNull()
    expect(row(card, 'time-difference')?.value).toBe('+0.5 s')
  })

  it('offers an ungraded time-to-solve for a single onset group', () => {
    const card = buildScorecard(
      attemptRecord({ groupsTotal: 1, groupsFirstPass: 1, completionTimeSec: 3.2, expectedTimeSec: null }),
    )
    expect(card.timing).toBe('ungraded')
    expect(row(card, 'completion-time')).toMatchObject({ label: 'Time to solve', value: '3.2 s' })
    expect(row(card, 'expected-time')).toBeUndefined()
    expect(row(card, 'time-difference')).toBeUndefined()
  })

  it('leaves timing unscored when a fermata or tempo issue is unresolved', () => {
    const card = buildScorecard(
      attemptRecord({ timingUnscoredReason: 'Unresolved fermata in bar 8', expectedTimeSec: null }),
    )
    expect(card.timing).toBe('unscored')
    expect(card.timingNote).toBe('Unresolved fermata in bar 8')
    expect(row(card, 'completion-time')).toMatchObject({ value: '—', detail: 'Unresolved fermata in bar 8' })
    expect(card.timeDifferenceSec).toBeNull()
  })

  it('describes interrupted attempts without a completion time', () => {
    const { completionTimeSec: _omit, ...rest } = attemptRecord()
    const card = buildScorecard({
      ...rest,
      completion: 'interrupted',
      interruptReason: 'disconnect',
      passed: false,
    } as AttemptRecord)
    expect(row(card, 'completion')).toMatchObject({ value: 'Interrupted', detail: 'piano disconnected' })
    expect(card.timing).toBe('none')
    expect(row(card, 'completion-time')?.detail).toBe('Not completed')
  })

  it('keeps persistent labels distinct from temporary hints in the assistance row', () => {
    const labeled = buildScorecard(
      attemptRecord({
        assistance: {
          ...noAssistance(),
          level: 'names',
          persistentLabelNotes: [1, 2, 3],
          persistentLabelGroups: [0, 1],
          labelSettings: { mode: 'conditional', rulesJson: '{}' },
        },
      }),
    )
    expect(row(labeled, 'assistance')).toMatchObject({
      value: 'Note names',
      detail: 'persistent labels on 3 notes in 2 groups',
    })
    expect(labeled.assistance).toMatchObject({ hintRequests: 0, persistentLabelNotes: 3, labelMode: 'conditional' })

    const hinted = buildScorecard(
      attemptRecord({
        assistance: { ...noAssistance(), level: 'names', hintRequests: 1, autoHints: 2, hintGroups: [4] },
      }),
    )
    expect(row(hinted, 'assistance')?.detail).toBe('1 hint request, 2 automatic hints, 1 group revealed by hints')
    expect(hinted.assistance).toMatchObject({ hintRequests: 1, autoHints: 2, persistentLabelNotes: 0 })

    const keyboard = buildScorecard(
      attemptRecord({ assistance: { ...noAssistance(), level: 'keyboard', keyboardShown: true } }),
    )
    expect(row(keyboard, 'assistance')).toMatchObject({ value: 'Keyboard guide', detail: 'keyboard guide shown' })
  })

  it('handles an attempt without groups', () => {
    const card = buildScorecard(attemptRecord({ groupsTotal: 0, groupsFirstPass: 0 }))
    expect(card.firstPassPercent).toBeNull()
    expect(row(card, 'first-pass')?.value).toBe('—')
  })
})

describe('formatSeconds', () => {
  it('uses seconds below a minute and minutes beyond', () => {
    expect(formatSeconds(2.04)).toBe('2.0 s')
    expect(formatSeconds(59.94)).toBe('59.9 s')
    expect(formatSeconds(65.25)).toBe('1:05.3')
    expect(formatSeconds(600)).toBe('10:00.0')
    expect(formatSeconds(-90)).toBe('-1:30.0')
  })

  it('rounds to tenths before splitting minutes and drops the sign of a zero', () => {
    expect(formatSeconds(119.97)).toBe('2:00.0')
    expect(formatSeconds(59.96)).toBe('1:00.0')
    expect(formatSeconds(-59.96)).toBe('-1:00.0')
    expect(formatSeconds(-0.04)).toBe('0.0 s')
    expect(formatSeconds(0)).toBe('0.0 s')
    expect(formatSeconds(3599.96)).toBe('60:00.0')
  })
})

describe('rhythm mode scorecard', () => {
  const ctx = comparisonContext({ transport: 'strict', matchingRules: 'strict-v1-tol-150ms' })
  const g = (group: number, extra: Partial<GroupOutcome> = {}): GroupOutcome => ({
    group,
    wrongAttacks: 0,
    earlyAttacks: 0,
    lateMs: 0,
    ...extra,
  })
  const strict = (groups: GroupOutcome[], over: Partial<AttemptRecord> = {}) =>
    attemptRecord({ context: ctx, rhythm: { toleranceMs: 150 }, groups, groupsTotal: groups.length, ...over })

  it('shows the timing rows in order and hides completion time rows', () => {
    const groups = [
      ...Array.from({ length: 8 }, (_, i) => g(i, { offsetMs: 30 })),
      g(8, { offsetMs: -200 }),
      g(9, { missed: true }),
    ]
    const card = buildScorecard(strict(groups, { missedGroups: 1, passed: false }), { current: 0, best: 2 })
    expect(card.timing).toBe('rhythm')
    expect(card.rows.map((r) => r.id)).toEqual([
      'completion',
      'wrong-attacks',
      'first-pass',
      'on-time',
      'early',
      'late',
      'missed',
      'offset',
      'tolerance',
      'assistance',
      'streak',
    ])
    expect(row(card, 'on-time')?.value).toBe('8 of 10 (80%)')
    expect(row(card, 'early')?.value).toBe('1')
    expect(row(card, 'late')?.value).toBe('0')
    expect(row(card, 'missed')?.value).toBe('1')
    expect(row(card, 'tolerance')?.value).toBe('within ±150 ms')
    expect(card.passed).toBe(false)
  })

  it('names dragging and rushing only beyond a third of the tolerance', () => {
    const offset = (ms: number) => row(buildScorecard(strict([g(0, { offsetMs: ms })])), 'offset')?.value
    expect(offset(23)).toBe('+23 ms')
    expect(offset(50)).toBe('+50 ms')
    expect(offset(51)).toBe('+51 ms, dragging')
    expect(offset(-18)).toBe('−18 ms')
    expect(offset(-90)).toBe('−90 ms, rushing')
    expect(offset(0)).toBe('0 ms')
  })

  it('an incomplete strict attempt shows no timing at all', () => {
    const card = buildScorecard(strict([g(0, { offsetMs: 10 })], { completion: 'abandoned', completionTimeSec: 3 }))
    expect(card.timing).toBe('none')
    expect(card.rows.map((r) => r.id)).toEqual(['completion', 'wrong-attacks', 'first-pass', 'assistance'])
  })
})
