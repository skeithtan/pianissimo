// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectSuggestions } from '../../../core/history'
import type { Suggestion } from '../../../core/history'
import { abandon, fresh, occurrences, play } from '../../../core/history/testkit'
import type { PieceHistory } from '../../../core/history'
import { $, $$, byLabel, byText, click, mount, type Mounted } from '../testing'
import { SuggestionList } from './SuggestionList'
import type { SuggestionListProps } from './SuggestionList'
import { barsTitle, handsText, speedText } from './format'

const SCORE = occurrences(60)

function select(h: PieceHistory): ReturnType<typeof selectSuggestions> {
  return selectSuggestions(h, SCORE, { scoreVersionId: 'v1', enabled: true })
}

/** Bar 13 (occ 12) with 3 of 5 passes wrong, bar 30 clean-ish in progress, plus a restart cluster. */
function history(): PieceHistory {
  let h = fresh()
  h = play(h, 12, ['clean', 'error', 'clean', 'error', 'error'])
  h = play(h, 30, ['error', 'error', 'error', 'error', 'error'])
  h = play(h, 40, ['error', 'error', 'error', 'error'])
  return h
}

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

function show(over: Partial<SuggestionListProps> & { suggestions: readonly Suggestion[] }) {
  const props: SuggestionListProps = { onPractice: () => undefined, ...over }
  view = mount(<SuggestionList {...props} />)
  return view.container
}

