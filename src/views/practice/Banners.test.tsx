// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import type { AttemptSummary, GuideState, PracticeSession, SessionUi } from '../../app/session'
import { Store } from '../../app/session/store'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { $, byLabel, byText, click, mount, type Mounted } from '../shared/testing'
import {
  AttemptResult,
  DETAILS_FOLD_MS,
  Banners,
  RESULT_FADE_MS,
  ladderResultText,
  resultTitle,
  type AttemptResultProps,
  type BannersProps,
} from './Banners'
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
  micStatus: null,
  follow: 'piano',
  pianoConnected: true,
  micSupported: true,
  playThroughLocked: false,
  rhythm: false,
  countIn: null,
  metronomeScope: 'general',
  metronomeMuted: false,
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
  return <Banners ui={{ ...UI, ...ui }} onRestart={noop} onResume={noop} onConnection={noop} {...extra} />
}

function result(ui: Partial<SessionUi>, extra: Partial<AttemptResultProps> = {}) {
  return (
    <AttemptResult
      ui={{ ...UI, ...ui }}
      model={{ notes: [] }}
      naming={DEFAULT_SETTINGS.naming}
      details={() => <p data-testid="details-body">The details</p>}
      onRestart={noop}
      onDismiss={noop}
      {...extra}
    />
  )
}

/** F (65) for F♯ (66) in bar 12, three passes running (P24); no score note: spelled from the pitch. */
const MISTAKE = {
  group: 4,
  occ: 11,
  bar: '12',
  expectedPitches: [62, 66],
  expectedPitch: 66,
  expectedNote: 0,
  wrongPitch: 65,
  passes: 3,
}

const DISCONNECT = {
  reason: 'disconnect',
  text: 'The piano was disconnected, so the attempt stopped.',
  canResume: true,
} as const

