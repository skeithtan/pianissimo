// @vitest-environment happy-dom
/** The four modes on the score screen (DECISIONS U141), with the rules Sheet music had (U72, U105). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { connectionOpen, currentView, practiceRequest, settingsOpen, settingsTab } from '../../app/navigation'
import { connectionStatus, notices, resetAppStateForTests, settings, updateSettings } from '../../app/state'
import { comparisonContext } from '../../core/history/testkit'
import type { PracticeMode } from '../../core/model/practice'
import type { BrowserAudioModule } from '../../core/playback'
import { RecordingBackend } from '../../core/playback/testkit'
import { attemptFor } from '../../core/storage/testkit'
import { msg } from '../../i18n/messages'
import { untranslatedText, usePseudoCatalog } from '../shared/catalogTesting'
import { MODES } from '../shared/modes'
import { $, $$, byLabel, byText, click, mount, press, type Mounted } from '../shared/testing'
import type { PracticeEnv } from './env'
import { PracticeViewWith } from './PracticeView'
import { RECEDE_DELAY_MS } from './recede'
import { onScreen, rig, settle, tap, type Rig } from './viewTestkit'

let view: Mounted | null = null
let restoreScreen: (() => void) | null = null

beforeEach(() => {
  resetAppStateForTests()
  connectionStatus.value = { state: 'connected', inputName: 'Test piano' }
  // A piano that can play, with no echo: one hand can be graded.
  updateSettings({ route: { outputId: 'out-1', outputName: 'Piano', outputVerified: true, echo: 'none' } })
  practiceRequest.value = null
  settingsOpen.value = false
  settingsTab.value = 'reading'
})

afterEach(() => {
  view?.unmount()
  view = null
  restoreScreen?.()
  restoreScreen = null
})

async function opened(
  env: Partial<PracticeEnv> = {},
  piece: { mode?: PracticeMode } = {},
  request: { mode?: PracticeMode } = {},
): Promise<Rig> {
  const r = await rig()
  await r.storage.updatePiece(r.pieceId, piece)
  practiceRequest.value = { pieceId: r.pieceId, ...request }
  view = mount(<PracticeViewWith env={{ ...r.env, micSupported: () => false, ...env }} />)
  await settle(r)
  return r
}

const root = () => view!.container
const screen = () => $(root(), '[data-activity]')!
const choice = () => $(root(), '[data-mode-choice] [role="radiogroup"]')!
const option = (name: string) => $$(choice(), '[role="radio"]').find((el) => el.textContent === name)!
const label = (el: Element) => el.getAttribute('aria-label') ?? ''
const main = () => $$(root(), 'footer button').find((b) => ['Start', 'Resume', 'Play', 'Pause'].includes(label(b)))!
const hand = (name: 'Left hand' | 'Right hand') => byLabel(root(), name)!
const pressed = () =>
  (['Left hand', 'Right hand'] as const).map((name) => hand(name).getAttribute('aria-pressed') === 'true')
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]')

async function setMode(r: Rig, name: string): Promise<void> {
  click(option(name))
  await settle(r, 1)
}

describe('the header control', () => {
  it('names the four modes, each titled by its description', async () => {
    await opened()
    expect(choice().getAttribute('aria-label')).toBe('Mode')
    expect($$(choice(), '[role="radio"]').map((el) => [el.textContent, el.title])).toEqual([
      ['Listen', 'The app plays it for you.'],
      ['Wait', 'The score waits until you play the right notes.'],
      ['Keep time', 'The score keeps going, whatever you play.'],
      ['Follow', 'The score follows your playing. Nothing is graded.'],
    ])
    expect(option('Wait').getAttribute('aria-checked')).toBe('true')
    // It is in the header, with Back and the title before it and the connection and Settings after.
    const header = $(root(), '[data-testid="practice-header"]')!
    expect(header.contains(choice())).toBe(true)
    expect(header.dataset['modes']).toBe('all')
  })

  it('a mode is saved on the piece at once, starts nothing and stops what plays', async () => {
    const r = await opened()
    for (const [name, mode, button] of [
      ['Keep time', 'time', 'Start'],
      ['Follow', 'follow', 'Start'],
      ['Listen', 'listen', 'Play'],
      ['Wait', 'wait', 'Start'],
    ] as const) {
      await setMode(r, name)
      expect(screen().dataset['mode']).toBe(mode)
      expect(label(main()), name).toBe(button)
      await settle(r)
      expect((await r.storage.getPiece(r.pieceId))?.mode).toBe(mode)
    }
    click(main())
    await settle(r)
    expect(label(main())).toBe('Pause')
    await setMode(r, 'Listen')
    expect(label(main())).toBe('Play')
    click(main())
    await settle(r, 3)
    expect(label(main())).toBe('Pause')
    await setMode(r, 'Wait')
    expect(label(main())).toBe('Start')
  })

  it('dims and is inert in focus mode; in Listen nothing recedes but the cursor’s repeat button (U72)', async () => {
    const r = await opened()
    const modes = $(root(), '[data-testid="practice-modes"]')!
    click(main())
    await settle(r)
    expect(modes.inert).toBe(false)
    act(() => r.clock.advance(RECEDE_DELAY_MS))
    await settle(r, 1)
    expect(screen().dataset['recede']).toBe('true')
    expect(modes.inert).toBe(true)
    click(main())
    await settle(r, 1)
    expect(modes.inert).toBe(false)

    await setMode(r, 'Listen')
    click(main())
    await settle(r, 3)
    expect(label(main())).toBe('Pause')
    expect(r.strips.at(-1)!.cursorAction).toBe(true)
    act(() => r.clock.advance(RECEDE_DELAY_MS))
    await settle(r, 1)
    expect(screen().dataset['recede']).toBeUndefined()
    expect(modes.inert).toBe(false)
    expect($(root(), '[data-testid="footer-tools-slot"]')!.inert).toBe(false)
    expect(r.strips.at(-1)!.cursorAction).toBe(false)
  })

  it('Keep time counts in over the stage (P13)', async () => {
    const r = await opened({}, { mode: 'time' })
    click(main())
    await settle(r)
    const countIn = $(root(), '[data-testid="count-in"]')
    expect(countIn?.getAttribute('role')).toBe('status')
    expect(Number(countIn?.textContent)).toBeGreaterThan(0)
    // The count-in sits on the stage, never over the footer's hand toggles.
    expect(countIn?.closest('footer')).toBeNull()
    expect($(root(), '[data-testid="ready"]')).toBeNull()
    click(main())
    await settle(r, 1)
    expect($(root(), '[data-testid="count-in"]')).toBeNull()
    expect(label(main())).toBe('Start')
  })
})

describe('the hands', () => {
  it('one hand always stays on, and the notice says so', async () => {
    const r = await opened()
    click(hand('Left hand'))
    await settle(r, 1)
    expect(pressed()).toEqual([false, true])
    click(hand('Right hand'))
    await settle(r, 1)
    expect(pressed()).toEqual([false, true])
    expect(notices.value.map((n) => [n.kind, n.text])).toEqual([['info', 'At least one hand stays on.']])
    click(hand('Left hand'))
    await settle(r, 1)
    expect(pressed()).toEqual([true, true])
  })

  it('their tooltips say what they mean in the mode', async () => {
    const r = await opened({ micSupported: () => true })
    click(hand('Left hand'))
    await settle(r, 1)
    const titles = () => [hand('Left hand').title, hand('Right hand').title]
    expect(titles()).toEqual(['Left hand: the piano plays it', 'Right hand: you play it'])
    await setMode(r, 'Keep time')
    expect(titles()).toEqual(['Left hand: the piano plays it', 'Right hand: you play it'])
    await setMode(r, 'Follow')
    expect(titles()).toEqual(['Left hand: the piano plays it', 'Right hand: you play it'])
    act(() => {
      connectionStatus.value = { state: 'disconnected' }
    })
    await settle(r, 1)
    expect(titles()).toEqual(['Left hand: silent', 'Right hand: you play it'])
    await setMode(r, 'Listen')
    expect(titles()).toEqual(['Left hand: silent', 'Right hand: you hear it'])
  })

  it('are the piece’s in every mode, Listen too', async () => {
    const r = await opened({}, { mode: 'listen' })
    click(hand('Right hand'))
    await settle(r)
    expect((await r.storage.getPiece(r.pieceId))?.lastHands).toBe('left')
    await setMode(r, 'Wait')
    expect(pressed()).toEqual([true, false])
  })
})

describe('without a piano', () => {
  const note = () => $(root(), '[role="note"]')
  const connect = () => byText(root(), 'Connect piano')

  it('Wait and Keep time stay chosen with their hands, and say why they cannot start', async () => {
    connectionStatus.value = { state: 'disconnected' }
    updateSettings({ route: { inputId: 'in-1' } })
    const r = await opened()
    expect(pressed()).toEqual([true, true])
    expect((main() as HTMLButtonElement).disabled).toBe(true)
    expect(note()?.textContent).toContain('Wait needs a connected piano.')
    // Under the cluster, in the footer.
    expect(note()?.closest('footer')).not.toBeNull()
    click(hand('Left hand'))
    await settle(r, 1)
    expect(pressed()).toEqual([false, true])
    click(hand('Left hand'))
    await setMode(r, 'Keep time')
    expect(note()?.textContent).toContain('Keep time needs a connected piano.')
    click(connect())
    expect(connectionOpen.value).toBe(true)
    // The piano comes: nothing else changes.
    act(() => {
      settingsOpen.value = false
      connectionStatus.value = { state: 'connected', inputName: 'Piano' }
    })
    await settle(r, 1)
    expect([screen().dataset['mode'], note()]).toEqual(['time', null])
    expect((main() as HTMLButtonElement).disabled).toBe(false)
  })

  it('Follow asks for a piano only where there is no microphone; Listen never does', async () => {
    connectionStatus.value = { state: 'disconnected' }
    const r = await opened({}, { mode: 'follow' })
    expect(note()?.textContent).toContain('Follow needs a connected piano or a microphone.')
    expect(connect()).not.toBeNull()
    await setMode(r, 'Listen')
    expect([note(), (main() as HTMLButtonElement).disabled]).toEqual([null, false])
    view!.unmount()
    const mic = await opened({ micSupported: () => true }, { mode: 'follow' })
    expect([note(), connect()]).toEqual([null, null])
    expect((main() as HTMLButtonElement).disabled).toBe(false)
    // One hand through the microphone: the reason is not about a piano.
    await setMode(mic, 'Wait')
    expect(connect()).not.toBeNull()
  })

  it('unplugged while it is open, the banner is the only message, and only where it matters (U71)', async () => {
    const r = await opened()
    act(() => {
      r.midi.route({ kind: 'input-disconnected', port: { id: 'in-1' } as never })
      connectionStatus.value = { state: 'disconnected' }
      r.frames.flush()
    })
    await settle(r, 1)
    const banner = () => $(root(), '[data-testid="input-disconnected"]')
    expect([banner() !== null, note()]).toEqual([true, null])
    // Listen does not need it.
    await setMode(r, 'Listen')
    expect([banner(), note()]).toEqual([null, null])
    expect((main() as HTMLButtonElement).disabled).toBe(false)
    await setMode(r, 'Follow')
    expect([banner() !== null, note()]).toEqual([true, null])
    await setMode(r, 'Wait')
    expect(banner()).not.toBeNull()
    act(() => {
      r.midi.route({ kind: 'input-reconnected', port: { id: 'in-1' } as never })
      connectionStatus.value = { state: 'connected', inputName: 'Piano' }
    })
    await settle(r, 1)
    expect([banner(), note(), pressed()]).toEqual([null, null, [true, true]])
    expect((main() as HTMLButtonElement).disabled).toBe(false)
  })

  it('Follow over the microphone shows no disconnect banner', async () => {
    const r = await opened({ micSupported: () => true }, { mode: 'follow' })
    act(() => {
      r.midi.route({ kind: 'input-disconnected', port: { id: 'in-1' } as never })
      connectionStatus.value = { state: 'disconnected' }
      r.frames.flush()
    })
    await settle(r, 1)
    expect($(root(), '[data-testid="input-disconnected"]')).toBeNull()
    expect((main() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('opening', () => {
  it('with no piano known a piece opens in Listen; a stored mode wins; opening saves neither', async () => {
    connectionStatus.value = { state: 'disconnected' }
    const r = await opened()
    expect(screen().dataset['mode']).toBe('listen')
    view!.unmount()
    expect((await r.storage.getPiece(r.pieceId))?.mode).toBeUndefined()
    await r.storage.updatePiece(r.pieceId, { mode: 'wait' })
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect(screen().dataset['mode']).toBe('wait')
    view.unmount()
    // A browser without Web MIDI opens it as Listen, and keeps what is stored.
    connectionStatus.value = { state: 'unsupported' }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect(screen().dataset['mode']).toBe('listen')
    expect((await r.storage.getPiece(r.pieceId))?.mode).toBe('wait')
  })

  it('a request for Listen (an old study link) opens in it and leaves the piece’s own mode', async () => {
    const r = await opened({}, { mode: 'time' }, { mode: 'listen' })
    expect(screen().dataset['mode']).toBe('listen')
    click(main())
    await settle(r, 3)
    click(main())
    await settle(r)
    expect((await r.storage.getPiece(r.pieceId))?.mode).toBe('time')
    // A mode the learner then chooses is the piece's.
    await setMode(r, 'Follow')
    await settle(r)
    expect((await r.storage.getPiece(r.pieceId))?.mode).toBe('follow')
  })

  it('the same piece asked for in Listen while it is open opens again in it', async () => {
    const r = await opened()
    expect(screen().dataset['mode']).toBe('wait')
    act(() => {
      practiceRequest.value = { pieceId: r.pieceId, mode: 'listen' }
    })
    await settle(r)
    expect(screen().dataset['mode']).toBe('listen')
  })
})

describe('Listen and Follow keep no practice', () => {
  it('Listen plays through the output, seeks and pauses, and never moves the saved position (U72)', async () => {
    const r = await opened({}, { mode: 'listen' })
    const queued = vi.spyOn(r.storage.history, 'queueAttempt')
    const strip = r.strips[0]!
    expect(strip.targets).toEqual([]) // nobody is expected to play
    click(main())
    await settle(r, 3)
    act(() => {
      r.clock.advance(1500)
      r.frames.flush()
    })
    expect(strip.cursor).toBeGreaterThan(0)
    click(main())
    await settle(r, 1)
    expect(label(main())).toBe('Play')
    const overview = byLabel(root(), 'Piece overview')
    press(overview, 'End')
    act(() => r.frames.flush())
    expect(overview?.getAttribute('aria-valuenow')).toBe('2')
    press(overview, 'Home')
    act(() => r.frames.flush())
    expect(strip.cursor).toBe(0)
    view!.unmount()
    view = null
    await act(async () => void (await new Promise((res) => setTimeout(res, 0))))
    const piece = (await r.storage.getPiece(r.pieceId))!
    expect(piece.resume).toBeNull()
    expect(queued).not.toHaveBeenCalled()
  })

  it('Follow moves with the playing, with no Repeat and nothing saved', async () => {
    const r = await opened({}, { mode: 'follow' })
    const queued = vi.spyOn(r.storage.history, 'queueAttempt')
    const strip = r.strips[0]!
    expect(strip.cursorAction).toBe(false)
    click(main())
    await settle(r, 2)
    tap(r, 60, 48)
    await settle(r, 2)
    act(() => {
      r.clock.advance(400)
      r.frames.flush()
    })
    expect(strip.cursor).toBeGreaterThan(0)
    click(main())
    await settle(r, 1)
    expect(label(main())).toBe('Resume')
    view!.unmount()
    view = null
    await act(async () => void (await new Promise((res) => setTimeout(res, 0))))
    expect((await r.storage.getPiece(r.pieceId))?.resume).toBeNull()
    expect(queued).not.toHaveBeenCalled()
  })

  it('Follow through the microphone hears the chosen hand, and leaving it closes the microphone', async () => {
    connectionStatus.value = { state: 'disconnected' }
    const dispose = vi.fn()
    const createMicFollower = vi.fn<NonNullable<PracticeEnv['createMicFollower']>>(() => ({
      start: async () => undefined,
      reset: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      dispose,
    }))
    const r = await opened({ micSupported: () => true, createMicFollower }, { mode: 'follow' })
    click(hand('Right hand'))
    await settle(r, 1)
    expect(createMicFollower, 'never before Start').not.toHaveBeenCalled()
    click(main())
    await settle(r)
    expect(createMicFollower.mock.calls[0]?.[3]).toBe('left')
    expect(label(main())).toBe('Pause')
    await setMode(r, 'Listen')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(label(main())).toBe('Play')
  })
})

describe('the footer menu', () => {
  const menu = () => byLabel(root(), 'Practice menu')
  const openMenu = () => click(byLabel($(root(), 'footer')!, 'Menu'))
  const rows = () =>
    [...menu()!.children].map(
      (row) =>
        row.textContent?.trim().match(/^(Note names|Playback|Metronome|Show keys|Progress|Record performance)/)?.[0],
    )

  it('holds the mode’s rows in order, and no badge', async () => {
    const r = await opened({ micSupported: () => true })
    const expected: Readonly<Record<string, string[]>> = {
      Listen: ['Note names', 'Metronome', 'Show keys', 'Progress', 'Record performance'],
      Wait: ['Note names', 'Metronome', 'Show keys', 'Progress', 'Record performance'],
      'Keep time': ['Note names', 'Playback', 'Metronome', 'Show keys', 'Progress', 'Record performance'],
      Follow: ['Note names', 'Metronome', 'Show keys', 'Progress', 'Record performance'],
    }
    for (const [name, list] of Object.entries(expected)) {
      await setMode(r, name)
      openMenu()
      expect(rows(), name).toEqual(list)
      press(menu()!, 'Escape')
      await settle(r, 1)
    }
    expect($(root(), '[data-testid="keep-time-badge"]')).toBeNull()
  })

  it('Progress pauses what plays, and Practice these bars opens Repeat over them in Wait, paused (U148)', async () => {
    const r = await opened({}, { mode: 'listen' })
    const piece = (await r.storage.getPiece(r.pieceId))!
    for (let k = 0; k < 3; k++)
      r.storage.history.queueAttempt(
        attemptFor(piece.id, [[1, 'error']], {
          context: comparisonContext({ scoreVersionId: piece.scoreVersionId, hands: 'right', multiplier: 0.5 }),
        }),
      )
    currentView.value = 'practice'
    click(main())
    await settle(r, 3)
    expect(label(main())).toBe('Pause')
    openMenu()
    click(byLabel(menu()!, 'Progress'))
    await vi.waitFor(async () => {
      await settle(r, 1)
      expect($(dialog()!, '[data-suggestion]')).not.toBeNull()
    })
    expect(dialog()!.getAttribute('aria-label')).toBe('Progress')
    expect(byLabel($(root(), 'footer')!, 'Menu')!.getAttribute('aria-expanded')).toBe('false')
    expect(label(main())).toBe('Play')

    click(byText($(dialog()!, '[data-suggestion]')!, 'Practice these bars', 'button span')?.closest('button'))
    await settle(r)
    expect(currentView.value).toBe('practice')
    expect(screen().dataset['mode']).toBe('wait')
    expect(label(main())).toBe('Start')
    expect(pressed()).toEqual([false, true])
    expect(await r.storage.getPiece(r.pieceId)).toMatchObject({ mode: 'wait', repeatOpen: true, lastMultiplier: 0.5 })
  })

  it('opened while Listen plays it stays, and closes when the chrome recedes elsewhere', async () => {
    const r = await opened({}, { mode: 'listen' })
    openMenu()
    const menuButton = byLabel($(root(), 'footer')!, 'Menu')!
    click(main())
    await settle(r, 3)
    expect(label(main())).toBe('Pause')
    expect(menuButton.getAttribute('aria-expanded')).toBe('true')
    click(main())
    await settle(r, 1)
    press(menu()!, 'Escape')
    await setMode(r, 'Wait')
    openMenu()
    click(main())
    await settle(r)
    expect(menuButton.getAttribute('aria-expanded')).toBe('false')
  })

  it('in Follow the microphone silences the metronome and says so', async () => {
    connectionStatus.value = { state: 'disconnected' }
    await opened({ micSupported: () => true }, { mode: 'follow' })
    openMenu()
    const row = $$(menu()!, 'label').find((el) => el.textContent?.startsWith('Metronome'))!
    expect(row.textContent).toContain('Silent while the microphone follows.')
    expect(row.querySelector<HTMLInputElement>('input')!.disabled).toBe(true)
  })
})

describe('on a phone', () => {
  const bar = () => $(root(), '[data-testid="practice-bar"]')!
  const modeButton = (name: string) => byLabel(bar(), `Mode: ${name}. Change`)

  it('upright, the title is the mode button, with the mode in the composer’s place', async () => {
    restoreScreen = onScreen('phone')
    const r = await opened()
    expect($(bar(), 'h1')?.textContent).toBe('Two Hands')
    const button = modeButton('Wait')!
    expect(button.textContent).toBe('Two HandsWait')
    expect(root().textContent).not.toContain('Pianissimo fixtures')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    click(button)
    await settle(r, 1)
    const sheet = dialog()!
    expect(sheet.getAttribute('aria-label')).toBe('Mode')
    // Untitled, as the phone menu (U81): the close button alone.
    expect($(sheet, 'h2')).toBeNull()
    const radios = $$(sheet, '[role="radio"]')
    expect(radios.map((el) => el.textContent)).toEqual([
      'ListenThe app plays it for you.',
      'WaitThe score waits until you play the right notes.',
      'Keep timeThe score keeps going, whatever you play.',
      'FollowThe score follows your playing. Nothing is graded.',
    ])
    expect(radios.map((el) => el.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    // Arrow keys move the focus only. A choice closes the sheet.
    radios[1]!.focus()
    press(radios[1], 'ArrowDown')
    expect(document.activeElement).toBe(radios[2])
    expect(screen().dataset['mode']).toBe('wait')
    click(radios[2])
    await settle(r, 1)
    expect(screen().dataset['mode']).toBe('time')
    expect(modeButton('Keep time')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('on its side, the mode button is between the overview and the hands', async () => {
    restoreScreen = onScreen('phone-sideways')
    const r = await opened({}, { mode: 'follow' })
    const order = [byLabel(bar(), 'Piece overview'), modeButton('Follow'), hand('Left hand')]
    for (const [a, b] of [
      [order[0], order[1]],
      [order[1], order[2]],
    ])
      expect(a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    click(modeButton('Follow'))
    await settle(r, 1)
    click($$(dialog()!, '[role="radio"]')[0])
    await settle(r, 1)
    expect(screen().dataset['mode']).toBe('listen')
  })

  it('why it cannot start is a pill over the score, with Connect piano', async () => {
    restoreScreen = onScreen('phone')
    connectionStatus.value = { state: 'disconnected' }
    await opened({}, { mode: 'wait' })
    const note = $(root(), '[role="note"]')!
    expect(note.closest('[data-repeat-bounds]')).not.toBeNull()
    expect(note.textContent).toContain('Wait needs a connected piano.')
    click(byText(note, 'Connect piano'))
    expect(connectionOpen.value).toBe(true)
  })

  it.each(['phone', 'phone-sideways'] as const)('%s: the bar stays while Listen plays', async (kind) => {
    restoreScreen = onScreen(kind)
    const r = await opened({}, { mode: 'listen' })
    click(byLabel(bar(), 'Play'))
    await settle(r, 3)
    act(() => r.clock.advance(RECEDE_DELAY_MS))
    await settle(r, 1)
    expect(byLabel(bar(), 'Pause')).not.toBeNull()
    expect(screen().dataset['recede']).toBeUndefined()
    expect(bar().inert).toBe(false)
    // A tap on the score seeks, since it brings nothing back (U93).
    act(() => {
      $(root(), '[data-repeat-bounds]')!.dispatchEvent(
        Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'touch', clientX: 9999 }),
      )
    })
    act(() => r.strips.at(-1)!.options.onSeekRequest?.(1))
    act(() => r.frames.flush())
    expect(r.strips.at(-1)!.cursor).toBeGreaterThan(0)
  })

  it('Settings and Back work from the bar and its menu', async () => {
    restoreScreen = onScreen('phone')
    const r = await opened({}, { mode: 'listen' })
    click(byLabel(bar(), 'Menu'))
    await settle(r, 1)
    expect(dialog()!.textContent).toContain('Show keys')
    click(byLabel(dialog()!, 'Settings'))
    expect(settingsOpen.value).toBe(true)
    click(byLabel(bar(), 'Back to Library'))
    expect(currentView.value).toBe('library')
  })
})

describe('translation coverage', () => {
  // The piece title, the composer, note names and the port's name are literal data.
  const literal = ['Two Hands', 'Pianissimo fixtures', 'Test piano', /\b[A-G][♯♭]?-?\d\b/u]

  it.each([...MODES])('%s shows no text that bypasses the catalogs', async (mode) => {
    const restore = usePseudoCatalog()
    try {
      await opened({ micSupported: () => true }, { mode })
      expect(untranslatedText(root(), literal)).toEqual([])
      click(byLabel($(root(), 'footer')!, msg('Menu')))
      expect(untranslatedText(document.body, literal)).toEqual([])
    } finally {
      restore()
    }
  })

  it.each(['phone', 'phone-sideways'] as const)('%s and its mode sheet, without a piano', async (kind) => {
    const restore = usePseudoCatalog()
    try {
      restoreScreen = onScreen(kind)
      connectionStatus.value = { state: 'disconnected' }
      const r = await opened({}, { mode: 'wait' })
      expect($(root(), '[role="note"] button')).not.toBeNull()
      click($(bar(), '[aria-haspopup="dialog"]'))
      await settle(r, 1)
      expect(dialog()).not.toBeNull()
      expect(untranslatedText(document.body, literal)).toEqual([])
    } finally {
      restore()
    }
  })

  const bar = () => $(root(), '[data-testid="practice-bar"]')!
})

describe('where the other hand sounds (U149)', () => {
  const unverified = () => updateSettings({ route: { outputVerified: false, echo: 'untested' } })
  const result = (verdict: 'none' | 'echo-detected') => ({
    verdict,
    returned: verdict === 'none' ? 0 : 3,
    exactMatch: false,
    latencyMs: null,
    otherInput: false,
  })
  async function asked(env: Partial<PracticeEnv>): Promise<Rig> {
    unverified()
    const r = await opened(env, { mode: 'wait' })
    click(hand('Left hand'))
    await settle(r, 1)
    expect((main() as HTMLButtonElement).disabled).toBe(false)
    expect($(root(), '[role="note"]')).toBeNull()
    click(main())
    await settle(r, 1)
    expect(dialog()!.getAttribute('aria-label')).toBe('Where should the left hand sound?')
    expect(label(main())).toBe('Start')
    return r
  }
  const press = async (r: Rig, text: string) => {
    click(byLabel(dialog()!, text))
    await settle(r, 2)
  }

  it('asks at the first one-hand Start, and starts on the piano after Yes', async () => {
    const r = await asked({ testNotes: async () => (updateSettings({ route: { echo: 'none' } }), result('none')) })
    expect(byLabel(dialog()!, 'On this device')).toBeNull()
    await press(r, 'On the piano')
    expect(dialog()!.textContent).toContain('Did the piano play three short notes?')
    expect(label(main())).toBe('Start')
    await press(r, 'No')
    expect(dialog()!.textContent).toContain('Check that the piano is on')
    await press(r, 'Try again')
    await press(r, 'Yes')
    expect(settings.value.route).toMatchObject({ outputVerified: true, echo: 'none' })
    expect(label(main())).toBe('Pause')
  })

  it('an echo leaves this device, which starts at once and says so', async () => {
    const backend = Object.assign(new RecordingBackend(() => 0), { monitor: () => undefined, dispose: () => undefined })
    const r = await asked({
      hasWebAudio: () => true,
      loadBrowserAudio: async () => ({ createBrowserAudio: () => backend }) as unknown as BrowserAudioModule,
      testNotes: async () => (updateSettings({ route: { echo: 'echo-detected' } }), result('echo-detected')),
    })
    await press(r, 'On the piano')
    expect(dialog()!.textContent).toContain('cannot tell your hand from its own')
    expect(byLabel(dialog()!, 'Try again')).toBeNull()
    await press(r, 'On this device')
    await settle(r)
    expect(settings.value.sound.destination).toBe('browser')
    expect(label(main())).toBe('Pause')
    expect(notices.value.map((n) => n.text)).toContain(
      'The app’s sound now comes from this device. You can change it in Settings.',
    )
  })

  it('Cancel starts nothing; More help opens the piano setup', async () => {
    const r = await asked({ testNotes: async () => null })
    await press(r, 'Cancel')
    expect(label(main())).toBe('Start')
    click(main())
    await settle(r, 1)
    await press(r, 'On the piano')
    await press(r, 'More help')
    expect(connectionOpen.value).toBe(true)
    expect(label(main())).toBe('Start')
  })
})
