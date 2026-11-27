// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import type { AttemptSummary, GuideState, PracticeSession, SessionUi } from '../../app/session'
import { Store } from '../../app/session/store'
import type { Language } from '../../core/model/language'
import type { PassageRange } from '../../core/model/practice'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import en from '../../i18n/locales/en-US.json'
import fr from '../../i18n/locales/fr-FR.json'
import ja from '../../i18n/locales/ja-JP.json'
import { readMessagesWith } from '../../i18n/messages'
import { $, byLabel, byText, click, mount, type Mounted } from '../shared/testing'
import {
  AttemptResult,
  DETAILS_FOLD_MS,
  Banners,
  QUICK_FOLD_MS,
  wrapTab,
  RESULT_FADE_MS,
  RESULT_SLIDE_MS,
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
  mode: 'wait',
  hands: 'both',
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
  canRestartLoop: false,
  repeatTarget: null,
  ladder: null,
  drill: null,
  lastResult: null,
  resultDimmed: false,
  resultExit: 'dismissed',
  reviewing: false,
  corrections: 0,
  interruption: null,
  soundStatus: null,
  inputDisconnected: false,
  micStatus: null,
  follow: 'piano',
  pianoConnected: true,
  micSupported: true,
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
      model={{ notes: [], occurrences: [] }}
      naming={DEFAULT_SETTINGS.naming}
      details={(_, actions) => <div data-testid="details-body">The details{actions}</div>}
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

  it('shows one disconnect notice, and none once the piano is back', async () => {
    vi.useFakeTimers()
    view = mount(banners({ inputDisconnected: true, interruption: DISCONNECT }))
    const notice = $(view.container, '[data-testid="input-disconnected"]')
    expect(notice?.textContent).toContain('Piano disconnected')
    expect(notice?.textContent).toContain('Reconnect it to continue.')
    expect(byText(notice!, 'Connect piano')).not.toBeNull()
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()

    // The piano is back: no disconnect message remains (the footer offers Resume / Start).
    view.rerender(banners({ inputDisconnected: false, interruption: DISCONNECT }))
    expect($(view.container, '[data-testid="input-disconnected"]')).toBeNull()
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()
    // It slides back out (U166): inert while it leaves, then gone.
    expect(byText(view.container, 'Piano disconnected')!.closest('[inert]')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
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

  it('shows no result card or interruption in Follow (P12)', () => {
    view = mount(
      banners({
        activity: 'playing',
        mode: 'follow',
        lastResult: RESULT,
        interruption: { reason: 'seek', text: 'Moving through the score stopped the attempt.', canResume: true },
      }),
    )
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()
    view.unmount()
    view = mount(result({ activity: 'playing', mode: 'follow', lastResult: RESULT }))
    expect(view.container.textContent).not.toContain('Clean pass')
    expect(byLabel(view.container, 'Hide result')).toBeNull()
  })

  it('the result card says what the speed ladder did, in one line', () => {
    const line = () => $(view!.container, '[data-testid="ladder-result"]')?.textContent
    view = mount(result({ repeat: true, lastResult: { ...RESULT, ladder: { climbedTo: 0.65 } }, multiplier: 0.6 }))
    expect(line()).toBe('Speed up: next at 65%')
    view.rerender(result({ repeat: true, lastResult: { ...RESULT, ladder: { done: true } }, multiplier: 1 }))
    expect(line()).toBe('Goal reached: 100%')
    view.rerender(result({ repeat: true, lastResult: { ...RESULT, ladder: { held: true } }, multiplier: 0.75 }))
    expect(line()).toBe('Clean, with pauses: staying at 75%')
    view.rerender(result({ repeat: true, lastResult: RESULT }))
    expect(line()).toBeUndefined()
    expect(ladderResultText({ ...RESULT, ladder: {} }, 1)).toBeNull()
  })

  it('heads the card with what kept the pass from being clean, the count of wrong notes in its badge', () => {
    expect(resultTitle(RESULT)).toBe('Clean pass')
    expect(resultTitle({ ...RESULT, passed: false, wrongAttacks: 1 })).toBe('1 wrong note')
    expect(resultTitle({ ...RESULT, passed: false, wrongAttacks: 3 })).toBe('3 wrong notes')
    const timing = { groups: 4, onTime: 3, early: 0, late: 1, missed: 0 }
    expect(resultTitle({ ...RESULT, passed: false, timing })).toBe('Timing slipped')
    expect(resultTitle({ ...RESULT, passed: false })).toBe('Completed')
    view = mount(result({ lastResult: { ...RESULT, passed: false, wrongAttacks: 2, streak: 0 } }))
    const card = $(view.container, '[data-testid="attempt-result"]')!
    expect(card.dataset['tone']).toBe('wrong')
    expect(card.textContent).toContain('2 wrong notes')
    expect($(card, '[aria-hidden="true"]')?.textContent).toBe('2')
    expect(card.textContent).not.toContain('in a row')
  })

  it('shows the Repeat goal as dots and the repeated mistake on the note line', () => {
    view = mount(result({ repeat: true, repeatTarget: 3, lastResult: { ...RESULT, streak: 2 } }))
    const goal = () => $(view!.container, '[role="img"]')
    expect(goal()?.getAttribute('aria-label')).toBe('2 of 3 clean toward the goal')
    expect(goal()?.querySelectorAll('[data-on]')).toHaveLength(2)
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
    const preview = $(card()!, '[data-testid="result-details-preview"]')!
    expect(Array.from(preview.querySelectorAll('p, li'), (line) => line.textContent)).toEqual([
      'No mistakes in this pass.',
      'This pass',
      'Right the first time at 4 of 4 places',
      'Took 3.0 s; the music lasts 3.0 s at this speed (0.0 s)',
      '2 clean in a row',
    ])
    for (const gone of ['marks on the score', 'No wrong notes']) expect(card()?.textContent).not.toContain(gone)
    expect(byLabel(card()!, 'Show details of this pass')).not.toBeNull()

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

describe('the pill has no actions; its card has them (U142)', () => {
  const occurrences = Array.from({ length: 40 }, (_, occ) => ({
    number: String((occ % 20) + 1),
    pass: occ < 20 ? 1 : 2,
  })) as unknown as AttemptResultProps['model']['occurrences']
  const model = { notes: [], occurrences }
  const run: AttemptSummary = {
    ...RESULT,
    run: true,
    passed: false,
    wrongAttacks: 4,
    completionTimeSec: null,
    expectedTimeSec: null,
    streak: 0,
    rough: { fromOcc: 8, toOcc: 11 },
  }
  const card = () => $(view!.container, '[data-testid="attempt-result"]')!
  const open = () => click($(card(), '[data-testid="result-details-toggle"]'))
  const choices = () => $(view!.container, '[data-testid="result-choices"]')
  const loop = () => $(view!.container, '[data-testid="result-loop"]')
  const labels = () => Array.from(choices()?.querySelectorAll('button') ?? [], (b) => b.textContent)
  const speak = (language: Language, catalog: Record<string, string>) => {
    const source = en as Record<string, string>
    const strings = Object.fromEntries(Object.entries(catalog).map(([id, text]) => [source[id]!, text]))
    readMessagesWith(() => ({ language, strings }))
  }
  afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

  it.each([
    ['a run with rough bars', { lastResult: run }],
    ['a clean pass', { lastResult: RESULT }],
    ['Repeat', { repeat: true, lastResult: RESULT }],
    ['Repeat at its goal', { repeat: true, repeatTarget: 2, lastResult: { ...RESULT, targetReached: true } }],
    ['Keep time', { mode: 'time' as const, lastResult: { ...run, run: undefined as never } }],
  ])('the pill of %s: only the whole-pill control and ✕', (_, ui) => {
    for (const phone of [false, true]) {
      view?.unmount()
      view = mount(result(ui, { model, onLoop: noop, phone }))
      expect(Array.from(card().querySelectorAll('button'), (b) => b.getAttribute('aria-label'))).toEqual([
        'Show details of this pass',
        'Hide result',
      ])
      expect(choices()).toBeNull()
    }
  })

  it('the card offers Loop first, then Again; each does its own', () => {
    const onLoop = vi.fn()
    const onRestart = vi.fn()
    view = mount(result({ lastResult: run }, { model, onLoop, onRestart }))
    open()
    expect(labels()).toEqual(['Loop 9–12', 'Again'])
    expect($(card(), '[data-testid="result-details"]')!.contains(choices())).toBe(true)
    click(loop())
    expect([onLoop.mock.calls.length, onRestart.mock.calls.length]).toEqual([1, 0])
    click(byText(choices()!, 'Again'))
    expect([onLoop.mock.calls.length, onRestart.mock.calls.length]).toEqual([1, 1])
  })

  it('one of them is primary: Loop when it is there, else Again', () => {
    const primary = () =>
      Array.from(choices()!.querySelectorAll('button'))
        .filter((b) => /primary/.test(b.className))
        .map((b) => b.textContent)
    view = mount(result({ lastResult: run }, { model, onLoop: noop }))
    open()
    expect(primary()).toEqual(['Loop 9–12'])
    view.unmount()
    view = mount(result({ lastResult: RESULT }, { model, onLoop: noop }))
    open()
    expect(labels()).toEqual(['Again'])
    expect(primary()).toEqual(['Again'])
  })

  it('in Repeat, none until the goal ends it, then Again', () => {
    view = mount(result({ repeat: true, repeatTarget: 3, lastResult: RESULT }, { model, onLoop: noop }))
    open()
    expect(choices()).toBeNull()
    view.unmount()
    view = mount(
      result(
        { repeat: true, repeatTarget: 2, lastResult: { ...RESULT, targetReached: true } },
        { model, onLoop: noop },
      ),
    )
    open()
    expect(labels()).toEqual(['Again'])
  })

  it('words one bar and a repeated one as the Repeat panel does, and in the language shown', () => {
    const shown = (rough: PassageRange) => {
      view?.unmount()
      view = mount(result({ lastResult: { ...run, rough } }, { model, onLoop: noop }))
      open()
      return loop()?.textContent
    }
    expect(shown({ fromOcc: 11, toOcc: 11 })).toBe('Loop 12')
    expect(shown({ fromOcc: 18, toOcc: 21 })).toBe('Loop 19–2 (2nd)')
    speak('fr-FR', fr)
    expect(shown({ fromOcc: 8, toOcc: 11 })).toBe('Boucler 9–12')
    speak('ja-JP', ja)
    expect(shown({ fromOcc: 8, toOcc: 11 })).toBe('第9～12小節を反復')
  })

  it('a card that opening Repeat sends away keeps its actions while it folds', () => {
    vi.useFakeTimers()
    view = mount(result({ lastResult: run, repeatTarget: 3 }, { model, onLoop: noop }))
    advance(50)
    open()
    view.rerender(result({ lastResult: null, repeat: true, repeatTarget: 3 }, { model, onLoop: noop }))
    expect($(card(), '[data-testid="result-details"]')?.dataset['phase']).toBe('leaving')
    expect(labels()).toEqual(['Loop 9–12', 'Again'])
    expect($(card(), '[role="img"]')).toBeNull()
  })

  it('tells the peek whether there is something to correct, and when nothing is played', () => {
    const peek = vi.fn((_: AttemptSummary, s: { marked: boolean; idle: boolean }) => (
      <i data-testid="peek">{String(s.idle)}</i>
    ))
    const last = () => peek.mock.calls.at(-1)![1]
    view = mount(result({ lastResult: RESULT, phase: 'completed' }, { peek }))
    expect(last()).toEqual({ marked: false, idle: true })
    // Its marks go with Start; what it peeks at stays.
    view.rerender(result({ lastResult: { ...RESULT, id: 'a2' }, corrections: 2, phase: 'completed' }, { peek }))
    expect(last()).toEqual({ marked: true, idle: true })
    view.rerender(result({ lastResult: { ...RESULT, id: 'a2' }, corrections: 0, phase: 'running' }, { peek }))
    expect(last()).toEqual({ marked: true, idle: false })
    view.rerender(result({ lastResult: { ...RESULT, id: 'a2' }, phase: 'ready', countIn: 2 }, { peek }))
    expect(last().idle).toBe(false)
    expect($(card(), '[data-testid="peek"]')!.closest('[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('the result card in other languages (P5)', () => {
  afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))
  it('words the streak in one sentence', () => {
    const source = en as Record<string, string>
    const strings = Object.fromEntries(Object.entries(fr).map(([id, text]) => [source[id]!, text]))
    readMessagesWith(() => ({ language: 'fr-FR', strings }))
    view = mount(result({ lastResult: { ...RESULT, streak: 3 } }))
    expect($(view.container, '[data-testid="attempt-result"]')?.textContent).toContain('3 essais sans faute de suite')
  })
})

describe('the result card expands in place (U99)', () => {
  const toggle = () => $(view!.container, '[data-testid="result-details-toggle"]')!
  const body = () => $(view!.container, '[data-testid="result-details"]')

  it('the summary opens and folds the details, with an unlabeled visual cue', () => {
    vi.useFakeTimers()
    const details = vi.fn(() => <p data-testid="details-body">The details</p>)
    view = mount(result({ lastResult: RESULT }, { details }))
    advance(50)
    expect(body()).toBeNull()
    expect(details).not.toHaveBeenCalled() // nothing rendered (nor loaded) until the first expansion
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().getAttribute('aria-label')).toBe('Show details of this pass')
    expect(toggle().textContent).toBe('')
    expect(toggle().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')

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
    expect(details).toHaveBeenCalledWith(RESULT, expect.anything())

    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(body()?.dataset['phase']).toBe('leaving') // folding
    advance(DETAILS_FOLD_MS + 1)
    expect(body()).toBeNull()
  })

  it('swiping the summary opens or dismisses it without also clicking it', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    view = mount(result({ lastResult: RESULT }, { onDismiss }))
    advance(50)
    const swipe = (x: number, y: number) =>
      act(() => {
        const common = { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0 }
        toggle().dispatchEvent(new PointerEvent('pointerdown', common))
        toggle().dispatchEvent(new PointerEvent('pointerup', { ...common, clientX: x, clientY: y }))
        toggle().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
      })
    swipe(52, -42)
    expect(body()).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
    swipe(3, -54)
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(body()).not.toBeNull()
    swipe(-3, 56)
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(toggle().getAttribute('aria-expanded')).toBe('true') // the session owns dismissal
  })

  it('a touch swipe that opens it sends no click: the first tap inside the details still acts (P1)', () => {
    vi.useFakeTimers()
    const inside = vi.fn()
    const details = () => (
      <button type="button" data-testid="inside" onClick={inside}>
        What you played
      </button>
    )
    view = mount(result({ lastResult: RESULT }, { details }))
    advance(50)
    act(() => {
      const common = { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0 }
      toggle().dispatchEvent(new PointerEvent('pointerdown', { ...common, clientX: 0, clientY: 0 }))
      toggle().dispatchEvent(new PointerEvent('pointerup', { ...common, clientX: 2, clientY: -60 }))
    })
    expect(body()).not.toBeNull()
    // A touch drag is not followed by a click; the next tap is a new gesture.
    advance(300)
    click($(view.container, '[data-testid="inside"]'))
    expect(inside).toHaveBeenCalledOnce()
    // A mouse drag is: that one click (on the pill it started on) does not toggle the card.
    act(() => {
      const common = { bubbles: true, pointerId: 2, isPrimary: true, pointerType: 'mouse', button: 0 }
      toggle().dispatchEvent(new PointerEvent('pointerdown', { ...common, clientX: 0, clientY: 0 }))
      toggle().dispatchEvent(new PointerEvent('pointerup', { ...common, clientX: 30, clientY: 0 }))
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    // And a capture lost before the release (no click follows) arms nothing either.
    act(() => {
      const common = { bubbles: true, pointerId: 3, isPrimary: true, pointerType: 'touch', button: 0 }
      toggle().dispatchEvent(new PointerEvent('pointerdown', { ...common, clientX: 0, clientY: 0 }))
      toggle().dispatchEvent(new PointerEvent('pointercancel', common))
    })
    click($(view.container, '[data-testid="inside"]'))
    expect(inside).toHaveBeenCalledTimes(2)
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

    // Anything that ends the result (the next pass playing past it, Start, Hide, a seek) folds it.
    click(toggle())
    view.rerender(result({ lastResult: null }))
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(body()?.dataset['phase']).toBe('leaving')
    advance(DETAILS_FOLD_MS + 1)
    expect(body()).toBeNull()
    expect($(view.container, '[data-testid="attempt-result"]')?.dataset['phase']).toBe('leaving')
    advance(RESULT_FADE_MS + 1)
    expect($(view.container, '[data-testid="attempt-result"]')).toBeNull()
  })

  it('the next pass’s first correct note dims the pill and folds it; a tap only brings it back (U101)', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    view = mount(result({ lastResult: RESULT }, { onDismiss }))
    advance(50)
    const card = () => $(view!.container, '[data-testid="attempt-result"]')!
    click(toggle())
    expect(body()).not.toBeNull()
    // Wrong keys change nothing (the session keeps resultDimmed false); the first correct note:
    view.rerender(result({ lastResult: RESULT, resultDimmed: true }, { onDismiss }))
    expect(card().dataset['dimmed']).toBe('true')
    // A short fold: it never holds up the pass being played.
    expect(body()?.dataset['phase']).toBe('leaving')
    advance(QUICK_FOLD_MS + 1)
    expect(body()).toBeNull()
    // A tap on Hide while dimmed only brings the pill back to full strength.
    click(byLabel(card(), 'Hide result'))
    expect(onDismiss).not.toHaveBeenCalled()
    expect(card().dataset['dimmed']).toBeUndefined()
    click(byLabel(card(), 'Hide result'))
    expect(onDismiss).toHaveBeenCalledOnce()
    // Restored for this result only: the next one dims again.
    view.rerender(result({ lastResult: { ...RESULT, id: 'a2' }, resultDimmed: true }, { onDismiss }))
    expect(card().dataset['dimmed']).toBe('true')
  })

  it('played past, it slides away as it was (dimmed), in RESULT_SLIDE_MS; dismissed, it fades (U101)', () => {
    vi.useFakeTimers()
    view = mount(result({ lastResult: RESULT, resultDimmed: true }))
    advance(50)
    const card = () => $(view!.container, '[data-testid="attempt-result"]')
    view.rerender(result({ lastResult: null, resultDimmed: false, resultExit: 'played' }))
    expect(card()?.dataset['phase']).toBe('leaving')
    expect(card()?.dataset['exit']).toBe('played')
    expect(card()?.dataset['dimmed']).toBe('true')
    advance(RESULT_SLIDE_MS - 1)
    expect(card()).not.toBeNull()
    advance(2)
    expect(card()).toBeNull()

    view.rerender(result({ lastResult: RESULT }))
    advance(50)
    view.rerender(result({ lastResult: null, resultExit: 'dismissed' }))
    expect(card()?.dataset['exit']).toBe('dismissed')
    expect(card()?.dataset['dimmed']).toBeUndefined()
    advance(RESULT_FADE_MS + 1)
    expect(card()).toBeNull()
  })

  it('without details there is no Details control', () => {
    view = mount(
      <AttemptResult
        ui={{ ...UI, lastResult: RESULT }}
        model={{ notes: [], occurrences: [] }}
        naming={DEFAULT_SETTINGS.naming}
        onRestart={noop}
        onDismiss={noop}
      />,
    )
    expect($(view.container, '[data-testid="result-details-toggle"]')).toBeNull()
  })
})

describe('the expanded result by screen size (U99, 17 November 2026)', () => {
  const toggle = () => $(view!.container, '[data-testid="result-details-toggle"]')!
  const body = () => $(view!.container, '[data-testid="result-details"]')
  const hide = () => $(view!.container, '[data-testid="result-details-hide"]') as HTMLButtonElement | null

  it('a tablet gets a labeled region over the score, no header of its own', () => {
    vi.useFakeTimers()
    view = mount(result({ lastResult: RESULT }, { phone: false }))
    advance(50)
    click(toggle())
    expect(body()?.dataset['layout']).toBe('panel')
    expect(body()?.getAttribute('role')).toBeNull()
    expect(body()?.getAttribute('aria-modal')).toBeNull()
    expect($(view.container, '[data-testid="result-screen-header"]')).toBeNull()
    expect(hide()).toBeNull()
    expect($(view.container, '[role="status"]')?.hasAttribute('inert')).toBe(false)
  })

  it('a phone gets a full-screen modal dialog: header with the verdict, chevron and Hide', () => {
    vi.useFakeTimers()
    const onRestart = vi.fn()
    const onDismiss = vi.fn()
    view = mount(result({ lastResult: RESULT }, { phone: true, onRestart, onDismiss }))
    advance(50)
    click(toggle())
    expect(body()?.dataset['layout']).toBe('screen')
    expect(body()?.getAttribute('role')).toBe('dialog')
    expect(body()?.getAttribute('aria-modal')).toBe('true')
    expect(body()?.getAttribute('aria-label')).toBe('Details of this pass')
    const header = $(view.container, '[data-testid="result-screen-header"]')!
    expect(header.querySelector('h2')?.textContent).toContain('Clean pass')
    expect(header.contains(hide())).toBe(true)
    expect(hide()?.getAttribute('aria-label')).toBe('Hide details')
    // The header comes before the content, which is the same details content as the tablet's.
    expect(header.nextElementSibling?.getAttribute('data-testid')).toBe('details-body')
    // The pill underneath is covered: inert, so neither tapped nor tabbed to.
    expect($(view.container, '[role="status"]')?.hasAttribute('inert')).toBe(true)
    // Focus moved into the panel, onto the chevron.
    expect(document.activeElement).toBe(hide())
    // Again is in the card, not in the header that stays.
    expect(byText(header, 'Again')).toBeNull()
    click(byText(body()!, 'Again')!)
    expect(onRestart).toHaveBeenCalledTimes(1)
    click(byLabel(header, 'Hide result')!)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("the panel chevron folds it and focus returns to the pill's chevron; Escape does too", () => {
    vi.useFakeTimers()
    view = mount(result({ lastResult: RESULT }, { phone: true }))
    advance(50)
    click(toggle())
    expect(document.activeElement).toBe(hide())
    click(hide()!)
    advance(DETAILS_FOLD_MS + 1)
    expect(body()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect($(view.container, '[role="status"]')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(toggle())

    click(toggle())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    advance(DETAILS_FOLD_MS + 1)
    expect(body()).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('Tab stays inside the full-screen panel, and focus that strays is pulled back', () => {
    vi.useFakeTimers()
    view = mount(result({ lastResult: RESULT }, { phone: true }))
    advance(50)
    click(toggle())
    const panel = body()!
    const items = Array.from(panel.querySelectorAll<HTMLElement>('button'))
    expect(items.length).toBeGreaterThanOrEqual(3)
    const last = items[items.length - 1]!
    last.focus()
    expect(wrapTab(panel, { shiftKey: false }, last)).toBe(true)
    expect(document.activeElement).toBe(items[0])
    expect(wrapTab(panel, { shiftKey: true }, items[0]!)).toBe(true)
    expect(document.activeElement).toBe(last)
    // In the middle the browser's own Tab order applies.
    expect(wrapTab(panel, { shiftKey: false }, items[1]!)).toBe(false)
    // Something outside takes focus: it comes back to the chevron.
    const outside = document.createElement('button')
    document.body.append(outside)
    act(() => outside.focus())
    expect(document.activeElement).toBe(hide())
    outside.remove()
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

  it('shows timing accuracy and the streak in place of the completion time for a failed pass', () => {
    view = mount(
      result({
        activity: 'scored',
        mode: 'time',
        repeat: true,
        lastResult: { ...RESULT, passed: false, timing: TIMING },
      }),
    )
    const card = $(view.container, '[data-testid="attempt-result"]')!
    expect($(card, '[data-testid="timing-result"]')?.textContent).toBe('On time 38 of 42 · 3 late · 1 missed')
    expect(card.textContent).toContain('Timing slipped')
    expect(card.textContent).not.toContain('expected')
    expect(card.textContent).toContain('2 clean in a row')
    expect($(card, '[data-testid="ladder-result"]')).toBeNull()
  })

  it('a gated result shows no timing line and no completion time (Details has it)', () => {
    view = mount(result({ activity: 'scored', lastResult: RESULT }))
    expect($(view.container, '[data-testid="timing-result"]')).toBeNull()
    expect(view.container.textContent).not.toContain('expected')
  })

  it('shows no Ready banner in Keep time: the count-in replaces it', () => {
    view = mount(banners({ activity: 'scored', phase: 'ready', mode: 'time', countIn: 3 }))
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

describe('AttemptResult drill return action (U168)', () => {
  const openCard = () =>
    click($(view!.container, '[data-testid="attempt-result"] [data-testid="result-details-toggle"]'))
  const back = () => $(view!.container, '[data-testid="result-choices"] [data-testid="drill-back"]')

  it('offers "Back to …" in the card while drilling, primary once the goal is reached, and calls onEndDrill', () => {
    const onEndDrill = vi.fn()
    const drilling = (streak: number, targetReached: boolean) =>
      result(
        {
          repeat: true,
          repeatTarget: 3,
          drill: { returnText: 'Bars 5–8' },
          lastResult: { ...RESULT, streak, targetReached },
        },
        { onEndDrill },
      )
    view = mount(drilling(1, false))
    expect($(view.container, '[data-testid="drill-back"]')).toBeNull()
    openCard()
    expect(back()!.textContent).toContain('Back to Bars 5–8')
    expect(back()!.dataset['variant']).toBe('secondary')
    click(back()!)
    expect(onEndDrill).toHaveBeenCalledTimes(1)

    view.unmount()
    view = mount(drilling(3, true))
    openCard()
    expect(back()!.dataset['variant']).toBe('primary')
    expect(byText(view.container, 'Again')).toBeNull()
    expect(view.container.textContent).not.toContain('Goal reached. Repeat is off.')
  })
})
