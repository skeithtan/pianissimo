// @vitest-environment happy-dom
/**
 * The Keep time review's long list of bars (U108, P6): every affected bar stays in the list, but
 * a card's notation is mounted only while it is near the view, and a session update re-renders
 * only the cards whose own props changed. Also the folded summary's agreement with the score (P10).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { Store, type AttemptSummary, type ResultDetails as Details, type SnippetState } from '../../app/session'
import { buildTimeline } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { attemptRecord, comparisonContext } from '../../core/history/testkit'
import type { GroupOutcome } from '../../core/model/practice'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { $, $$, mount, type Mounted } from '../shared/testing'
import { ResultDetails } from './ResultDetails'

const plots = vi.hoisted(() => ({ renders: 0 }))
vi.mock('./TimingBarPlot', () => ({
  TimingBarPlot: () => {
    plots.renders++
    return <div data-testid="plot" />
  },
}))

/** A stub IntersectionObserver: the test says which cards are near the view. */
class Observer {
  static all: Observer[] = []
  readonly targets: Element[] = []
  constructor(readonly callback: IntersectionObserverCallback) {
    Observer.all.push(this)
  }
  observe(target: Element) {
    this.targets.push(target)
  }
  unobserve() {}
  disconnect() {
    Observer.all = Observer.all.filter((o) => o !== this)
  }
  static show(target: Element, isIntersecting: boolean) {
    for (const o of Observer.all.filter((o) => o.targets.includes(target)))
      act(() => o.callback([{ target, isIntersecting } as IntersectionObserverEntry], o as never))
  }
}

let view: Mounted | null = null
beforeEach(() => {
  plots.renders = 0
  Observer.all = []
  vi.stubGlobal('IntersectionObserver', Observer)
})
afterEach(() => {
  view?.unmount()
  view = null
  vi.unstubAllGlobals()
})

// Eight bars of four quarter notes.
const BARS = 8
const model = buildScore({
  notes: Array.from({ length: BARS * 4 }, (_, at) => ({ at, midi: 60 + (at % 12) })),
  bars: BARS,
})
const timeline = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: BARS - 1 }, multiplier: 1 })

function group(index: number, fields: Partial<GroupOutcome>): GroupOutcome {
  return { group: index, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, ...fields }
}

function render(groups: GroupOutcome[], toleranceMs = 150) {
  const record = attemptRecord({
    context: comparisonContext({ transport: 'strict' }),
    groups,
    rhythm: { toleranceMs },
  })
  const result: AttemptSummary = {
    id: record.id,
    passed: false,
    wrongAttacks: 0,
    groupsFirstPass: groups.length,
    groupsTotal: groups.length,
    completionTimeSec: null,
    expectedTimeSec: null,
    assistance: 'none',
    persistentLabels: false,
    streak: 0,
    targetReached: false,
    timing: { groups: groups.length, onTime: groups.length - 1, early: 0, late: 1, missed: 0 },
  }
  const details: Details = { attemptId: record.id, records: [record], timeline, marks: new Map() }
  const snippet = new Store<SnippetState | null>(null)
  const session = {
    resultDetails: () => details,
    snippet,
    snippetBlocked: vi.fn(() => null),
    playSnippet: vi.fn(async () => null),
    stopSnippet: vi.fn(),
  }
  const props = {
    session,
    result,
    model,
    naming: DEFAULT_SETTINGS.naming,
    pieceId: 'p',
    layout: null,
    goal: null,
    rank: () => [],
    loadHistory: () => Promise.resolve(null),
  }
  view = mount(<ResultDetails {...props} />)
  return { session, snippet, rerender: () => view!.rerender(<ResultDetails {...props} />) }
}

const cards = () => $$(view!.container, '[data-testid="result-excerpt"]')
const music = (card: HTMLElement) => $(card, '[data-testid="plot"]')
const placeholder = (card: HTMLElement) => $(card, '[data-testid="excerpt-placeholder"]')

describe('the Keep time review list (P6)', () => {
  it('keeps every off-beat bar listed but mounts a card’s notation only near the view, both ways', () => {
    // Every bar has a late attack: eight cards, the first four drawn at once, the rest waiting.
    render(Array.from({ length: BARS * 4 }, (_, i) => group(i, { offsetMs: i % 4 === 0 ? 90 : 0 })))
    const list = cards()
    expect(list).toHaveLength(BARS)
    expect(list.slice(0, 4).every((card) => music(card))).toBe(true)
    expect(list.slice(4).every((card) => !music(card) && placeholder(card))).toBe(true)
    // Scrolled down: the last card comes into view, the first leaves it.
    vi.spyOn(list[0]!.querySelector('.pn-excerpt')!, 'getBoundingClientRect').mockReturnValue({
      height: 137,
    } as DOMRect)
    Observer.show(list[7]!, true)
    Observer.show(list[0]!, false)
    expect(music(list[7]!)).not.toBeNull()
    expect(music(list[0]!)).toBeNull()
    // The placeholder keeps the notation's height, so the list does not move under the finger.
    expect(placeholder(list[0]!)?.style.height).toBe('137px')
    // Back up: mounted again.
    Observer.show(list[0]!, true)
    expect(music(list[0]!)).not.toBeNull()
    expect(placeholder(list[0]!)).toBeNull()
  })

  it('a session update re-renders no card whose own props are unchanged; a sounding bar re-renders alone', () => {
    const { snippet, rerender } = render(
      Array.from({ length: BARS * 4 }, (_, i) => group(i, { offsetMs: i % 4 === 0 ? 90 : 0 })),
    )
    const drawn = plots.renders
    expect(drawn).toBe(4)
    rerender()
    rerender()
    expect(plots.renders).toBe(drawn)
    act(() => {
      snippet.set({ occ: 1, kind: 'written', shortened: false })
    })
    expect(plots.renders).toBe(drawn + 1)
    expect(cards()[1]!.querySelector('button[data-kind="written"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the folded timing summary (P5, P10)', () => {
  it('says all attacks were near the beat in one sentence when scoring agrees', () => {
    render(Array.from({ length: 4 }, (_, i) => group(i, { offsetMs: 5 })))
    const steady = $(view!.container, '[data-testid="timing-review-steady"]')
    expect(steady?.textContent).toContain('All measured attacks were within 30 ms of the beat.')
  })

  it('makes no such claim when a chord started on the beat was completed late', () => {
    // ±40 ms: a 20 ms near-beat window; the first key 5 ms late, the chord completed 60 ms late.
    render(
      [
        group(0, { offsetMs: 60, onsetOffsetMs: 5 }),
        group(1, { offsetMs: 4 }),
        group(2, { offsetMs: 0 }),
        group(3, { offsetMs: 8 }),
      ],
      40,
    )
    expect(cards()).toHaveLength(0)
    expect($(view!.container, '[data-testid="timing-review-steady"]')).toBeNull()
  })
})
