// @vitest-environment happy-dom
import type { ComponentChildren } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentView } from '../../app/navigation'
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
import { PREPARED_LAYOUT_FORMAT, type PreparedLayout } from '../../render/types'
import { $, $$, byText, click, mount, type Mounted } from '../shared/testing'
import type { ResultsData } from '../results/data'
import { ResultDetails } from './ResultDetails'
import { passFacts, verdict } from './format'

let view: Mounted | null = null
beforeEach(() => {
  currentView.value = 'practice'
})
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
    history: ['wrong'],
    ...over,
  } satisfies RankedMistake
}

function render(
  mistakes: RankedMistake[],
  result: AttemptSummary = RESULT,
  goal: number | null = 3,
  loadHistory: () => Promise<ResultsData | null> = () => Promise.resolve(null),
  actions?: ComponentChildren,
  opts: {
    readonly fixed?: readonly number[]
    readonly layout?: PreparedLayout | null
    readonly timeline?: Details['timeline']
    readonly model?: typeof model
    readonly canDrill?: (attemptId: string, group: number) => boolean
  } = {},
) {
  const details: Details = {
    attemptId: result.id,
    records: [],
    timeline: opts.timeline ?? timeline,
    marks: new Map(),
    spots: new Map(),
    fixed: opts.fixed ?? [],
  }
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
    canDrill: vi.fn(opts.canDrill ?? (() => true)),
    drillSpot: vi.fn(() => true),
  }
  view = mount(
    <ResultDetails
      session={session}
      result={result}
      model={opts.model ?? model}
      naming={DEFAULT_SETTINGS.naming}
      pieceId="p"
      layout={opts.layout ?? null}
      goal={goal}
      rank={() => mistakes}
      loadHistory={loadHistory}
      actions={actions}
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

  it('a Wait run has neither all the numbers nor earlier passes: it is not stored (U142)', async () => {
    const loadHistory = vi.fn(() => Promise.resolve(null))
    const run: AttemptSummary = { ...RESULT, run: true, completionTimeSec: null, expectedTimeSec: null }
    render([mistake(1, 0, 'replaced')], run, null, loadHistory)
    await Promise.resolve()
    expect(loadHistory).not.toHaveBeenCalled()
    expect($(view!.container, '[data-testid="result-verdict"]')?.textContent).toBe('Not clean: 3 wrong notes.')
    expect($$(view!.container, '[data-testid="result-excerpt"]')).toHaveLength(1)
    const facts = $(view!.container, '[data-testid="result-facts"]')!
    expect(Array.from(facts.querySelectorAll('li'), (li) => li.textContent)).toEqual([
      'Right the first time at 2 of 5 places',
    ])
    expect(view!.container.textContent).not.toMatch(/earlier passes|All the numbers/i)
  })

  it('puts the actions directly under the verdict, then what the pill peeked at (U142)', () => {
    const actions = <p data-testid="actions">Loop, Again</p>
    const order = () =>
      Array.from(
        view!.container.querySelectorAll('[data-testid]'),
        (el) => (el as HTMLElement).dataset['testid'],
      ).filter((id) => ['result-verdict', 'actions', 'result-clean', 'result-excerpt', 'result-facts'].includes(id!))
    render([mistake(1, 0, 'replaced')], RESULT, null, undefined, actions)
    expect(order()).toEqual(['result-verdict', 'actions', 'result-excerpt', 'result-facts'])
    // Alone, the list needs no heading to be seen; assistive technology keeps it.
    expect(byText(view!.container, 'In this pass')?.className).toBe('visually-hidden')
    view!.unmount()
    render([], { ...RESULT, passed: true, wrongAttacks: 0, groupsFirstPass: 5 }, null, undefined, actions)
    expect(order()).toEqual(['result-verdict', 'actions', 'result-clean', 'result-facts'])
    // Clean with a mark (a hesitation): the facts still come first, as the pill peeks at them.
    view!.unmount()
    render([mistake(1, 0, 'timing')], { ...RESULT, passed: true, wrongAttacks: 0 }, null, undefined, actions)
    expect(order()).toEqual(['result-verdict', 'actions', 'result-facts', 'result-excerpt'])
  })

  it('never calls a pass free of marks when its summary contains wrong or missed notes', () => {
    render([], { ...RESULT, wrongAttacks: 6, timing: { groups: 152, onTime: 151, early: 0, late: 0, missed: 1 } })
    expect($(view!.container, '[data-testid="result-verdict"]')?.textContent).toContain('6 wrong notes')
    expect($(view!.container, '[data-testid="result-clean"]')).toBeNull()
  })

  it('one excerpt per bar, the repeated mistake first under its own heading with its count in words', () => {
    const repeated = mistake(1, 0, 'repeated', {
      reason: 'Same wrong key three passes running',
      presses: [{ pitch: 61, kind: 'accidental', expectedPitch: 62, expectedNote: note(1), passes: 3, together: null }],
    })
    // Bar 1 again (a one-off): shown in bar 1's excerpt, not twice.
    const sameBar = mistake(3, 0, 'replaced', {
      presses: [{ pitch: 65, kind: 'accidental', expectedPitch: 66, expectedNote: note(3), passes: 1, together: null }],
    })
    const extra = mistake(4, 1, 'extra', {
      presses: [
        { pitch: 30, kind: 'extra', expectedPitch: 67, expectedNote: note(4), passes: 1, together: null },
        { pitch: 69, kind: 'neighbor', expectedPitch: 67, expectedNote: note(4), passes: 1, together: null },
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
    expect(currentView.value).not.toBe('library')
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
    expect(currentView.value).not.toBe('library')

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
    }
    const passed = { ...RESULT, passed: true, wrongAttacks: 0, groupsFirstPass: 5, streak: 2 }
    render([], passed, 3, () => Promise.resolve(data))
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
        together: null,
      })),
    })
    render([five])
    const excerpt = $(view!.container, '[data-testid="result-excerpt"]')!
    expect(excerpt.querySelector('figcaption')?.textContent).toContain('第1小節')
    expect(excerpt.textContent).toContain('この位置でさらにミスタッチ2回')
  })

  it('shows per-place history dots with accessible label for 2+ visits, and omits them for a single visit', () => {
    const multi = mistake(1, 0, 'repeated', {
      history: ['wrong', 'clean', 'wrong'],
    })
    const single = mistake(4, 1, 'replaced', {
      history: ['wrong'],
    })
    render([multi, single])
    const [first, second] = $$(view!.container, '[data-testid="result-excerpt"]')
    const dots = $(first!, '[data-testid="place-history"]')
    expect(dots).not.toBeNull()
    expect(dots?.getAttribute('aria-label')).toBe('Last 3 passes here: wrong, clean, wrong')
    expect($$(dots!, '[data-visit]').map((el) => el.dataset['visit'])).toEqual(['wrong', 'clean', 'wrong'])
    expect($(second!, '[data-testid="place-history"]')).toBeNull()
  })

  it('shows Fixed this pass with deduplicated bars in score order and caps at 6 with "and N more"', () => {
    // Groups 0 and 1 are both in bar 1; group 4 is in bar 2.
    render([], { ...RESULT, passed: true, wrongAttacks: 0 }, 3, undefined, undefined, { fixed: [0, 1, 4] })
    expect($(view!.container, '[data-testid="result-fixed"]')?.textContent).toBe('Fixed this pass: bar 1, bar 2')

    // 8 bars fixed -> first 6 bars + "and 2 more".
    const eightBars = buildScore({
      notes: Array.from({ length: 8 }, (_, bar) => ({ at: bar * 4, midi: 60 })),
      bars: 8,
    })
    const tl8 = buildTimeline(eightBars, { hands: 'right', range: { fromOcc: 0, toOcc: 7 }, multiplier: 1 })
    view?.unmount()
    render([], { ...RESULT, passed: true, wrongAttacks: 0 }, 3, undefined, undefined, {
      model: eightBars,
      timeline: tl8,
      fixed: [0, 1, 2, 3, 4, 5, 6, 7],
    })
    expect($(view!.container, '[data-testid="result-fixed"]')?.textContent).toBe(
      'Fixed this pass: bar 1, bar 2, bar 3, bar 4, bar 5, bar 6, and 2 more',
    )
  })

  it('passes mark.repeat through to the excerpt SVG so recurring marks show the double ring and ×N', () => {
    const layout: PreparedLayout = {
      format: PREPARED_LAYOUT_FORMAT,
      key: 'test',
      mode: 'strip',
      width: 260,
      height: 200,
      top: 0,
      staves: [{ index: 0, top: 40, bottom: 80 }],
      occurrences: [
        {
          occ: 0,
          x0: 60,
          x1: 260,
          start: 0,
          duration: 1,
          anchors: [
            [0, 100],
            [1, 260],
          ],
          label: '1',
          labelBox: { x: 62, y: 22, w: 10, h: 13 },
        },
      ],
      notes: [
        {
          index: note(0),
          occ: 0,
          staff: 0,
          hand: 'R',
          head: { x: 74, y: 55, w: 12, h: 10 },
          x: 80,
          label: 0,
          graphic: 'g0',
        },
        {
          index: note(1),
          occ: 0,
          staff: 0,
          hand: 'R',
          head: { x: 114, y: 55, w: 12, h: 10 },
          x: 120,
          label: 1,
          graphic: 'g1',
        },
      ],
      labels: [],
      ottavas: [],
      contextChanges: [],
      segments: [
        {
          index: 0,
          occStart: 0,
          occEnd: 1,
          labelStart: 0,
          labelEnd: 0,
          x0: 0,
          x1: 260,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 200"><g data-n="${note(1)}"><path d="M114 55h12v10h-12z"></path></g></svg>`,
        },
      ],
    } as unknown as PreparedLayout
    const repeated = mistake(1, 0, 'repeated', {
      mark: { kind: 'accidental', text: 'D♮, not D♭', repeat: 3 },
      history: ['wrong', 'wrong', 'wrong'],
    })
    render([repeated], RESULT, 3, undefined, undefined, { layout })
    const music = $(view!.container, '[data-testid="excerpt-music"]')!
    expect(music).not.toBeNull()
    expect(music.querySelector('.pn-corr-repeat')).not.toBeNull()
    expect(music.querySelector('.pn-corr-label')?.textContent).toContain('×3')
  })

  it('shows a "Drill this spot" button per excerpt that calls drillSpot with the first place, and hides it when unavailable', () => {
    const first = mistake(1, 0, 'repeated')
    const second = mistake(2, 0, 'replaced')
    const third = mistake(4, 1, 'replaced')
    const session = render([first, second, third], RESULT, 3)
    const buttons = $$(view!.container, '[data-testid="drill-spot"]')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.textContent).toContain('Drill this spot')
    click(buttons[0]!)
    expect(session.drillSpot).toHaveBeenCalledWith(RESULT.id, 1)
    click(buttons[1]!)
    expect(session.drillSpot).toHaveBeenCalledWith(RESULT.id, 4)

    view!.unmount()
    view = null
    render([first, second, third], RESULT, 3, undefined, undefined, { canDrill: (_id, group) => group !== 4 })
    const filtered = $$(view!.container, '[data-testid="drill-spot"]')
    expect(filtered).toHaveLength(1)
  })

  it('shows pass patterns under the verdict, hunting line, also classes, and lateHand spread wording', () => {
    const spreadLeft = mistake(1, 0, 'timing', {
      mark: { kind: 'spread', text: 'Together' },
      lateHand: 'L',
      also: [{ kind: 'late', text: 'Too late' }],
    })
    const spreadRight = mistake(2, 0, 'replaced', {
      presses: [
        { pitch: 63, kind: 'accidental', expectedPitch: 64, expectedNote: note(2), passes: 1, together: false },
      ],
      hunting: true,
      lateHand: 'R',
      also: [{ kind: 'spread', text: 'Together' }],
    })
    const spreadOlder = mistake(4, 1, 'timing', {
      mark: { kind: 'spread', text: 'Together' },
    })

    const detailsRecord = {
      id: RESULT.id,
      kind: 'scored' as const,
      groups: [
        { group: 0, wrongAttacks: 1, earlyAttacks: 0, lateMs: 0, wrongPitches: [62], extraPitches: [] },
        { group: 1, wrongAttacks: 1, earlyAttacks: 0, lateMs: 0, wrongPitches: [64], extraPitches: [] },
        { group: 2, wrongAttacks: 1, earlyAttacks: 0, lateMs: 0, wrongPitches: [66], extraPitches: [] },
      ],
    }
    const details: Details = {
      attemptId: RESULT.id,
      records: [detailsRecord as unknown as Details['records'][number]],
      timeline,
      marks: new Map(),
      spots: new Map(),
      fixed: [],
    }
    const snippet = new Store<SnippetState | null>(null)
    const session = {
      resultDetails: vi.fn(() => details),
      snippet,
      snippetBlocked: vi.fn(() => null),
      playSnippet: vi.fn(async () => null),
      stopSnippet: vi.fn(),
      canDrill: vi.fn(() => false),
      drillSpot: vi.fn(() => false),
    }
    view = mount(
      <ResultDetails
        session={session}
        result={RESULT}
        model={model}
        naming={DEFAULT_SETTINGS.naming}
        pieceId="p"
        layout={null}
        goal={3}
        rank={() => [spreadLeft, spreadRight, spreadOlder]}
      />,
    )
    expect($(view.container, '[data-testid="result-patterns"]')?.textContent).toBe(
      '3 of your 3 wrong notes were the next note, played early.',
    )
    const excerpts = $$(view.container, '[data-testid="result-excerpt"]')
    expect(excerpts[0]!.textContent).toContain('Not together: the left hand came after the right.')
    expect(excerpts[0]!.textContent).toContain('Too late: played after the music reached it')
    expect(excerpts[0]!.textContent).toContain('You tried several keys here: read the note first, then play.')
    expect(excerpts[0]!.textContent).toContain('Not together: the right hand came after the left.')
    expect(excerpts[1]!.textContent).toContain('Not together: the chord was spread out')
  })
})
