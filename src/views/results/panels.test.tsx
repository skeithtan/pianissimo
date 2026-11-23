// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'preact/hooks'
import { attemptRecord, comparisonContext, noAssistance, occurrences } from '../../core/history/testkit'
import { contextKey } from '../../core/model/practice'
import type { AttemptRecord, ComparisonContext } from '../../core/model/practice'
import { $, $$, click, mount, type Mounted } from '../shared/testing'
import { DEVICE_DATES, untranslatedText, useCatalog, usePseudoCatalog } from '../shared/catalogTesting'
import { percentage } from '../../i18n/messages'
import { HistoryPanel } from './HistoryPanel'
import { ScorecardPanel } from './ScorecardPanel'
import { deriveResults } from './model'

const NOW = new Date('2026-10-29T12:00:00').getTime()
const SCORE = occurrences(40)
const A = comparisonContext()
const B = comparisonContext({ hands: 'left', transport: 'accompaniment', multiplier: 0.5 })

let n = 0
function attempt(context: ComparisonContext, at: number, over: Partial<AttemptRecord> = {}): AttemptRecord {
  n += 1
  return attemptRecord({ id: `p${n}`, createdAt: at, context, contextKey: contextKey(context), ...over })
}

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

/** The scorecard of the latest (or chosen) attempt over the history of its context. */
function Panels({ attempts }: { attempts: readonly AttemptRecord[] }) {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const { attempt: shown, scorecard, history } = deriveResults({ attempts, occurrences: SCORE, attemptId: selected })
  if (!shown || !scorecard) return null
  return (
    <>
      <ScorecardPanel attempt={shown} scorecard={scorecard} isLatest={selected === undefined} now={NOW} />
      {history ? (
        <HistoryPanel history={history} contextText="" selectedId={shown.id} onSelect={setSelected} now={NOW} />
      ) : null}
    </>
  )
}

function show(attempts: AttemptRecord[]): HTMLElement {
  view = mount(<Panels attempts={attempts} />)
  return view.container
}

const row = (root: HTMLElement, id: string): HTMLElement | null => $(root, `[data-row="${id}"]`)
const dd = (root: HTMLElement, id: string): string => row(root, id)?.querySelector('dd')?.textContent ?? ''