describe('Banners', () => {
  it('shows the microphone status beside the sound status', () => {
    view = mount(banners({ micStatus: 'Following through the microphone.' }))
    const row = view.container.querySelector('[data-testid="mic-status"]')
    expect(row?.textContent).toContain('Following through the microphone.')
    view.rerender(banners({ micStatus: null }))
    expect(view.container.querySelector('[data-testid="mic-status"]')).toBeNull()
  })

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
    view.unmount()
    view = mount(result({ activity: 'playing', playThrough: true, lastResult: RESULT }))
    expect(view.container.textContent).not.toContain('Clean pass')
    expect(byLabel(view.container, 'Hide result')).toBeNull()
  })

  it('the result card says what the speed ladder did, in one line', () => {
    const line = () => $(view!.container, '[data-testid="ladder-result"]')?.textContent
    view = mount(result({ repeat: true, lastResult: { ...RESULT, ladder: { climbedTo: 0.65 } }, multiplier: 0.6 }))
    expect(line()).toBe('Speed up: next at 65%')
    view.rerender(result({ repeat: true, lastResult: { ...RESULT, ladder: { droppedTo: 0.55 } }, multiplier: 0.6 }))
    expect(line()).toBe('Back to 55%')
    view.rerender(result({ repeat: true, lastResult: { ...RESULT, ladder: { done: true } }, multiplier: 1 }))
    expect(line()).toBe('Goal reached: 100%')
    view.rerender(result({ repeat: true, lastResult: RESULT }))
    expect(line()).toBeUndefined()
    expect(ladderResultText({ ...RESULT, ladder: {} }, 1)).toBeNull()
  })

  it('heads the card with what kept the pass from being clean, the count of wrong notes in its badge', () => {
    expect(resultTitle(RESULT)).toBe('Clean pass')
    expect(resultTitle({ ...RESULT, passed: false, wrongAttacks: 1 })).toBe('1 wrong note')
    expect(resultTitle({ ...RESULT, passed: false, wrongAttacks: 3, assistance: 'names' })).toBe('3 wrong notes')
    const timing = { groups: 4, onTime: 3, early: 0, late: 1, missed: 0 }
    expect(resultTitle({ ...RESULT, passed: false, timing })).toBe('Timing slipped')
    expect(resultTitle({ ...RESULT, passed: false, assistance: 'keyboard' })).toBe('Played with help')
    expect(resultTitle({ ...RESULT, passed: false })).toBe('Completed')
    view = mount(result({ lastResult: { ...RESULT, passed: false, wrongAttacks: 2, streak: 0 } }))
    const card = $(view.container, '[data-testid="attempt-result"]')!
    expect(card.dataset['tone']).toBe('wrong')
    expect(card.textContent).toContain('2 wrong notes')
    expect($(card, '[aria-hidden="true"]')?.textContent).toBe('2')
    expect(card.textContent).not.toContain('in a row')
  })

  it('shows the Repeat goal as dots, Again only once the goal is met, and the repeated mistake on the note line', () => {
    view = mount(result({ repeat: true, repeatTarget: 3, lastResult: { ...RESULT, streak: 2 } }))
    const goal = () => $(view!.container, '[role="img"]')
    expect(goal()?.getAttribute('aria-label')).toBe('2 of 3 clean toward the goal')
    expect(goal()?.querySelectorAll('[data-on]')).toHaveLength(2)
    // In Repeat mode the next pass starts by playing: no Again until the goal ends Repeat.
    expect(byText(view.container, 'Again')).toBeNull()
    expect($(view.container, '[data-testid="result-note"]')).toBeNull()
    view.rerender(
      result({
        repeat: true,
        repeatTarget: 3,
        lastResult: {
          ...RESULT,
          streak: 3,
          targetReached: true,
          repeatedMistakes: [MISTAKE, { ...MISTAKE, wrongPitch: 67, passes: 3, bar: '13' }],
        },
      }),
    )
    expect(goal()?.querySelectorAll('[data-on]')).toHaveLength(3)
    expect(view.container.textContent).toContain('Goal reached. Repeat is off.')
    expect(byText(view.container, 'Again')).not.toBeNull()
    // The first (most passes) repeated mistake, worded with the naming settings.
    expect($(view.container, '[data-testid="result-note"]')?.textContent).toBe(
      'F instead of F♯ in bar 12, three passes running',
    )
    view.rerender(
      result(
        { repeat: true, repeatTarget: 3, lastResult: { ...RESULT, repeatedMistakes: [MISTAKE] } },
        { naming: { ...DEFAULT_SETTINGS.naming, system: 'fixed-do' } },
      ),
    )
    expect($(view.container, '[data-testid="result-note"]')?.textContent).toBe(
      'fa instead of fa♯ in bar 12, three passes running',
    )
    // No target: no dots.
    view.rerender(result({ repeat: true, repeatTarget: null, lastResult: RESULT }))
    expect(goal()).toBeNull()
  })

  it('has no end-of-piece banner', () => {
    view = mount(banners({ finished: true }))
    expect(view.container.textContent).not.toContain('End of the piece')
    expect(byText(view.container, 'Start again')).toBeNull()
  })

  it('the result card fades in, keeps the last result while fading out after Hide, then unmounts', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    view = mount(result({}, { onDismiss }))
    expect($(view.container, '[data-testid="attempt-result"]')).toBeNull()

    view.rerender(result({ lastResult: RESULT }, { onDismiss }))
    const card = () => $(view!.container, '[data-testid="attempt-result"]')
    expect(card()?.dataset['phase']).toBe('entering')
    advance(50)
    expect(card()?.dataset['phase']).toBe('visible')
    expect(card()?.dataset['passed']).toBe('true')
    expect(card()?.dataset['tone']).toBe('clean')
    expect(card()?.textContent).toContain('Clean pass')
    expect(card()?.textContent).toContain('2 clean in a row')
    // The details open in place (U99): the pill has no time, first-try share, help or marks count.
    for (const gone of ['3.0 s', 'right first time', 'No help', 'marks on the score', 'No wrong notes'])
      expect(card()?.textContent).not.toContain(gone)
    expect(byLabel(card()!, 'Show details of this pass')).not.toBeNull()
    expect(byText(card()!, 'Again')).not.toBeNull()

    click(byLabel(card()!, 'Hide result'))
    expect(onDismiss).toHaveBeenCalledOnce()
    // The session clears the result; the card fades out still showing it.
    view.rerender(result({ lastResult: null }, { onDismiss }))
    expect(card()?.dataset['phase']).toBe('leaving')
    expect(card()?.textContent).toContain('Clean pass')
    advance(RESULT_FADE_MS - 1)
    expect(card()).not.toBeNull()
    advance(2)
    expect(card()).toBeNull()
  })
})

