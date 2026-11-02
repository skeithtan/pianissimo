// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'preact/hooks'
import { selectSuggestions } from '../../core/history'
import type { SuggestionSelection } from '../../core/history'
import { attemptRecord, comparisonContext, fresh, noAssistance, occurrences, play } from '../../core/history/testkit'
import { contextKey } from '../../core/model/practice'
import type { AttemptRecord, ComparisonContext } from '../../core/model/practice'
import { makePackage, makePiece } from '../../core/storage/testkit'
import { $, $$, byText, click, mount, type Mounted } from '../shared/testing'
import { DISABLED_RULE, TREBLE_PRESET } from '../../core/model/settings'
import { ResultsPage } from './ResultsView'
import { labelRules } from './ScorecardPanel'
import type { ResultsPageProps } from './ResultsView'
import type { ResultsData } from './data'

const NOW = new Date('2026-10-29T12:00:00').getTime()
const SCORE = occurrences(40)
const A = comparisonContext()
const B = comparisonContext({ hands: 'left', transport: 'accompaniment', multiplier: 0.5 })

let n = 0
function attempt(context: ComparisonContext, at: number, over: Partial<AttemptRecord> = {}): AttemptRecord {
  n += 1
  return attemptRecord({ id: `p${n}`, createdAt: at, context, contextKey: contextKey(context), ...over })
}

const pkg = makePackage('v1', 'Gymnopédie')
const piece = makePiece(pkg, { title: 'Gymnopédie', composer: 'Satie' })

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

function data(attempts: AttemptRecord[], extra: Partial<ResultsData> = {}): ResultsData {
  return {
    piece,
    attempts,
    occurrences: SCORE,
    suggestions: { active: [], improved: [], disabled: false },
    ...extra,
  }
}

const noop = () => undefined

/** The page with its own selection state, as the loader provides. */
function Harness({
  d,
  suggestions,
  over,
}: {
  d: ResultsData
  suggestions?: SuggestionSelection
  over?: Partial<ResultsPageProps>
}) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <ResultsPage
      data={d}
      selectedId={selected}
      suggestions={suggestions ?? d.suggestions}
      now={NOW}
      onSelect={setSelected}
      onPracticeAgain={noop}
      onPracticeSuggestion={noop}
      onDismissSuggestion={noop}
      onDisableSuggestions={noop}
      onEnableSuggestions={noop}
      onOpenLibrary={noop}
      onOpenSettings={noop}
      {...over}
    />
  )
}