describe('<SuggestionList>', () => {
  it('shows bars, context bars, hand, speed, evidence and progress for each suggestion', () => {
    const { active } = select(history())
    expect(active.length).toBeGreaterThanOrEqual(2)
    const root = show({ suggestions: active })
    const cards = $$(root, '[data-suggestion]')
    expect(cards).toHaveLength(active.length)

    const card = $(root, `[data-suggestion="${active.find((s) => s.core.fromOcc === 12)?.id}"]`)
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Bars 12–14')
    expect(card?.textContent).toContain('Both hands')
    expect(card?.textContent).toContain('1× speed')
    expect(card?.textContent).toContain('Mistakes in bar 13 on 3 of your last 5 comparable passes.')
    expect(card?.textContent).toContain('Practice bars 12–14?')
    expect(card?.textContent).toContain('0 of 3 clean passes')

    const bars = $$(card as HTMLElement, '[data-role]')
    expect(bars.map((b) => b.getAttribute('data-role'))).toEqual(['context', 'difficult', 'context'])
    // Roles are words, not only color, and each bar names its role for screen readers.
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Bar 12, context bar',
      'Bar 13, difficult bar',
      'Bar 14, context bar',
    ])
    expect(bars[1]?.textContent).toContain('difficult')
    expect(bars[0]?.textContent).toContain('context')
  })

  it('shows recovery progress from the clean streak', () => {
    let h = history()
    h = play(h, 12, ['clean', 'clean'])
    const [s] = select(h).active.filter((x) => x.core.fromOcc === 12)
    expect(s?.progress.text).toBe('2 of 3 clean passes')
    const root = show({ suggestions: s ? [s] : [] })
    expect(root.textContent).toContain('2 of 3 clean passes')
    expect($(root, '[role="img"][aria-label="2 of 3 clean passes"]')).not.toBeNull()
  })

  it('Practice this passage reports the exact suggestion (range, hands and speed travel on it)', () => {
    const { active } = select(history())
    const onPractice = vi.fn()
    const root = show({ suggestions: active, onPractice })
    const target = active[0] as Suggestion
    const card = $(root, `[data-suggestion="${target.id}"]`) as HTMLElement
    click(byText(card, 'Practice this passage', 'button span')?.closest('button'))
    expect(onPractice).toHaveBeenCalledTimes(1)
    expect(onPractice).toHaveBeenCalledWith(target)
    const given = onPractice.mock.calls[0]?.[0] as Suggestion
    expect(given.passage).toEqual(target.passage)
    expect(given.hands).toBe('both')
    expect(given.multiplier).toBe(1)
  })

  it('dismisses one suggestion for the session and offers to disable all', () => {
    const { active } = select(history())
    const onDismiss = vi.fn()
    const onDisableSuggestions = vi.fn()
    const root = show({
      suggestions: active,
      onDismiss,
      onDisableSuggestions,
      disableLabel: 'Turn off suggestions for this piece',
    })
    const first = $(root, `[data-suggestion="${active[0]?.id}"]`) as HTMLElement
    click($$(first, 'button').find((b) => b.textContent?.trim() === 'Not now'))
    expect(onDismiss).toHaveBeenCalledWith(active[0])
    click(byLabel(root, 'Turn off suggestions for this piece'))
    expect(onDisableSuggestions).toHaveBeenCalledTimes(1)
  })

  it('hides optional actions when their callbacks are omitted', () => {
    const { active } = select(history())
    const root = show({ suggestions: active })
    expect(byText(root, 'Not now')).toBeNull()
    expect(root.textContent).not.toContain('Turn off suggestions')
  })

  it('labels repeated-restart suggestions separately', () => {
    let h = fresh()
    for (let i = 0; i < 3; i += 1) h = abandon(h, 20, 'user-restart', 100 + i)
    const { active } = select(h)
    const root = show({ suggestions: active })
    expect(active[0]?.kind).toBe('restart')
    expect(root.textContent).toContain('Repeated restarts')
    expect(root.textContent).toContain('You restarted at bar 21 after mistakes three times.')
  })

  it('lists improved suggestions without actions', () => {
    let h = history()
    h = play(h, 12, ['clean', 'clean', 'clean'])
    const sel = select(h)
    expect(sel.improved.length).toBeGreaterThan(0)
    const onPractice = vi.fn()
    const root = show({ suggestions: [], improved: sel.improved, onPractice })
    const details = $(root, 'details')
    expect(details?.textContent).toContain('Improved (1)')
    expect(details?.textContent).toContain('Improved: 3 clean passes in a row on bar 13.')
    expect(details?.textContent).toContain('Both hands at 1×')
    expect($$(details as HTMLElement, 'button')).toHaveLength(0)
    expect(root.querySelector('[data-state="none"]')).not.toBeNull() // nothing active
  })

  it('explains a disabled list and offers to turn it back on when allowed', () => {
    const onEnableSuggestions = vi.fn()
    const root = show({ suggestions: [], disabled: true, onEnableSuggestions, onDisableSuggestions: () => undefined })
    expect($(root, '[data-state="disabled"]')?.textContent).toContain('turned off')
    expect(root.textContent).not.toContain('Turn off suggestions') // no disable button while disabled
    click(byText(root, 'Turn on suggestions', 'button span')?.closest('button'))
    expect(onEnableSuggestions).toHaveBeenCalledTimes(1)

    view?.unmount()
    const bare = show({ suggestions: [], disabled: true })
    expect(byText(bare, 'Turn on suggestions', 'button span')).toBeNull()
  })

  it('says what an empty list means', () => {
    const root = show({ suggestions: [] })
    expect($(root, '[data-state="none"]')?.textContent).toContain('Nothing to suggest')
  })

  it('compact mode drops the legend and tightens the cards', () => {
    const { active } = select(history())
    const roomy = show({ suggestions: active })
    expect(roomy.textContent).toContain('Context bars give you a lead-in')
    view?.unmount()
    const compact = show({ suggestions: active, compact: true })
    expect(compact.textContent).not.toContain('Context bars give you a lead-in')
    expect(compact.querySelector('[data-compact]')).not.toBeNull()
  })

  it('renders an optional notation preview slot', () => {
    const { active } = select(history())
    const root = show({ suggestions: active, renderPreview: (s) => <svg data-preview={s.id} /> })
    expect($$(root, '[data-preview]')).toHaveLength(active.length)
  })

  it('uses the requested heading level', () => {
    const { active } = select(history())
    const root = show({ suggestions: active, headingLevel: 3 })
    expect($(root, 'h3')?.textContent).toBe('Suggested practice')
    expect($$(root, 'h4').length).toBe(active.length)
  })
})

describe('format helpers', () => {
  it('formats hands, speed and bar ranges', () => {
    expect(handsText('left')).toBe('Left hand')
    expect(speedText(0.75)).toBe('0.75×')
    expect(speedText(1.25)).toBe('1.25×')
    expect(speedText(1)).toBe('1×')
    const [s] = select(history()).active.filter((x) => x.core.fromOcc === 12)
    expect(s && barsTitle(s.bars)).toBe('Bars 12–14')
  })
})