describe('the result card expands in place (U99)', () => {
  const toggle = () => $(view!.container, '[data-testid="result-details-toggle"]')!
  const body = () => $(view!.container, '[data-testid="result-details"]')

  it('Details unfolds the details above the row and folds them back with the chevron', () => {
    vi.useFakeTimers()
    const details = vi.fn(() => <p data-testid="details-body">The details</p>)
    view = mount(result({ lastResult: RESULT }, { details }))
    advance(50)
    expect(body()).toBeNull()
    expect(details).not.toHaveBeenCalled() // nothing rendered (nor loaded) until the first expansion
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().getAttribute('aria-label')).toBe('Show details of this pass')
    expect(toggle().textContent).toContain('Details')

    click(toggle())
    expect(body()?.textContent).toBe('The details')
    expect(body()?.getAttribute('aria-label')).toBe('Details of this pass')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().getAttribute('aria-controls')).toBe(body()?.id)
    expect(toggle().getAttribute('aria-label')).toBe('Hide details')
    // The details come before the row (above it), outside its status live region.
    const card = $(view.container, '[data-testid="attempt-result"]')!
    expect(card.firstElementChild).toBe(body())
    expect(body()?.closest('[role="status"]')).toBeNull()
    expect(details).toHaveBeenCalledWith(RESULT)

    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(body()?.dataset['phase']).toBe('leaving') // folding
    advance(DETAILS_FOLD_MS + 1)
    expect(body()).toBeNull()
  })

  it('Escape folds it; a new result or none starts folded', () => {
    vi.useFakeTimers()
    view = mount(result({ lastResult: RESULT }))
    advance(50)
    click(toggle())
    expect(body()).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    advance(DETAILS_FOLD_MS + 1)
    expect(body()).toBeNull()

    click(toggle())
    expect(body()).not.toBeNull()
    // The next pass's result: folded (the expanded state is never carried over).
    view.rerender(result({ lastResult: { ...RESULT, id: 'a2' } }))
    advance(DETAILS_FOLD_MS + 1)
    expect(body()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    // Anything that ends the result (the next pass's first key, Start, Hide, a seek) folds it.
    click(toggle())
    view.rerender(result({ lastResult: null }))
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    advance(RESULT_FADE_MS + 1)
    expect($(view.container, '[data-testid="attempt-result"]')).toBeNull()
  })

  it('without details there is no Details control', () => {
    view = mount(
      <AttemptResult
        ui={{ ...UI, lastResult: RESULT }}
        model={{ notes: [] }}
        naming={DEFAULT_SETTINGS.naming}
        onRestart={noop}
        onDismiss={noop}
      />,
    )
    expect($(view.container, '[data-testid="result-details-toggle"]')).toBeNull()
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
      result({
        activity: 'scored',
        rhythm: true,
        repeat: true,
        lastResult: { ...RESULT, passed: false, timing: TIMING, ladder: { droppedTo: 0.55 } },
      }),
    )
    const card = $(view.container, '[data-testid="attempt-result"]')!
    expect($(card, '[data-testid="timing-result"]')?.textContent).toBe('On time 38 of 42 · 3 late · 1 missed')
    expect(card.textContent).toContain('Timing slipped')
    expect(card.textContent).not.toContain('expected')
    expect(card.textContent).toContain('2 clean in a row')
    expect($(card, '[data-testid="ladder-result"]')?.textContent).toBe('Back to 55%')
  })

  it('a gated result shows no timing line and no completion time (Details has it)', () => {
    view = mount(result({ activity: 'scored', lastResult: RESULT }))
    expect($(view.container, '[data-testid="timing-result"]')).toBeNull()
    expect(view.container.textContent).not.toContain('expected')
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
