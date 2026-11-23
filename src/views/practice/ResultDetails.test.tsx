// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentView, resultsRequest } from '../../app/navigation'
import {
  Store,
  type AttemptSummary,
  type RankedMistake,
  type ResultDetails as Details,
  type SnippetState,
} from '../../app/session'
import { buildTimeline } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { attemptRecord, noAssistance, occurrences } from '../../core/history/testkit'
import type { Language } from '../../core/model/language'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { makePackage, makePiece } from '../../core/storage/testkit'
import en from '../../i18n/locales/en-US.json'
import fr from '../../i18n/locales/fr-FR.json'
import ja from '../../i18n/locales/ja-JP.json'
import { readMessagesWith } from '../../i18n/messages'
import { $, $$, byText, click, mount, type Mounted } from '../shared/testing'
import type { ResultsData } from '../results/data'
import { ResultDetails, verdict } from './ResultDetails'
import { passFacts } from './format'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
  readMessagesWith(() => ({ language: 'en-US', strings: {} }))
})

/** Reads a translated catalog as the app does (keyed by the English source). */
function speak(language: Language, catalog: Record<string, string>): void {
  const source = en as Record<string, string>
  const strings = Object.fromEntries(Object.entries(catalog).map(([id, text]) => [source[id]!, text]))
  readMessagesWith(() => ({ language, strings }))
}

// Bar 1: C D E F♯; bar 2: G.
const model = buildScore({
  notes: [60, 62, 64, 66, 67].map((midi, at) => ({ at, midi })),
  bars: 2,
})
const timeline = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
const note = (g: number) => timeline.groups[g]!.notes[0]!

const RESULT: AttemptSummary = {
  id: 'a3',
  passed: false,
  wrongAttacks: 3,
  groupsFirstPass: 2,
  groupsTotal: 5,
  completionTimeSec: 6.5,
  expectedTimeSec: 6,
  streak: 0,
  targetReached: false,
}

function mistake(group: number, occ: number, level: RankedMistake['level'], over: Partial<RankedMistake> = {}) {
  return {
    level,
    reason: level,
    group,
    occ,
    bar: String(occ + 1),
    notes: [note(group)],
    presses: [],
    passesWrong: 1,
    passesReached: 1,
    mark: { kind: 'wrong', text: 'Wrong note' },
    ...over,
  } satisfies RankedMistake
}

function render(
  mistakes: RankedMistake[],
  result: AttemptSummary = RESULT,
  goal: number | null = 3,
  history: ResultsData | null = null,
) {
  const details: Details = { attemptId: result.id, records: [], timeline, marks: new Map() }
  const snippet = new Store<SnippetState | null>(null)
  const session = {
    resultDetails: vi.fn(() => details),
    snippet,
    snippetBlocked: vi.fn((_id: string, occ: number, kind: string) =>
      occ === 1 && kind === 'played' ? 'No keys were captured in this bar.' : null,
    ),
    playSnippet: vi.fn(async (_id: string, occ: number, kind: 'played' | 'written') => {
      snippet.set({ occ, kind, shortened: kind === 'played' })
      return null
    }),
    stopSnippet: vi.fn(() => {
      snippet.set(null)
    }),
  }
  view = mount(
    <ResultDetails
      session={session}
      result={result}
      model={model}
      naming={DEFAULT_SETTINGS.naming}
      pieceId="p"
      layout={null}
      goal={goal}
      rank={() => mistakes}
      loadHistory={() => Promise.resolve(history)}
    />,
  )
  return session
}

