// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import type { AttemptSummary, GuideState, PracticeSession, SessionUi } from '../../app/session'
import { Store } from '../../app/session/store'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { $, byLabel, byText, click, mount, type Mounted } from '../shared/testing'
import { Banners, RESULT_FADE_MS, ladderResultText, type BannersProps } from './Banners'
import { CountIn } from './CountIn'
import { timingText } from './format'
import { GuidePanel } from './live'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
  vi.useRealTimers()
})

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

const UI: SessionUi = {
  activity: 'idle',
  phase: null,
  playing: false,
  hands: 'both',
  handsAvailable: true,
  leadIn: false,
  range: null,
  multiplier: 1,
  startAction: 'reading',
  startEnabled: true,
  startReason: null,
  waiting: null,
  hintVisible: false,
  keyboardVisible: false,
  canHint: false,
  repeat: false,
  repeatTarget: null,
  ladder: null,
  lastResult: null,
  corrections: 0,
  interruption: null,
  soundStatus: null,
  inputDisconnected: false,
  playThrough: false,
  rhythm: false,
  countIn: null,
  finished: false,
}

const RESULT: AttemptSummary = {
  id: 'a1',
  passed: true,
  wrongAttacks: 0,
  groupsFirstPass: 4,
  groupsTotal: 4,
  completionTimeSec: 3,
  expectedTimeSec: 3,
  assistance: 'none',
  persistentLabels: false,
  streak: 2,
  targetReached: false,
}

const noop = () => undefined

function banners(ui: Partial<SessionUi>, extra: Partial<BannersProps> = {}) {
  return (
    <Banners
      ui={{ ...UI, ...ui }}
      onRestart={noop}
      onResume={noop}
      onResults={noop}
      onDismissResult={noop}
      onConnection={noop}
      {...extra}
    />
  )
}

const DISCONNECT = {
  reason: 'disconnect',
  text: 'The piano was disconnected, so the attempt stopped.',
  canResume: true,
} as const