describe('scorecard', () => {
  it('shows every result row of the latest completed attempt', () => {
    const a = attempt(A, NOW - 60_000, {
      completionTimeSec: 9.2,
      expectedTimeSec: 8,
      notatedDurationSec: 10.5,
      groupsTotal: 8,
      groupsFirstPass: 6,
      wrongAttacks: 3,
      passed: false,
    })
    const root = show([a])
    expect($(root, 'h2')?.textContent).toBe('Latest attempt')
    expect(root.textContent).toContain('Completed')
    expect(dd(root, 'wrong-attacks')).toContain('3')
    expect(dd(root, 'first-pass')).toContain('75%')
    expect(dd(root, 'first-pass')).toContain('6 of 8 onset groups')
    expect(dd(root, 'completion-time')).toContain('9.2 s')
    expect(dd(root, 'expected-time')).toContain('8.0 s')
    expect(dd(root, 'time-difference')).toContain('+1.2 s (+15%)')
    expect(dd(root, 'time-difference')).toContain('faster is not automatically better')
    expect(dd(root, 'notated-duration')).toContain('10.5 s')
    // Help is not told apart (U144).
    expect(row(root, 'assistance')).toBeNull()
    expect(root.textContent).toContain('Not a pass: wrong-note attacks')
    // The definition of completion time is available in the details.
    const details = $$(root, 'details').find((d) => d.textContent?.includes('How completion time is measured'))
    expect(details?.textContent).toContain('first key press')
    expect(details?.textContent).toContain('not proof of rhythm accuracy')
  })

  it('shows the rhythm mode rows instead of the completion time', () => {
    const S = comparisonContext({ transport: 'strict', matchingRules: 'strict-v1-tol-150ms' })
    const a = attempt(S, NOW - 1000, {
      rhythm: { toleranceMs: 150 },
      groupsTotal: 3,
      groupsFirstPass: 3,
      passed: false,
      missedGroups: 1,
      groups: [
        { group: 0, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, offsetMs: 60 },
        { group: 1, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, offsetMs: 100 },
        { group: 2, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, missed: true },
      ],
    })
    const root = show([a])
    expect(dd(root, 'on-time')).toContain('2 of 3 (67%)')
    expect(dd(root, 'missed')).toContain('1')
    expect(dd(root, 'offset')).toContain('+80 ms, dragging')
    expect(dd(root, 'tolerance')).toContain('within ±150 ms')
    expect($(root, '[data-row="completion-time"]')).toBeNull()
    expect($(root, '[data-row="expected-time"]')).toBeNull()
    expect(root.textContent).toContain('Not a pass: some groups were missed')
    expect($(root, '[data-row="best-clean"]')?.textContent).toContain('No completion')
    // Its only pass is not clean, though no note was wrong.
    expect($$(root, '[data-group="errors"] [data-attempt]')).toHaveLength(1)
  })

  it('summarizes a clean rhythm mode history by on-time groups and offset', () => {
    const S = comparisonContext({ transport: 'strict', matchingRules: 'strict-v1-tol-150ms' })
    const a = attempt(S, NOW - 1000, {
      rhythm: { toleranceMs: 150 },
      groupsTotal: 2,
      groups: [
        { group: 0, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, offsetMs: -20 },
        { group: 1, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, offsetMs: 40 },
      ],
    })
    const root = show([a])
    const best = $(root, '[data-row="best-clean"]')?.textContent ?? ''
    expect(best).toContain('±30 ms')
    expect(best).toContain('Smallest average offset')
    expect(root.textContent).toContain('2 of 2 on time')
    expect(root.textContent).toContain('Ranked by average offset from the music.')
  })

  it('breaks wrong attacks down by "too early" when the record carries the count', () => {
    const a = { ...attempt(A, NOW - 1000, { wrongAttacks: 4, passed: false }), earlyAttacks: 3 } as AttemptRecord
    expect(dd(show([a]), 'wrong-attacks')).toContain('3 of them too early')
  })

  it('single-group passages show errors but no tempo ratio', () => {
    const a = attempt(A, NOW - 1000, {
      groupsTotal: 1,
      groupsFirstPass: 1,
      completionTimeSec: 2.34,
      expectedTimeSec: null,
      notatedDurationSec: null,
    })
    const root = show([a])
    expect(dd(root, 'completion-time')).toContain('2.3 s')
    expect(row(root, 'completion-time')?.querySelector('dt')?.textContent).toBe('Time to solve')
    expect(dd(root, 'completion-time')).toContain('Ungraded')
    expect(row(root, 'expected-time')).toBeNull()
    expect(row(root, 'time-difference')).toBeNull()
    expect(row(root, 'notated-duration')).toBeNull()
    expect(row(root, 'wrong-attacks')).not.toBeNull()
  })

  it('incomplete attempts are diagnostics with no completion time', () => {
    const a = attempt(A, NOW - 1000, {
      completion: 'interrupted',
      interruptReason: 'pause',
      wrongAttacks: 1,
      passed: false,
      groupsFirstPass: 3,
      groupsTotal: 8,
    })
    const root = show([a])
    expect(root.textContent).toContain('Interrupted')
    expect(root.textContent).toContain('Paused')
    expect(root.textContent).toContain('stay out of rankings')
    expect(dd(root, 'completion-time')).toContain('Not completed')
    expect(row(root, 'time-difference')).toBeNull()
    expect(root.textContent).toContain('Incomplete: not counted as a pass or a fail')
  })

  it('timing-unscored attempts say why', () => {
    const a = attempt(A, NOW - 1000, { timingUnscoredReason: 'a fermata is not resolved', completionTimeSec: 6 })
    const root = show([a])
    expect(dd(root, 'completion-time')).toContain('Timing not scored: a fermata is not resolved')
    expect(row(root, 'time-difference')).toBeNull()
  })

  it('notes that ordinary reading is not compared', () => {
    const reading = attempt(A, NOW - 1000, { kind: 'reading' })
    const root = show([reading])
    expect(root.textContent).toContain('ordinary reading')
    expect($(root, '[data-panel="history"]')).toBeNull()
  })
})

