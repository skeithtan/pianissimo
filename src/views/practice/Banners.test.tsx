// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import type { AttemptSummary, GuideState, PracticeSession, SessionUi } from '../../app/session'
import { Store } from '../../app/session/store'
import type { ScoreModel } from '../../core/model/score'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { $, byLabel, byText, click, mount, type Mounted } from '../shared/testing'
import { Banners, RESULT_FADE_MS, type BannersProps } from './Banners'
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
  lastResult: null,
  corrections: 0,
  interruption: null,
  soundStatus: null,
  inputDisconnected: false,
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
      model={{} as ScoreModel}
      resumedFrom={null}
      onResumeDismiss={noop}
      onFromStart={noop}
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
  it('shows one disconnect notice: the input banner holds back the disconnect interruption', () => {
    view = mount(banners({ inputDisconnected: true, interruption: DISCONNECT }))
    const notice = $(view.container, '[data-testid="input-disconnected"]')
    expect(notice?.textContent).toContain('Piano disconnected. Reconnect it to continue.')
    expect(byText(notice!, 'Connection')).not.toBeNull()
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()

    // The piano is back: the interruption shows with its actions.
    view.rerender(banners({ inputDisconnected: false, interruption: DISCONNECT }))
    expect($(view.container, '[data-testid="input-disconnected"]')).toBeNull()
    const interruption = $(view.container, '[data-testid="interruption"]')
    expect(interruption?.textContent).toContain('The piano was disconnected')
    expect(byText(interruption!, 'Resume from here')).not.toBeNull()
    expect(byText(interruption!, 'Restart')).not.toBeNull()
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
