// @vitest-environment happy-dom
/** What the pill shows of its card (U142): drawn at rest only, facts when there is nothing to draw. */
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttemptSummary } from '../../app/session'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { $, mount, type Mounted } from '../shared/testing'

const drawing = { bar: '5', level: 'extra', reason: 'Why', keeps: false, svg: '<svg></svg>', width: 200, skip: 0 }
const drawPeek = vi.fn((): typeof drawing | null => drawing)
const load = vi.fn(async () => ({
  drawPeek,
  PeekExcerpt: ({ drawing }: { drawing: { bar: string } }) => <p data-testid="drawn">Bar {drawing.bar}</p>,
}))
vi.mock('./ResultDetailsLoader', () => ({ loadDetailsModule: () => load() }))
const { PEEK_DELAY_MS, ResultPeek } = await import('./ResultPeek')

const RESULT: AttemptSummary = {
  id: 'a1',
  passed: false,
  wrongAttacks: 1,
  groupsFirstPass: 3,
  groupsTotal: 4,
  completionTimeSec: 3,
  expectedTimeSec: 3,
  streak: 0,
  targetReached: false,
}
const LAYOUT = {} as never

let view: Mounted | null = null
beforeEach(() => {
  vi.useFakeTimers()
  drawPeek.mockReset().mockReturnValue(drawing)
  load.mockClear()
})
afterEach(() => {
  view?.unmount()
  view = null
  vi.useRealTimers()
})

function peek(state: { marked?: boolean; idle?: boolean; result?: AttemptSummary; layout?: never | null } = {}) {
  return (
    <ResultPeek
      session={{} as never}
      result={state.result ?? RESULT}
      model={{} as never}
      naming={DEFAULT_SETTINGS.naming}
      pieceId="p"
      layout={state.layout === undefined ? LAYOUT : state.layout}
      goal={null}
      marked={state.marked ?? true}
      idle={state.idle ?? true}
    />
  )
}
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const drawn = () => $(view!.container, '[data-testid="drawn"]')
const shell = () => $(view!.container, '[data-testid="result-peek-mistake"]')

describe('the peek', () => {
  it('shows the shell of the first mistake at once and draws it once at rest, loading nothing before', async () => {
    view = mount(peek())
    expect(shell()).not.toBeNull()
    await wait(PEEK_DELAY_MS - 1)
    expect(load).not.toHaveBeenCalled()
    await wait(5000)
    expect(load).toHaveBeenCalledOnce()
    expect(drawn()?.textContent).toBe('Bar 5')
    expect(shell()).not.toBeNull()
    expect(drawPeek).toHaveBeenCalledOnce()
  })

  it('never while something is played; a pass starting meanwhile cancels it, the next rest draws it', async () => {
    view = mount(peek({ idle: false }))
    await wait(10_000)
    expect(load).not.toHaveBeenCalled()
    view.rerender(peek())
    await wait(PEEK_DELAY_MS / 2)
    view.rerender(peek({ idle: false }))
    await wait(10_000)
    expect(drawPeek).not.toHaveBeenCalled()
    expect(shell()).not.toBeNull()
    view.rerender(peek())
    await wait(10_000)
    expect(drawn()).not.toBeNull()
    // Drawn, it stays while the next pass plays.
    view.rerender(peek({ idle: false }))
    expect(drawn()).not.toBeNull()
  })

  it('without anything to correct shows the facts and loads nothing', async () => {
    view = mount(peek({ marked: false, result: { ...RESULT, passed: true, wrongAttacks: 0, groupsFirstPass: 4 } }))
    await wait(10_000)
    expect(load).not.toHaveBeenCalled()
    expect(Array.from(view.container.querySelectorAll('p, li'), (line) => line.textContent)).toEqual([
      'No mistakes in this pass.',
      'This pass',
      'Right the first time at 4 of 4 places',
      'Took 3.0 s; the music lasts 3.0 s at this speed (0.0 s)',
    ])
  })

  it('a clean pass with marks (a hesitation) shows its facts too, without saying it has none', async () => {
    view = mount(peek({ result: { ...RESULT, passed: true, wrongAttacks: 0, groupsFirstPass: 4 } }))
    await wait(10_000)
    expect(load).not.toHaveBeenCalled()
    expect(shell()).toBeNull()
    expect(Array.from(view.container.querySelectorAll('p, li'), (line) => line.textContent).slice(0, 2)).toEqual([
      'This pass',
      'Right the first time at 4 of 4 places',
    ])
  })

  it('falls back to the facts when there is no excerpt or the module does not load', async () => {
    drawPeek.mockReturnValue(null)
    view = mount(peek())
    await wait(10_000)
    expect(shell()).toBeNull()
    expect(view.container.textContent).toContain('Right the first time at 3 of 4 places')
    view.unmount()
    load.mockRejectedValueOnce(new Error('offline'))
    view = mount(peek())
    await wait(10_000)
    expect(shell()).toBeNull()
  })

  it('waits for the layout, and draws again for a new one, the old staying meanwhile', async () => {
    view = mount(peek({ layout: null }))
    await wait(10_000)
    expect(drawPeek).not.toHaveBeenCalled()
    view.rerender(peek())
    await wait(10_000)
    expect(drawPeek).toHaveBeenCalledTimes(1)
    view.rerender(peek({ layout: { other: true } as never }))
    expect(drawn()).not.toBeNull()
    await wait(10_000)
    expect(drawPeek).toHaveBeenCalledTimes(2)
  })
})