describe('ResultDetails (U99)', () => {
  it('a clean pass: no excerpts, says so plainly, with this pass in a few lines', () => {
    render([], { ...RESULT, passed: true, wrongAttacks: 0, groupsFirstPass: 5, streak: 2 })
    expect($(view!.container, '[data-testid="result-verdict"]')?.textContent).toBe('Clean pass: no wrong notes.')
    expect($(view!.container, '[data-testid="result-clean"]')?.textContent).toBe('No mistakes in this pass.')
    expect($$(view!.container, '[data-testid="result-excerpt"]')).toHaveLength(0)
    const facts = $(view!.container, '[data-testid="result-facts"]')!.textContent
    expect(facts).toContain('Took 6.5 s; the music lasts 6.0 s at this speed (+0.5 s)')
    expect(facts).toContain('Right the first time at 5 of 5 places')
    expect(facts).toContain('2 of 3 clean in a row toward the goal')
  })

  it('never calls a pass free of marks when its summary contains wrong or missed notes', () => {
    render([], { ...RESULT, wrongAttacks: 6, timing: { groups: 152, onTime: 151, early: 0, late: 0, missed: 1 } })
    expect($(view!.container, '[data-testid="result-verdict"]')?.textContent).toContain('6 wrong notes')
    expect($(view!.container, '[data-testid="result-clean"]')).toBeNull()
  })

  it('one excerpt per bar, the repeated mistake first under its own heading with its count in words', () => {
    const repeated = mistake(1, 0, 'repeated', {
      reason: 'Same wrong key three passes running',
      presses: [{ pitch: 61, kind: 'accidental', expectedPitch: 62, expectedNote: note(1), passes: 3 }],
    })
    // Bar 1 again (a one-off): shown in bar 1's excerpt, not twice.
    const sameBar = mistake(3, 0, 'replaced', {
      presses: [{ pitch: 65, kind: 'accidental', expectedPitch: 66, expectedNote: note(3), passes: 1 }],
    })
    const extra = mistake(4, 1, 'extra', {
      presses: [
        { pitch: 30, kind: 'extra', expectedPitch: 67, expectedNote: note(4), passes: 1 },
        { pitch: 69, kind: 'neighbor', expectedPitch: 67, expectedNote: note(4), passes: 1 },
      ],
    })
    const session = render([repeated, sameBar, extra])
    expect(session.resultDetails).toHaveBeenCalledOnce()
    const excerpts = $$(view!.container, '[data-testid="result-excerpt"]')
    expect(excerpts.map((e) => e.dataset['occ'])).toEqual(['0', '1'])
    const keeps = $(view!.container, '[data-group="keeps"]')!
    expect(keeps.textContent).toContain('Keeps happening')
    expect(keeps.contains(excerpts[0]!)).toBe(true)
    expect(excerpts[0]!.textContent).toContain('Same wrong key three passes running')
    expect(excerpts[0]!.textContent).toContain('You pressed D♭ where D♮ is written (three passes running)')
    expect(excerpts[0]!.textContent).toContain('You pressed F where F♯ is written')
    expect($(view!.container, '[data-group="once"]')?.textContent).toContain('Also in this pass')
    expect(excerpts[1]!.textContent).toContain('You pressed F♯1: it is not in the score here')
    expect(excerpts[1]!.textContent).toContain('You pressed A where G is written')
    // No layout yet: the words without the music.
    expect($(excerpts[0]!, '[data-testid="excerpt-music"]')).toBeNull()
  })

  it('caps the excerpts and shows more on request; nothing in it navigates', () => {
    const many = Array.from({ length: 6 }, (_, i) => mistake(i % 5, i, 'timing', { mark: { kind: 'late', text: 'x' } }))
    render(many)
    expect($$(view!.container, '[data-testid="result-excerpt"]')).toHaveLength(4)
    expect($(view!.container, '[data-testid="result-excerpt"]')?.textContent).toContain(
      'Too late: played after the music reached it',
    )
    click(byText(view!.container, 'Show 2 more bars')!)
    expect($$(view!.container, '[data-testid="result-excerpt"]')).toHaveLength(6)
    expect(byText(view!.container, 'Show 2 more bars')).toBeNull()
    for (const el of $$(view!.container, '[data-testid="result-excerpt"]')) click(el)
    expect(currentView.value).not.toBe('results')
    expect(resultsRequest.value).toBeNull()
  })

  it('each bar plays what you played and as written; the one sounding shows Stop; folding stops it (U100)', async () => {
    const session = render([mistake(1, 0, 'replaced'), mistake(4, 1, 'extra')])
    const [first, second] = $$(view!.container, '[data-testid="result-excerpt"]')
    const button = (ex: HTMLElement, kind: string) => $(ex, `button[data-kind="${kind}"]`) as HTMLButtonElement
    expect(button(first!, 'played').textContent).toBe('What you played')
    expect(button(first!, 'written').textContent).toBe('As written')
    // Nothing captured in bar 2: What you played is unavailable, and says why.
    expect(button(second!, 'played').disabled).toBe(true)
    expect(second!.textContent).toContain('No keys were captured in this bar.')
    expect(button(second!, 'written').disabled).toBe(false)

    click(button(first!, 'played'))
    await vi.waitFor(() => expect(button(first!, 'played').getAttribute('aria-pressed')).toBe('true'))
    expect(session.playSnippet).toHaveBeenCalledWith('a3', 0, 'played')
    expect(first!.textContent).toContain('Long pauses are shortened.')
    click(button(first!, 'played')) // Stop
    expect(session.stopSnippet).toHaveBeenCalled()
    await vi.waitFor(() => expect(button(first!, 'played').getAttribute('aria-pressed')).toBe('false'))
    expect(currentView.value).not.toBe('results')

    click(button(second!, 'written'))
    await vi.waitFor(() => expect(session.playSnippet).toHaveBeenCalledWith('a3', 1, 'written'))
    session.stopSnippet.mockClear()
    view!.unmount() // the card folds
    view = null
    expect(session.stopSnippet).toHaveBeenCalledOnce()
  })

  it('words why a pass was not clean and the facts of a Keep time pass', () => {
    expect(verdict({ ...RESULT, wrongAttacks: 1 })).toBe('Not clean: 1 wrong note.')
    expect(verdict({ ...RESULT, wrongAttacks: 0 })).toBe('Completed, but not counted as clean.')
    const timing = { groups: 8, onTime: 6, early: 1, late: 1, missed: 0 }
    expect(verdict({ ...RESULT, wrongAttacks: 0, timing })).toBe('Not clean: the timing slipped.')
    expect(passFacts({ ...RESULT, timing }, null).slice(0, 2)).toEqual([
      'Right the first time at 2 of 5 places',
      'On time 6 of 8 · 1 early · 1 late',
    ])
    expect(passFacts({ ...RESULT, targetReached: true }, 3)).toContain('Goal reached: 3 clean in a row')
  })

  it('never mentions help, in the card or its folds (U144)', async () => {
    const names = {
      ...noAssistance(),
      level: 'names' as const,
      persistentLabelNotes: [0, 1],
      persistentLabelGroups: [0],
      hintRequests: 1,
      hintGroups: [1],
      labelSettings: { mode: 'all' as const, rulesJson: '{}' },
    }
    const keyboard = { ...noAssistance(), level: 'keyboard' as const, keyboardShown: true }
    const pkg = makePackage('v1', 'Minuet')
    const attempts = [
      attemptRecord({ id: 'plain', createdAt: 1, completionTimeSec: 9 }),
      attemptRecord({ id: 'legacy', createdAt: 2, completionTimeSec: 8.1, assistance: keyboard, passed: false }),
      attemptRecord({ id: 'wrong', createdAt: 3, assistance: names, wrongAttacks: 2, passed: false }),
      attemptRecord({ id: 'a3', createdAt: 4, completionTimeSec: 8.5, assistance: names }),
    ]
    const data: ResultsData = {
      piece: makePiece(pkg, { title: 'Minuet' }),
      attempts,
      occurrences: occurrences(40),
      suggestions: { active: [], improved: [], disabled: false },
    }
    const passed = { ...RESULT, passed: true, wrongAttacks: 0, groupsFirstPass: 5, streak: 2 }
    render([], passed, 3, data)
    const root = view!.container
    const row = (id: string) => $(root, `[data-attempt="${id}"]`)
    await vi.waitFor(() => expect(row('a3')).not.toBeNull())
    const silent = () => expect(root.textContent).not.toMatch(/help|assist|note names|keyboard guide|labels|hint/i)
    silent()
    expect($(root, '[data-row="assistance"]')).toBeNull()
    expect($(root, '[data-testid="result-numbers"]')?.textContent).toContain('Pass: completed with no wrong notes')
    const group = (kind: string) => $$(root, `[data-group="${kind}"] [data-attempt]`).map((b) => b.dataset['attempt'])
    expect(group('clean')).toEqual(['legacy', 'a3', 'plain'])
    expect(group('errors')).toEqual(['wrong'])
    expect(group('assisted')).toEqual([])
    expect($(root, '[data-row="best-clean"]')?.textContent).toContain('Best clean8.1 s')
    // The legacy pass, stored as failed for its help, is a pass here too.
    click(row('legacy'))
    await vi.waitFor(() => expect(byText(root, 'Back to this pass')).not.toBeNull())
    expect($(root, '[data-testid="result-numbers"] [data-reason]')?.dataset['reason']).toBe('passed')
    silent()
  })

  it('words each sentence whole in other languages (P5)', () => {
    speak('fr-FR', fr)
    expect(verdict({ ...RESULT, wrongAttacks: 1 })).toBe('Essai non réussi\u00a0: 1 fausse note.')
    expect(verdict({ ...RESULT, wrongAttacks: 3 })).toBe('Essai non réussi\u00a0: 3 fausses notes.')
    speak('ja-JP', ja)
    const five = mistake(1, 0, 'replaced', {
      presses: [61, 63, 64, 65, 66].map((pitch) => ({
        pitch,
        kind: 'accidental' as const,
        expectedPitch: 62,
        expectedNote: note(1),
        passes: 1,
      })),
    })
    render([five])
    const excerpt = $(view!.container, '[data-testid="result-excerpt"]')!
    expect(excerpt.querySelector('figcaption')?.textContent).toContain('第1小節')
    expect(excerpt.textContent).toContain('この位置でさらにミスタッチ2回')
  })
})