describe('history is limited to one comparison context', () => {
  const attempts = [
    attempt(A, NOW - 500_000, { completionTimeSec: 7.9, expectedTimeSec: 8 }),
    attempt(A, NOW - 400_000, { completionTimeSec: 8.6, expectedTimeSec: 8 }),
    attempt(A, NOW - 300_000, { wrongAttacks: 2, passed: false }),
    attempt(A, NOW - 200_000, { passed: false, assistance: { ...noAssistance(), level: 'names', hintRequests: 1 } }),
    attempt(A, NOW - 100_000, {
      completion: 'abandoned',
      interruptReason: 'user-stop',
      wrongAttacks: 1,
      passed: false,
    }),
    attempt(B, NOW - 50_000, { completionTimeSec: 12, expectedTimeSec: 12 }),
    attempt(A, NOW - 10_000, { completionTimeSec: 8.1, expectedTimeSec: 8 }),
  ]

  it('lists clean, other and incomplete attempts apart, help or not', () => {
    const root = show(attempts)
    // Latest is the newest, context A.
    const history = $(root, '[data-panel="history"]') as HTMLElement
    const group = (kind: string) =>
      $$(history, `[data-group="${kind}"] [data-attempt]`).map((b) => b.getAttribute('data-attempt'))
    const ids = attempts.map((a) => a.id)
    // Clean ranking: closest to expected first; equally close, the recent one; untimed last.
    expect(new Set(group('clean'))).toEqual(new Set([ids[6], ids[0], ids[1], ids[3]]))
    expect(group('clean').filter((id) => id !== ids[3])).toEqual([ids[6], ids[0], ids[1]])
    expect(group('errors')).toEqual([ids[2]])
    expect(group('incomplete')).toEqual([ids[4]])
    // The other context's attempt is nowhere in this context's history...
    expect($$(history, '[data-attempt]').some((b) => b.getAttribute('data-attempt') === ids[5])).toBe(false)
  })

  it('shows the best clean pass and marks it', () => {
    const root = show(attempts.filter((a) => a !== attempts[3]))
    const best = $(root, '[data-row="best-clean"]')
    expect(best?.textContent).toContain('Best clean')
    expect(best?.textContent).toContain('8.1 s')
    expect(best?.textContent).toContain('+0.1 s from expected')
    expect(best?.textContent).toContain('faster is not automatically better')
    expect($(root, '[data-group="incomplete"]')?.textContent).toContain('Stopped')
    expect($(root, '[data-group="incomplete"]')?.textContent).toContain('Diagnostics only')
  })

  it('shows the practice streak for the context', () => {
    const root = show(attempts)
    // Most recent completed A attempt passed; before it the abandoned-after-mistakes stop reset the run.
    expect($(root, '[data-row="streak"]')?.textContent).toContain('1')
    expect($(root, '[data-row="streak"]')?.textContent).toContain('Best 2')
  })

  it('selecting a history row shows that attempt', () => {
    const root = show(attempts)
    expect($(root, 'h2')?.textContent).toBe('Latest attempt')
    click($(root, `[data-attempt="${attempts[2]?.id}"]`))
    expect($(root, 'h2')?.textContent).toBe('Earlier attempt')
    expect(dd(root, 'wrong-attacks')).toContain('2')
    expect($(root, `[data-attempt="${attempts[2]?.id}"]`)?.getAttribute('aria-current')).toBe('true')
  })

  it('says plainly when there is no clean run yet', () => {
    const root = show([attempt(A, NOW - 1000, { wrongAttacks: 1, passed: false })])
    expect($(root, '[data-row="best-clean"]')?.textContent).toContain('No completion with zero wrong notes yet')
    expect($(root, '[data-group="clean"]')).toBeNull()
  })
})

describe('translation coverage', () => {
  it('shows no text that bypasses the catalogs', () => {
    const restore = usePseudoCatalog()
    try {
      const attempts = [
        attempt(A, NOW - 500_000, { completionTimeSec: 7.9, expectedTimeSec: 8 }),
        attempt(A, NOW - 300_000, { wrongAttacks: 2, passed: false }),
        attempt(A, NOW - 100_000, { completion: 'abandoned', interruptReason: 'user-stop', passed: false }),
        attempt(B, NOW - 50_000, { completionTimeSec: 12, expectedTimeSec: 12 }),
        attempt(A, NOW - 10_000, { completionTimeSec: 8.1, expectedTimeSec: 8 }),
      ]
      const root = show(attempts)
      expect(untranslatedText(root, DEVICE_DATES)).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('in Japanese and French', () => {
  it.each([
    ['ja-JP', 'この条件での最高記録：3回'],
    ['fr-FR', 'Meilleure série avec ces réglages\u00a0: 3'],
  ] as const)('%s: the best streak is one sentence', (language, best) => {
    const restore = useCatalog(language)
    try {
      const root = show([
        attempt(A, NOW - 500_000, { completionTimeSec: 7.9, expectedTimeSec: 8 }),
        attempt(A, NOW - 400_000, { completionTimeSec: 8.6, expectedTimeSec: 8 }),
        attempt(A, NOW - 10_000, { completionTimeSec: 9.2, expectedTimeSec: 8 }),
      ])
      expect($(root, '[data-row="streak"] p:last-child')?.textContent).toBe(best)
      expect(dd(root, 'time-difference')).toContain(`(+${percentage(0.15)})`)
    } finally {
      restore()
    }
  })

  it.each([
    ['en-US', 'No wrong notes'],
    ['es-ES', 'Sin notas incorrectas'],
    ['fr-FR', 'Aucune fausse note'],
  ] as const)('%s: "none" agrees with the feminine nouns of the scorecard', (language, wrong) => {
    const restore = useCatalog(language)
    try {
      const root = show([attempt(A, NOW - 1000, { completionTimeSec: 8, expectedTimeSec: 8 })])
      expect(row(root, 'wrong-attacks')?.querySelector('dd span:last-child')?.textContent).toBe(wrong)
    } finally {
      restore()
    }
  })
})