function show(d: ResultsData, over?: Partial<ResultsPageProps>, suggestions?: SuggestionSelection): HTMLElement {
  view = mount(<Harness d={d} {...(suggestions ? { suggestions } : {})} {...(over ? { over } : {})} />)
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
    const root = show(data([a]))
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
    expect(dd(root, 'assistance')).toContain('None')
    expect(root.textContent).toContain('Not a pass: wrong-note attacks')
    // The definition of completion time is available in the details.
    const details = $$(root, 'details').find((d) => d.textContent?.includes('How completion time is measured'))
    expect(details?.textContent).toContain('first key press')
    expect(details?.textContent).toContain('not proof of rhythm accuracy')
  })

  it('breaks wrong attacks down by "too early" when the record carries the count', () => {
    const a = { ...attempt(A, NOW - 1000, { wrongAttacks: 4, passed: false }), earlyAttacks: 3 } as AttemptRecord
    expect(dd(show(data([a])), 'wrong-attacks')).toContain('3 of them too early')
  })

  it('keeps persistent labels distinct from temporary hints and the keyboard guide', () => {
    const labels = attempt(A, NOW - 3000, {
      passed: false,
      assistance: {
        ...noAssistance(),
        level: 'names',
        persistentLabelNotes: [3, 4, 5],
        persistentLabelGroups: [1, 2],
        labelSettings: { mode: 'conditional', rulesJson: '{}' },
      },
    })
    let root = show(data([labels]))
    expect(dd(root, 'assistance')).toContain('Note names')
    const lines = (id: string) => row(root, 'assistance')?.querySelector(`[data-row="${id}"]`)
    expect(lines('assist-labels')?.textContent).toContain('Setting: Conditional')
    expect(lines('assist-labels')?.textContent).toContain('3 notes in 2 groups')
    expect(lines('assist-labels')?.hasAttribute('data-used')).toBe(true)
    expect(lines('assist-hints')?.textContent).toContain('No hints were requested')
    expect(lines('assist-hints')?.hasAttribute('data-used')).toBe(false)
    expect(lines('assist-keyboard')?.textContent).toContain('Not shown')
    expect(row(root, 'assistance')?.textContent).not.toContain('hint request')
    view?.unmount()

    const hints = attempt(A, NOW - 2000, {
      passed: false,
      assistance: { ...noAssistance(), level: 'names', hintRequests: 2, autoHints: 1, hintGroups: [0, 1, 4] },
    })
    root = show(data([hints]))
    const hintLine = row(root, 'assistance')?.querySelector('[data-row="assist-hints"]')
    expect(hintLine?.textContent).toContain('2 hint requests (manual), 1 automatic hint. 3 groups revealed')
    expect(row(root, 'assistance')?.querySelector('[data-row="assist-labels"]')?.textContent).toContain(
      'No notes were revealed by labels',
    )
    view?.unmount()

    const keys = attempt(A, NOW - 1000, {
      passed: false,
      assistance: { ...noAssistance(), level: 'keyboard', keyboardShown: true },
    })
    root = show(data([keys]))
    expect(dd(root, 'assistance')).toContain('Keyboard guide')
    expect(row(root, 'assistance')?.querySelector('[data-row="assist-keyboard"]')?.textContent).toContain('Shown')
  })

  it('single-group passages show errors and assistance but no tempo ratio', () => {
    const a = attempt(A, NOW - 1000, {
      groupsTotal: 1,
      groupsFirstPass: 1,
      completionTimeSec: 2.34,
      expectedTimeSec: null,
      notatedDurationSec: null,
    })
    const root = show(data([a]))
    expect(dd(root, 'completion-time')).toContain('2.3 s')
    expect(row(root, 'completion-time')?.querySelector('dt')?.textContent).toBe('Time to solve')
    expect(dd(root, 'completion-time')).toContain('Ungraded')
    expect(row(root, 'expected-time')).toBeNull()
    expect(row(root, 'time-difference')).toBeNull()
    expect(row(root, 'notated-duration')).toBeNull()
    expect(row(root, 'wrong-attacks')).not.toBeNull()
    expect(row(root, 'assistance')).not.toBeNull()
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
    const root = show(data([a]))
    expect(root.textContent).toContain('Interrupted')
    expect(root.textContent).toContain('Paused')
    expect(root.textContent).toContain('stay out of rankings')
    expect(dd(root, 'completion-time')).toContain('Not completed')
    expect(row(root, 'time-difference')).toBeNull()
    expect(root.textContent).toContain('Incomplete: not counted as a pass or a fail')
  })

  it('timing-unscored attempts say why', () => {
    const a = attempt(A, NOW - 1000, { timingUnscoredReason: 'a fermata is not resolved', completionTimeSec: 6 })
    const root = show(data([a]))
    expect(dd(root, 'completion-time')).toContain('Timing not scored: a fermata is not resolved')
    expect(row(root, 'time-difference')).toBeNull()
  })

  it('notes that ordinary reading is not compared', () => {
    const reading = attempt(A, NOW - 1000, { kind: 'reading' })
    const root = show(data([reading]))
    expect(root.textContent).toContain('ordinary reading')
    expect($(root, '[data-panel="history"]')?.textContent).toContain('not compared')
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

  it('lists clean, errored, assisted and incomplete attempts apart', () => {
    const root = show(data(attempts))
    // Latest is the newest, context A.
    const history = $(root, '[data-panel="history"]') as HTMLElement
    const group = (kind: string) =>
      $$(history, `[data-group="${kind}"] [data-attempt]`).map((b) => b.getAttribute('data-attempt'))
    const ids = attempts.map((a) => a.id)
    // Clean ranking: closest to expected first (8.1 → 0.1, 7.9 → 0.1, 8.6 → 0.6; tie → recent).
    expect(group('clean')).toEqual([ids[6], ids[0], ids[1]])
    expect(group('errors')).toEqual([ids[2]])
    expect(group('assisted')).toEqual([ids[3]])
    expect(group('incomplete')).toEqual([ids[4]])
    // The other context's attempt is nowhere in this context's history...
    expect($$(history, '[data-attempt]').some((b) => b.getAttribute('data-attempt') === ids[5])).toBe(false)
    // ...but is reachable from its own entry.
    const others = $(root, '[data-panel="others"]')
    expect(others?.textContent).toContain('Left hand at 0.5×')
    expect(others?.textContent).toContain('1 attempt')
    expect(others?.textContent).toContain('12.0 s')
  })

  it('shows best clean unassisted separately and marks it', () => {
    const root = show(data(attempts))
    const best = $(root, '[data-row="best-clean"]')
    expect(best?.textContent).toContain('Best clean unassisted')
    expect(best?.textContent).toContain('8.1 s')
    expect(best?.textContent).toContain('+0.1 s from expected')
    expect(best?.textContent).toContain('faster is not automatically better')
    // The assisted attempt does not appear in the clean group or the best card.
    const cleanGroup = $(root, '[data-group="clean"]') as HTMLElement
    expect(cleanGroup.textContent).not.toContain('hint')
    expect($(root, '[data-group="assisted"]')?.textContent).toContain('note names')
    expect($(root, '[data-group="incomplete"]')?.textContent).toContain('Stopped')
    expect($(root, '[data-group="incomplete"]')?.textContent).toContain('Diagnostics only')
  })

  it('shows the practice streak for the context', () => {
    const root = show(data(attempts))
    // Most recent completed A attempt passed; before it the abandoned-after-mistakes stop reset the run.
    expect($(root, '[data-row="streak"]')?.textContent).toContain('1')
    expect($(root, '[data-row="streak"]')?.textContent).toContain('Best 2')
  })

  it('selecting a history row shows that attempt; Back to latest returns', () => {
    const root = show(data(attempts))
    expect($(root, 'h2')?.textContent).toBe('Latest attempt')
    click($(root, `[data-attempt="${attempts[2]?.id}"]`))
    expect($(root, 'h2')?.textContent).toBe('Earlier attempt')
    expect(dd(root, 'wrong-attacks')).toContain('2')
    expect($(root, `[data-attempt="${attempts[2]?.id}"]`)?.getAttribute('aria-current')).toBe('true')
    click(byText(root, 'Back to latest', 'button span')?.closest('button'))
    expect($(root, 'h2')?.textContent).toBe('Latest attempt')
  })

  it('View latest in another setting switches the whole page to that context', () => {
    const root = show(data(attempts))
    click($$(root, '[data-panel="others"] button')[0])
    expect($(root, '[data-row="context"]')?.textContent).toContain('Left hand at 0.5×')
    expect($(root, '[data-row="context"]')?.textContent).toContain('Piano plays the right hand')
    expect($(root, '[data-panel="history"]')?.textContent).toContain('Left hand at 0.5×')
    expect($$(root, '[data-panel="history"] [data-attempt]')).toHaveLength(1)
    // The first context is now the "other" one.
    expect($(root, '[data-panel="others"]')?.textContent).toContain('Both hands at 1×')
  })

  it('says plainly when there is no clean unassisted run yet', () => {
    const root = show(data([attempt(A, NOW - 1000, { wrongAttacks: 1, passed: false })]))
    expect($(root, '[data-row="best-clean"]')?.textContent).toContain(
      'No completion with zero wrong notes and no assistance yet',
    )
    expect($(root, '[data-group="clean"]')).toBeNull()
  })
})