describe('Banners', () => {
  it('shows one disconnect notice, and none once the piano is back', () => {
    view = mount(banners({ inputDisconnected: true, interruption: DISCONNECT }))
    const notice = $(view.container, '[data-testid="input-disconnected"]')
    expect(notice?.textContent).toContain('Piano disconnected. Reconnect it to continue.')
    expect(byText(notice!, 'Connection')).not.toBeNull()
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()

    // The piano is back: no disconnect message remains (the footer offers Resume / Start).
    view.rerender(banners({ inputDisconnected: false, interruption: DISCONNECT }))
    expect($(view.container, '[data-testid="input-disconnected"]')).toBeNull()
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()
    expect(view.container.textContent).not.toContain('disconnected')
  })

  it('hides the sound status while the input is disconnected', () => {
    const soundStatus = 'The piano output was disconnected. Reconnect it to hear playback.'
    view = mount(banners({ inputDisconnected: true, soundStatus }))
    expect($(view.container, '[data-testid="input-disconnected"]')).not.toBeNull()
    expect(view.container.textContent).not.toContain(soundStatus)
    expect(view.container.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(1)

    // Only the output is gone (a 5-pin interface): its line is the one message.
    view.rerender(banners({ inputDisconnected: false, soundStatus }))
    expect($(view.container, '[data-testid="input-disconnected"]')).toBeNull()
    expect(view.container.textContent).toContain(soundStatus)
  })

  it('other interruptions still show while the input is disconnected', () => {
    view = mount(
      banners({
        inputDisconnected: true,
        interruption: { reason: 'pause', text: 'Paused.', canResume: true },
      }),
    )
    expect($(view.container, '[data-testid="input-disconnected"]')).not.toBeNull()
    expect($(view.container, '[data-testid="interruption"]')?.textContent).toContain('Paused.')
  })

  it('shows no result card or interruption while playing through (P12)', () => {
    view = mount(
      banners({
        activity: 'playing',
        playThrough: true,
        lastResult: RESULT,
        interruption: { reason: 'seek', text: 'Moving through the score stopped the attempt.', canResume: true },
      }),
    )
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()
    expect(view.container.textContent).not.toContain('Clean pass')
    expect(byLabel(view.container, 'Hide result')).toBeNull()
  })

  it('the result card says what the speed ladder did, in one line', () => {
    const line = () => $(view!.container, '[data-testid="ladder-result"]')?.textContent
    view = mount(banners({ repeat: true, lastResult: { ...RESULT, ladder: { climbedTo: 0.65 } }, multiplier: 0.6 }))
    expect(line()).toBe('Speed up: next at 65%')
    view.rerender(banners({ repeat: true, lastResult: { ...RESULT, ladder: { droppedTo: 0.55 } }, multiplier: 0.6 }))
    expect(line()).toBe('Back to 55%')
    view.rerender(banners({ repeat: true, lastResult: { ...RESULT, ladder: { done: true } }, multiplier: 1 }))
    expect(line()).toBe('Goal reached: 100%')
    view.rerender(banners({ repeat: true, lastResult: RESULT }))
    expect(line()).toBeUndefined()
    expect(ladderResultText({ ...RESULT, ladder: {} }, 1)).toBeNull()
  })

  it('has no end-of-piece banner', () => {
    view = mount(banners({ finished: true }))
    expect(view.container.textContent).not.toContain('End of the piece')
    expect(byText(view.container, 'Start again')).toBeNull()
  })

  it('the result card fades in, keeps the last result while fading out after Hide, then unmounts', () => {
    vi.useFakeTimers()
    const onDismissResult = vi.fn()
    view = mount(banners({}, { onDismissResult }))
    expect($(view.container, '[data-testid="attempt-result"]')).toBeNull()

    view.rerender(banners({ lastResult: RESULT }, { onDismissResult }))
    const card = () => $(view!.container, '[data-testid="attempt-result"]')
    expect(card()?.dataset['phase']).toBe('entering')
    advance(50)
    expect(card()?.dataset['phase']).toBe('visible')
    expect(card()?.dataset['passed']).toBe('true')
    expect(card()?.textContent).toContain('Clean pass')
    expect(card()?.textContent).toContain('2 clean in a row')
    expect(card()?.textContent).toContain('No wrong notes')
    expect(card()?.textContent).toContain('3.0 s')
    expect(card()?.textContent).toContain('100% right first time')
    expect(card()?.textContent).toContain('No help')

    click(byLabel(card()!, 'Hide result'))
    expect(onDismissResult).toHaveBeenCalledOnce()
    // The session clears the result; the card fades out still showing it.
    view.rerender(banners({ lastResult: null }, { onDismissResult }))
    expect(card()?.dataset['phase']).toBe('leaving')
    expect(card()?.textContent).toContain('No wrong notes')
    advance(RESULT_FADE_MS - 1)
    expect(card()).not.toBeNull()
    advance(2)
    expect(card()).toBeNull()
  })
})

describe('Keep time on the result card and the stage (P13)', () => {
  const TIMING = { groups: 42, onTime: 38, early: 0, late: 3, missed: 1 }

  it('words the timing: on time of all, then only the non-zero early, late and missed counts', () => {
    expect(timingText(TIMING)).toBe('On time 38 of 42 · 3 late · 1 missed')
    expect(timingText({ groups: 8, onTime: 8, early: 0, late: 0, missed: 0 })).toBe('On time 8 of 8')
    expect(timingText({ groups: 8, onTime: 5, early: 2, late: 0, missed: 1 })).toBe(
      'On time 5 of 8 · 2 early · 1 missed',
    )
  })

  it('shows timing accuracy in place of the completion time, keeping the streak and ladder lines', () => {
    view = mount(
      banners({
        activity: 'scored',
        rhythm: true,
        repeat: true,
        lastResult: { ...RESULT, passed: false, timing: TIMING, ladder: { droppedTo: 0.55 } },
      }),
    )
    const card = $(view.container, '[data-testid="attempt-result"]')!
    expect($(card, '[data-testid="timing-result"]')?.textContent).toBe('On time 38 of 42 · 3 late · 1 missed')
    expect(card.textContent).toContain('Timing')
    expect(card.textContent).not.toContain('expected')
    expect(card.textContent).toContain('2 clean in a row')
    expect($(card, '[data-testid="ladder-result"]')?.textContent).toBe('Back to 55%')
  })

  it('a gated result keeps its time line', () => {
    view = mount(banners({ activity: 'scored', lastResult: RESULT }))
    expect($(view.container, '[data-testid="timing-result"]')).toBeNull()
    expect(view.container.textContent).toContain('expected')
  })

  it('shows no Ready banner in Keep time: the count-in replaces it', () => {
    view = mount(banners({ activity: 'scored', phase: 'ready', rhythm: true, countIn: 3 }))
    expect($(view.container, '[data-testid="ready"]')).toBeNull()
    view.rerender(banners({ activity: 'scored', phase: 'ready' }))
    expect($(view.container, '[data-testid="ready"]')).not.toBeNull()
  })

  it('the count-in shows the beats left as a status, and nothing outside a count-in', () => {
    view = mount(<CountIn beats={3} />)
    const el = $(view.container, '[data-testid="count-in"]')!
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-label')).toBe('Count-in: 3')
    expect(el.textContent).toBe('3')
    view.rerender(<CountIn beats={1} />)
    expect($(view.container, '[data-testid="count-in"]')?.textContent).toBe('1')
    view.rerender(<CountIn beats={null} />)
    expect($(view.container, '[data-testid="count-in"]')).toBeNull()
  })
})

describe('GuidePanel', () => {
  it('slides its slot open and closed and keeps the guide mounted while it closes', () => {
    vi.useFakeTimers()
    const ui = new Store<SessionUi>(UI)
    const guide = new Store<GuideState>({ keys: [], rollDirection: undefined })
    const session = { ui, guide } as unknown as PracticeSession
    view = mount(<GuidePanel session={session} fadeMs={300} naming={DEFAULT_SETTINGS.naming} />)
    const slot = () => $(view!.container, '[data-testid="guide-slot"]')
    const region = () => $(view!.container, 'section[aria-label="Keyboard guide"]')
    expect(slot()?.dataset['open']).toBe('false')
    expect(region()).toBeNull()

    act(() => {
      ui.update({ keyboardVisible: true })
    })
    expect(slot()?.dataset['open']).toBe('true')
    expect(region()).not.toBeNull()

    act(() => {
      ui.update({ keyboardVisible: false })
    })
    expect(slot()?.dataset['open']).toBe('false')
    expect(region()).not.toBeNull() // still fading out while the slot closes
    advance(301)
    expect(region()).toBeNull()
    expect(slot()).not.toBeNull()
  })
})