describe('actions', () => {
  it('Practice again hands the attempt back with its context (never auto-starts)', () => {
    const onPracticeAgain = vi.fn()
    const a = attempt(B, NOW - 1000)
    const root = show(data([a]), { onPracticeAgain })
    click(byText(root, 'Practice again', 'button span')?.closest('button'))
    expect(onPracticeAgain).toHaveBeenCalledWith(a)
  })

  it('cannot practice again an attempt of an earlier score version', () => {
    const old = attempt(comparisonContext({ scoreVersionId: 'v0' }), NOW - 1000)
    const root = show(data([old]))
    const button = byText(root, 'Practice again', 'button span')?.closest('button')
    expect(button?.disabled).toBe(true)
    expect(root.textContent).toContain('earlier version of the score')
    expect($(root, '[data-suggestion]')).toBeNull()
  })

  it('shows an empty state with a way to start when nothing was recorded', () => {
    const onOpenLibrary = vi.fn()
    const root = show(data([]), { onOpenLibrary })
    expect($(root, '[data-state="no-attempts"]')?.textContent).toContain('No attempts yet')
    expect(byText(root, 'Open Practice', 'button span')).not.toBeNull()
    click(byText(root, 'Library', 'button span')?.closest('button'))
    expect(onOpenLibrary).toHaveBeenCalled()
  })

  it('warns when the requested attempt is not found', () => {
    const a = attempt(A, NOW - 1000)
    view = mount(
      <ResultsPage
        data={data([a])}
        selectedId="gone"
        suggestions={{ active: [], improved: [], disabled: false }}
        now={NOW}
        onSelect={noop}
        onPracticeAgain={noop}
        onPracticeSuggestion={noop}
        onDismissSuggestion={noop}
        onDisableSuggestions={noop}
        onEnableSuggestions={noop}
        onOpenLibrary={noop}
        onOpenSettings={noop}
      />,
    )
    expect(view.container.textContent).toContain('could not be found')
    expect(view.container.querySelector('h2')?.textContent).toBe('Latest attempt')
  })
})

describe('suggested practice in Results', () => {
  function withSuggestions(): { d: ResultsData; selection: SuggestionSelection } {
    let h = fresh()
    h = play(h, 12, ['error', 'clean', 'error', 'error', 'clean'])
    const selection = selectSuggestions(h, SCORE, { scoreVersionId: 'v1', enabled: true })
    return { d: data([attempt(A, NOW - 1000)]), selection }
  }

  it('renders the shared list and forwards Practice this passage, dismiss and disable', () => {
    const { d, selection } = withSuggestions()
    const onPracticeSuggestion = vi.fn()
    const onDismissSuggestion = vi.fn()
    const onDisableSuggestions = vi.fn()
    const root = show(d, { onPracticeSuggestion, onDismissSuggestion, onDisableSuggestions }, selection)
    expect(selection.active).toHaveLength(1)
    expect(root.textContent).toContain('Suggested practice')
    expect(root.textContent).toContain('Mistakes in bar 13 on 3 of your last 5 comparable passes.')
    click(byText(root, 'Practice this passage', 'button span')?.closest('button'))
    expect(onPracticeSuggestion).toHaveBeenCalledWith(selection.active[0])
    click(byText(root, 'Not now', 'button span')?.closest('button'))
    expect(onDismissSuggestion).toHaveBeenCalledWith(selection.active[0])
    click(byText(root, 'Turn off suggestions for this piece', 'button span')?.closest('button'))
    expect(onDisableSuggestions).toHaveBeenCalled()
  })

  it('points to Settings when suggestions are off globally', () => {
    const onOpenSettings = vi.fn()
    const root = show(
      data([attempt(A, NOW - 1000)]),
      { suggestionsGloballyOff: true, onOpenSettings },
      { active: [], improved: [], disabled: true },
    )
    expect(root.textContent).toContain('switched off in Settings')
    expect(byText(root, 'Turn on suggestions', 'button span')).toBeNull()
    click(byText(root, 'Open Settings', 'button span')?.closest('button'))
    expect(onOpenSettings).toHaveBeenCalled()
  })
})

describe('label rules recorded with an attempt', () => {
  it('describes the conditional rules in plain language, accepting either stored shape', () => {
    const rules = { G2: TREBLE_PRESET, F4: DISABLED_RULE }
    const expected = ['Treble clef: label notes below C4 or above C5. Notes from C4 through C5 stay unlabeled.']
    expect(labelRules(JSON.stringify(rules))).toEqual(expected)
    expect(labelRules(JSON.stringify({ mode: 'conditional', rules }))).toEqual(expected)
    expect(labelRules('{}')).toEqual([])
    expect(labelRules('not json')).toEqual([])
    expect(labelRules('[1,2]')).toEqual([])
    const a = attempt(A, NOW - 1000, {
      passed: false,
      assistance: {
        ...noAssistance(),
        level: 'names',
        persistentLabelNotes: [1],
        persistentLabelGroups: [0],
        labelSettings: { mode: 'conditional', rulesJson: JSON.stringify(rules) },
      },
    })
    const root = show(data([a]))
    expect($(root, '[data-row="assist-labels"] details')?.textContent).toContain('label notes below C4 or above C5')
  })
})
