// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'preact/test-utils'
import { connectionOpen, currentView, practiceRequest, resultsRequest, settingsOpen } from '../../app/navigation'
import { connectionStatus, notices, resetAppStateForTests, settings } from '../../app/state'
import { FakeMidi, FakeStrip, ManualFrames } from '../../app/session/testkit'
import { newPieceRecord } from '../../core/storage/records'
import { openFresh } from '../../core/storage/testkit'
import type { PianissimoStorage } from '../../core/storage'
import type { PreparedLayout } from '../../render'
import { ManualClock } from '../../core/playback/testkit'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { $, $$, byLabel, byText, click, mount, press, type Mounted } from '../shared/testing'
import type { PracticeEnv, PracticeStripOptions, StripHandle } from './env'
import type { RespaceSnapshot } from '../../render'
import { PREPARE_AHEAD_MS, REPEAT_PANEL_FADE_MS } from './PracticeScreen'
import { PracticeViewWith } from './PracticeView'
import { RECEDE_DELAY_MS, REVEAL_MS } from './recede'

class TestStrip extends FakeStrip implements StripHandle {
  destroyed = false
  options: PracticeStripOptions = {}
  browsing = false
  browsedOcc = 0
  override isBrowsing(): boolean {
    return this.browsing
  }
  occAt(): number {
    return this.browsedOcc
  }
  returned = 0
  setZoom(): void {}
  returnToCurrent(): void {
    this.returned++
    this.browsing = false
  }
  destroy(): void {
    this.destroyed = true
  }
  held: boolean[] = []
  holdLabels(on: boolean): void {
    this.held.push(on)
  }
  readonly snapshot = { from: this } as unknown as RespaceSnapshot
  respaceSnapshot(): RespaceSnapshot | null {
    return this.snapshot
  }
  respacedFrom: (RespaceSnapshot | null)[] = []
  respacing = Promise.resolve()
  whenRespaced(): Promise<void> {
    return this.respacing
  }
  respaceFrom(prev: RespaceSnapshot | null): void {
    this.respacedFrom.push(prev)
  }
}

interface Rig {
  env: PracticeEnv
  storage: PianissimoStorage
  clock: ManualClock
  frames: ManualFrames
  midi: FakeMidi
  strips: TestStrip[]
  /** The label room of every preparation, in order. */
  rooms: (string | undefined)[]
  pieceId: string
}

async function rig(): Promise<Rig> {
  const storage = await openFresh()
  const built = await importFixture('two-hands.musicxml')
  const piece = newPieceRecord(built.package, { id: 'piece-1', now: 1 })
  await storage.commitImport({ source: built.source, pkg: built.package, piece })
  const clock = new ManualClock()
  clock.now = 1000
  const frames = new ManualFrames(clock.clock)
  const midi = new FakeMidi()
  const strips: TestStrip[] = []
  const rooms: (string | undefined)[] = []
  const env: PracticeEnv = {
    storage: async () => storage,
    midi: () => midi,
    clock: clock.clock,
    timers: clock,
    frames,
    timeOrigin: 0,
    prepare: async (_s, _i, options) => {
      rooms.push(options.labels.room)
      return { key: 'fake' } as unknown as PreparedLayout
    },
    createStrip: (_host, _layout, options) => {
      const s = new TestStrip()
      s.options = options
      strips.push(s)
      return s
    },
  }
  return { env, storage, clock, frames, midi, strips, rooms, pieceId: piece.id }
}

/** Wait out the Repeat panel's fade-out (real timers), then settle. */
async function faded(): Promise<void> {
  await act(async () => {
    await new Promise((res) => setTimeout(res, REPEAT_PANEL_FADE_MS + 60))
  })
}

/** Let promises (storage, preparation) settle, then run a frame. */
async function settle(r: Rig, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0))
    })
  }
  act(() => r.frames.flush())
}

function tap(r: Rig, ...notes: number[]): void {
  act(() => {
    for (const n of notes) {
      r.midi.on(n, r.clock.now)
      r.midi.off(n, r.clock.now)
    }
    r.frames.flush()
  })
}

/** Opens the footer menu (U76) if it is closed and returns its panel. */
function openMenu(root: HTMLElement): HTMLElement {
  const button = byLabel($(root, 'footer')!, 'Menu')!
  if (button.getAttribute('aria-expanded') !== 'true') click(button)
  return byLabel(root, 'Practice menu')!
}

/** Chooses a Note names option from the footer menu. */
function pickLabels(root: HTMLElement, label: string): void {
  click($$(openMenu(root), '[role="radio"]').find((el) => el.textContent === label))
}

/** A switch in the footer menu, by its label (Play through, Show keys). */
function menuSwitch(root: HTMLElement, name: string): HTMLInputElement {
  const row = $$(openMenu(root), 'label').find((el) => el.textContent?.trim() === name)!
  return row.querySelector<HTMLInputElement>('input[role="switch"]')!
}

/** The Play through switch in the footer menu. */
function playThroughSwitch(root: HTMLElement): HTMLInputElement {
  return menuSwitch(root, 'Play through')
}

let view: Mounted | null = null

beforeEach(() => {
  resetAppStateForTests()
  // A piano is connected unless a test says otherwise: without one the hands are unavailable (U27).
  connectionStatus.value = { state: 'connected', inputName: 'Test piano' }
  practiceRequest.value = null
  resultsRequest.value = null
  settingsOpen.value = false
  connectionOpen.value = false
})

afterEach(() => {
  view?.unmount()
  view = null
})

describe('PracticeView', () => {
  it('without a request shows an empty state that leads back to the Library and lists recent pieces', async () => {
    const r = await rig()
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect(view.container.textContent).toContain('Choose a piece to practice')
    click(byText(view.container, 'Back to Library'))
    expect(currentView.value).toBe('library')
    click(byText(view.container, 'Two Hands'))
    expect(practiceRequest.value).toEqual({ pieceId: 'piece-1' })
  })

  it('opens the piece, mounts the strip and follows the learner in ordinary reading', async () => {
    const r = await rig()
    let prepared!: () => void
    const preparing = new Promise<void>((resolve) => (prepared = resolve))
    const env: PracticeEnv = {
      ...r.env,
      prepare: async (...args) => {
        args[2].onProgress?.('engraving', 0.4)
        await preparing
        return r.env.prepare(...args)
      },
    }
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={env} />)
    await settle(r)
    expect($(view.container, '[data-testid="score-skeleton"]')?.textContent).toContain('Preparing the score… 40%')
    expect(r.strips).toHaveLength(0)
    prepared()
    await settle(r)
    expect($(view.container, '[data-testid="score-skeleton"]')).toBeNull()
    expect($(view.container, 'h1')?.textContent).toBe('Two Hands')
    expect(r.strips).toHaveLength(1)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    expect($(view.container, '[data-activity]')?.dataset['activity']).toBe('reading')
    const strip = r.strips[0]!
    expect(strip.targets.length).toBe(2)
    tap(r, 60, 48)
    expect(strip.targets.length).toBe(1)
    act(() => {
      r.midi.on(70, r.clock.now)
      r.frames.flush()
    })
    await settle(r, 2)
    expect(view.container.textContent).not.toContain('Wrong key')
    expect($(view.container, '[data-testid="stage-cue"]')).toBeNull()
  })

  it('Add to library starts once the score is prepared and consumes the request', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId, autoStart: true }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect($(view.container, '[data-activity]')?.dataset['activity']).toBe('reading')
    expect(byLabel(view.container, 'Pause')).not.toBeNull()
    expect(practiceRequest.value).toEqual({ pieceId: r.pieceId })
    click(byLabel(view.container, 'Pause'))
    await settle(r)
    expect(byLabel(view.container, 'Resume')).not.toBeNull()
  })

  it('shows only an arrow at the cursor for a correct pitch class in the wrong octave', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    tap(r, 36)
    await settle(r, 1)
    let cue = $(view.container, '[data-testid="stage-cue"]')
    expect(cue?.dataset['kind']).toBe('octave')
    expect(cue?.dataset['direction']).toBe('up')
    expect(cue?.getAttribute('aria-label')).toBe('Play an octave higher')
    expect(cue?.textContent).toBe('')
    // Inside the stage, next to the cursor line.
    expect(cue?.closest('[data-testid="strip-host"]')).toBeNull()
    expect(cue?.parentElement?.contains($(view.container, '[data-testid="strip-host"]'))).toBe(true)
    tap(r, 72)
    await settle(r, 1)
    cue = $(view.container, '[data-testid="stage-cue"]')
    expect(cue?.dataset['direction']).toBe('down')
    expect(cue?.textContent).toBe('')
    tap(r, 70)
    await settle(r, 1)
    expect($(view.container, '[data-testid="stage-cue"]')).toBeNull()
    expect(view.container.textContent).not.toContain('Wrong key')
    expect(view.container.textContent).not.toContain('Too early')
  })

  it('names the target with its accidental emphasized for a key a semitone off on the same letter', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    tap(r, 49) // C♯3 / D♭3 for C3
    await settle(r, 1)
    const cue = $(view.container, '[data-testid="stage-cue"]')
    expect(cue?.dataset['kind']).toBe('accidental')
    expect(cue?.textContent).toBe('C♮3')
    expect(cue?.querySelector('strong')?.textContent).toBe('♮')
    expect(cue?.getAttribute('aria-label')).toBe('Play C natural 3 instead')
    tap(r, 48)
    await settle(r, 1)
    expect($(view.container, '[data-testid="stage-cue"]')).toBeNull()
  })

  it('keeps practicing when the document becomes hidden', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await settle(r)
      expect(byLabel(view.container, 'Pause')).not.toBeNull()
      expect(view.container.textContent).not.toContain('background')
      tap(r, 60, 48)
      act(() => r.clock.advance(1000))
      tap(r, 62)
      expect(r.strips[0]!.targets).toHaveLength(1)
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    }
  })

  it('a preset passage is preselected (never started); a scored attempt shows its result and links to Results', async () => {
    const r = await rig()
    practiceRequest.value = {
      pieceId: r.pieceId,
      preset: { passage: { fromOcc: 0, toOcc: 0 }, hands: 'both', multiplier: 1 },
    }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect($(view.container, '[data-activity]')?.dataset['activity']).toBe('idle')
    // "Practice this passage" opens Repeat mode with that loop (U10).
    expect($(view.container, '[data-testid="repeat-controls"]')).not.toBeNull()
    expect(byLabel(view.container, 'Loop start')?.textContent).toContain('Bar 1')
    expect(byLabel(view.container, 'Loop end')?.textContent).toContain('Bar 1')
    click(byLabel(view.container, 'Start'))
    await settle(r)
    expect($(view.container, '[data-testid="ready"]')).not.toBeNull()
    tap(r, 60, 48)
    r.clock.advance(1000)
    tap(r, 62)
    r.clock.advance(1000)
    tap(r, 64)
    r.clock.advance(1000)
    tap(r, 65)
    await settle(r, 2)
    const card = $(view.container, '[data-testid="attempt-result"]')
    expect(card?.dataset['passed']).toBe('true')
    expect(card?.textContent).toContain('No wrong notes')
    expect(card?.textContent).toContain('3.0 s')
    click(byText(card!, 'Details'))
    expect(resultsRequest.value?.pieceId).toBe(r.pieceId)
    expect(resultsRequest.value?.attemptId).toMatch(/piece-1/)
  })

  it('prepares the other label room ahead while idle, never while something plays', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect(r.rooms).toEqual(['hints'])
    // Something plays before the idle delay is up: nothing is prepared meanwhile.
    click(byLabel(view.container, 'Start')!)
    await settle(r, 2)
    act(() => r.clock.advance(PREPARE_AHEAD_MS * 2))
    await settle(r, 2)
    expect(r.rooms).toEqual(['hints'])
    click(byLabel(view.container, 'Pause')!)
    await settle(r, 2)
    act(() => r.clock.advance(PREPARE_AHEAD_MS - 1))
    await settle(r, 2)
    expect(r.rooms).toEqual(['hints'])
    act(() => r.clock.advance(1))
    await settle(r, 2)
    // The roomy engraving is ready (in memory) before Labels All is chosen; the view stays.
    expect(r.rooms).toEqual(['hints', 'all'])
    expect(r.strips).toHaveLength(1)
    // Once the room has changed, the tight one is already known: nothing more to prepare.
    pickLabels(view.container, 'All')
    await settle(r, 2)
    expect(r.strips).toHaveLength(2)
    act(() => r.clock.advance(PREPARE_AHEAD_MS * 2))
    await settle(r, 2)
    expect(r.rooms.filter((room) => room === 'hints')).toHaveLength(1)
  })

  it('Labels Off swaps to the tight engraving at once; the names fade during the glide (R3 revised)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    pickLabels(view.container, 'All')
    await settle(r, 2)
    expect(r.strips).toHaveLength(2)
    pickLabels(view.container, 'Off')
    await settle(r, 2)
    // No wait for a fade: the old view hands over as soon as the layout is ready.
    expect(r.rooms).toEqual(['hints', 'all', 'hints'])
    expect(r.strips).toHaveLength(3)
    expect(r.strips[1]!.destroyed).toBe(true)
    expect(r.strips[2]!.respacedFrom).toEqual([r.strips[1]!.snapshot])
    // Conditional ↔ All keeps the room: no new engraving.
    pickLabels(view.container, 'All')
    await settle(r, 2)
    pickLabels(view.container, 'Conditional')
    await settle(r, 2)
    expect(r.rooms).toEqual(['hints', 'all', 'hints', 'all'])
  })

  it('coalesces rapid label reversals until the visible spacing glide finishes', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    const select = (label: string) => pickLabels(view!.container, label)
    select('All')
    await settle(r)
    const gliding = r.strips[1]!
    let finish!: () => void
    gliding.respacing = new Promise<void>((resolve) => (finish = resolve))
    select('Off')
    await settle(r)
    expect(gliding.destroyed).toBe(false)
    expect(r.strips).toHaveLength(2)
    // Returning to the roomy layout supersedes the pending Off replacement.
    select('Conditional')
    await settle(r)
    finish()
    await settle(r)
    expect(gliding.destroyed).toBe(false)
    expect(r.strips).toHaveLength(2)
    select('Off')
    await settle(r)
    expect(gliding.destroyed).toBe(true)
    expect(r.strips).toHaveLength(3)
    expect(byLabel(view.container, 'Pause')).not.toBeNull()
  })

  it('the Labels control applies label settings; both hands off turns Start into Listen', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect(r.rooms).toEqual(['hints'])
    pickLabels(view.container, 'All')
    expect(settings.value.labels.mode).toBe('all')
    // Names need room (R3 revised): the tight view hides its labels while the roomy engraving is
    // prepared, then gives way to it, which glides in from the old view's snapshot.
    expect(r.strips[0]!.held).toEqual([true])
    await settle(r, 2)
    expect(r.rooms).toEqual(['hints', 'all'])
    expect(r.strips).toHaveLength(2)
    expect(r.strips[0]!.destroyed).toBe(true)
    expect(r.strips[1]!.respacedFrom).toEqual([r.strips[0]!.snapshot])
    act(() => r.clock.advance(400))
    act(() => r.frames.flush())
    expect(r.strips[1]!.opacity.size).toBeGreaterThan(0)
    click(byLabel(view.container, 'Left hand'))
    await settle(r, 1)
    click(byLabel(view.container, 'Right hand'))
    await settle(r, 1)
    // Both hands off is Listen mode (U9): the main button is Listen; there is no part filter (U12).
    expect(byLabel(view.container, 'Listen')).not.toBeNull()
    expect(byLabel(view.container, 'Hear')).toBeNull()
    // No separate footer Listen tool any more.
    expect($$(view.container, 'footer button').filter((b) => b.textContent?.trim() === 'Listen')).toHaveLength(0)
    click(byLabel(view.container, 'Right hand'))
    await settle(r, 1)
    expect(byLabel(view.container, 'Start')).not.toBeNull()
    expect($(view.container, '[data-activity]')?.dataset['activity']).toBe('idle')
  })

  it('loop controls appear only in Repeat mode: the cursor button opens it, the strip ✕ closes it (U17)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const strip = r.strips.at(-1)!
    // No footer Repeat: the cursor's repeat button is the way in.
    expect($$(view.container, 'footer button').some((b) => b.textContent?.trim() === 'Repeat')).toBe(false)
    expect($(view.container, '[data-testid="repeat-controls"]')).toBeNull()
    expect(byLabel(view.container, 'Loop start')).toBeNull()
    expect(strip.loopEditable).toBe(false)
    expect(strip.loop).toBeNull()
    expect(strip.cursorAction).toBe(true)

    act(() => strip.options.onCursorAction?.())
    await settle(r)
    const panel = $(view.container, '[data-testid="repeat-controls"]')!
    expect(byLabel(panel, 'Loop start')?.textContent).toContain('Bar 1')
    expect(byLabel(panel, 'Loop end')?.textContent).toContain('Bar 1')
    expect(panel.querySelector('label')?.textContent).toContain('Repeat until')
    // The overview row holds only the overview (U11): the steppers are not in it.
    const overview = byLabel(view.container, 'Piece overview')!.parentElement!
    expect(overview.contains(panel)).toBe(false)
    expect(strip.loop).toEqual({ fromOcc: 0, toOcc: 0 })
    expect(strip.loopEditable).toBe(true)
    click(byLabel(panel, 'Move loop end one bar later'))
    await settle(r)
    expect(strip.loop).toEqual({ fromOcc: 0, toOcc: 1 })

    // The strip's ✕ clears the loop and leaves Repeat mode; the panel fades out before it goes.
    act(() => strip.options.onLoopChange?.(null))
    await settle(r)
    expect($(view.container, '[data-testid="repeat-controls"]')?.hasAttribute('data-leaving')).toBe(true)
    await faded()
    expect(byLabel(view.container, 'Loop start')).toBeNull()
    expect(strip.loop).toBeNull()
    expect(strip.cursorAction).toBe(true)

    // The toolbar's icon clears the same passage and leaves Repeat mode too.
    act(() => strip.options.onCursorAction?.())
    await settle(r)
    const clear = byLabel(view.container, 'Clear loop')!
    expect(clear.textContent).toBe('')
    click(clear)
    await settle(r)
    expect($(view.container, '[data-testid="repeat-controls"]')?.hasAttribute('data-leaving')).toBe(true)
    await faded()
    expect(byLabel(view.container, 'Loop start')).toBeNull()
    expect(strip.loop).toBeNull()
    expect(strip.cursorAction).toBe(true)
  })

  it('the cursor button loops the bar the strip reports under its cursor line while browsing (U14)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const strip = r.strips.at(-1)!
    // The strip, browsed one bar ahead of the cursor, passes that bar with the press.
    act(() => strip.options.onCursorAction?.(1))
    await settle(r)
    const panel = $(view.container, '[data-testid="repeat-controls"]')!
    expect(byLabel(panel, 'Loop start')?.textContent).toContain('Bar 2')
    expect(byLabel(panel, 'Loop end')?.textContent).toContain('Bar 2')
    expect(strip.loop).toEqual({ fromOcc: 1, toOcc: 1 })
  })

  it('a position chosen on the overview ends browsing, so the cursor line shows it (U14)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const strip = r.strips.at(-1)!
    strip.browsing = true
    const overview = $(view.container, '[role="slider"][aria-label="Piece overview"]')!
    act(() => {
      overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await settle(r)
    expect(strip.returned).toBe(1)
    expect(strip.isBrowsing()).toBe(false)
    expect(overview.getAttribute('aria-valuetext')).toMatch(/^Bar 2 of 2/)
    expect(strip.cursor).toBeGreaterThanOrEqual(1)
  })

  it('has no passage bar; Settings is in the header, Speed in the footer, Labels in its menu (U12, U76)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    for (const gone of ['Select bars', 'Whole piece', 'Clear passage', 'Save passage'])
      expect(byText(view.container, gone)).toBeNull()
    expect($(view.container, '[data-testid="passage-summary"]')).toBeNull()
    const header = $(view.container, 'header')!
    const footer = $(view.container, 'footer')!
    expect(byLabel(footer, 'Settings')).toBeNull()
    click(byLabel(header, 'Settings'))
    expect(settingsOpen.value).toBe(true)
    expect(byLabel(header, 'Note names on the score')).toBeNull()
    expect(byLabel(footer, 'Note names on the score')).toBeNull() // inside the closed menu (U76)
    expect(byLabel(footer, 'Faster by 5 percent')).not.toBeNull() // Speed is always there
    openMenu(view.container)
    expect(byLabel(footer, 'Note names on the score')).not.toBeNull()
    expect(byLabel(header, 'Faster by 5 percent')).toBeNull()
    expect(byLabel(footer, 'Hint')).toBeNull()
    // No caption under the hand toggles.
    expect(footer.textContent).not.toMatch(/piano plays/u)
  })

  it('the cursor repeat button opens Repeat mode with a one-bar loop at the cursor bar (U14)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const strip = r.strips.at(-1)!
    expect(strip.cursorAction).toBe(true)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    tap(r, 60, 48)
    act(() => r.clock.advance(1000))
    tap(r, 62)
    act(() => r.clock.advance(1000))
    tap(r, 64)
    act(() => r.clock.advance(1000))
    tap(r, 65)
    act(() => r.clock.advance(1000))
    act(() => r.frames.flush()) // the cursor is in bar 2 now
    // Playing in focus mode (the chrome receded): the button is gone.
    expect($(view.container, '[data-activity]')?.dataset['recede']).toBe('true')
    expect(strip.cursorAction).toBe(false)
    click(byLabel(view.container, 'Pause'))
    await settle(r)
    expect(strip.cursorAction).toBe(true)
    act(() => strip.options.onCursorAction?.())
    await settle(r)
    expect(strip.loop).toEqual({ fromOcc: 1, toOcc: 1 })
    expect(byLabel(view.container, 'Loop start')?.textContent).toContain('Bar 2')
    // Never shown in Repeat mode: the loop band's ✕ leaves it.
    expect(strip.cursorAction).toBe(false)
    expect(view.container.textContent).not.toContain('Stop repeating')
  })

  it('while playing, the cursor button shows with the chrome; near the cursor or a tap reveals it (U14)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const strip = r.strips.at(-1)!
    const screen = () => $(view!.container, '[data-activity]')!
    const stage = $(view.container, '[data-testid="strip-host"]')!.parentElement!
    // happy-dom lays nothing out: the stage is 0 px wide, so its cursor line is at x = 0.
    const pointer = (type: string, clientX: number, pointerType = 'mouse') =>
      act(() => {
        const ev = new Event(type, { bubbles: true })
        Object.assign(ev, { clientX, pointerType })
        stage.dispatchEvent(ev)
      })
    click(byLabel(view.container, 'Start'))
    await settle(r)
    expect(strip.cursorAction).toBe(true) // the chrome is still revealed
    act(() => r.clock.advance(RECEDE_DELAY_MS))
    await settle(r, 1)
    expect(screen().dataset['recede']).toBe('true')
    expect(strip.cursorAction).toBe(false)
    // A mouse far from the cursor line does nothing; near it, the chrome and the button return.
    pointer('pointermove', 200)
    await settle(r, 1)
    expect(screen().dataset['recede']).toBe('true')
    pointer('pointermove', 40)
    await settle(r, 1)
    expect(screen().dataset['recede']).toBeUndefined()
    expect(strip.cursorAction).toBe(true)
    act(() => r.clock.advance(REVEAL_MS))
    await settle(r, 1)
    expect(strip.cursorAction).toBe(false)
    // A tap anywhere on the stage leaves focus mode.
    pointer('pointerdown', 500, 'touch')
    await settle(r, 1)
    expect(screen().dataset['recede']).toBeUndefined()
    expect(strip.cursorAction).toBe(true)
    // Pressed while playing: pause, then Repeat mode with a one-bar loop at the cursor's bar.
    act(() => strip.options.onCursorAction?.())
    await settle(r)
    expect(byLabel(view.container, 'Pause')).toBeNull()
    expect(strip.loop).toEqual({ fromOcc: 0, toOcc: 0 })
    expect(strip.cursorAction).toBe(false)
  })

  it('without a connected piano the hands are off and unavailable, a tap explains, and they return with the piano (U27)', async () => {
    connectionStatus.value = { state: 'disconnected' }
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const left = byLabel(view.container, 'Left hand')!
    expect(left.getAttribute('aria-pressed')).toBe('false')
    expect(byLabel(view.container, 'Right hand')?.getAttribute('aria-pressed')).toBe('false')
    expect(left.getAttribute('aria-disabled')).toBe('true')
    expect(left.getAttribute('title')).toContain('Piano not connected')
    expect(byLabel(view.container, 'Listen')).not.toBeNull()
    click(left)
    await settle(r, 1)
    expect(notices.value.some((n) => n.text.startsWith('Piano not connected'))).toBe(true)
    expect(byLabel(view.container, 'Left hand')?.getAttribute('aria-pressed')).toBe('false')
    // The piano arrives: the piece's remembered hands (both) come back without a save.
    act(() => {
      connectionStatus.value = { state: 'connected', inputName: 'Piano' }
    })
    await settle(r, 1)
    expect(byLabel(view.container, 'Left hand')?.getAttribute('aria-pressed')).toBe('true')
    expect(byLabel(view.container, 'Left hand')?.hasAttribute('aria-disabled')).toBe(false)
    expect(byLabel(view.container, 'Start')).not.toBeNull()
  })

  it('the Play through switch toggles play-through with Start, Pause and Resume; no wrong-key cue (P12)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const tool = () => playThroughSwitch(view!.container)
    expect(tool()).not.toBeNull()
    expect(tool().checked).toBe(false)
    expect(tool().disabled).toBe(false)
    click(tool())
    await settle(r, 1)
    expect($(view.container, '[data-activity]')?.dataset['activity']).toBe('playing')
    expect(tool().checked).toBe(true)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    expect(byLabel(view.container, 'Pause')).not.toBeNull()
    act(() => {
      r.midi.on(70, r.clock.now)
      r.frames.flush()
    })
    await settle(r, 2)
    expect($(view.container, '[data-testid="stage-cue"]')).toBeNull()
    expect($(view.container, '[data-testid="interruption"]')).toBeNull()
    click(byLabel(view.container, 'Pause'))
    await settle(r, 1)
    expect(byLabel(view.container, 'Resume')).not.toBeNull()
    click(tool())
    await settle(r, 1)
    expect($(view.container, '[data-activity]')?.dataset['activity']).not.toBe('playing')
    expect(tool().checked).toBe(false)
    // Both hands off is Listen: play-through is not available there.
    click(byLabel(view.container, 'Left hand'))
    await settle(r, 1)
    click(byLabel(view.container, 'Right hand'))
    await settle(r, 1)
    expect(tool().disabled).toBe(true)
  })

  it('the Keep time switch: exclusive with Play through, a badge on Menu, Start counts in over the stage (P13)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const keep = () => menuSwitch(view!.container, 'Keep time')
    const badge = () => $(view!.container, '[data-testid="keep-time-badge"]')
    expect(keep().checked).toBe(false)
    expect(keep().disabled).toBe(false)
    expect(badge()).toBeNull()
    click(playThroughSwitch(view.container))
    await settle(r, 1)
    click(keep())
    await settle(r, 1)
    expect(keep().checked).toBe(true)
    expect(playThroughSwitch(view.container).checked).toBe(false)
    expect(badge()).not.toBeNull()
    // Saved on the piece through the debounced piece saver.
    act(() => r.clock.advance(1100))
    await settle(r)
    expect((await r.storage.getPiece(r.pieceId))?.rhythm).toBe(true)
    click(byLabel(view.container, 'Start'))
    await settle(r)
    const countIn = $(view.container, '[data-testid="count-in"]')
    expect(countIn).not.toBeNull()
    expect(countIn?.getAttribute('role')).toBe('status')
    expect(Number(countIn?.textContent)).toBeGreaterThan(0)
    // The count-in sits on the stage, never over the footer's hand toggles.
    expect(countIn?.closest('footer')).toBeNull()
    expect($(view.container, '[data-testid="ready"]')).toBeNull()
    expect(byLabel(view.container, 'Pause')).not.toBeNull()
    click(byLabel(view.container, 'Pause'))
    await settle(r, 1)
    expect($(view.container, '[data-testid="count-in"]')).toBeNull()
    expect(byLabel(view.container, 'Start')).not.toBeNull()
    // Play through switches Keep time off again.
    click(playThroughSwitch(view.container))
    await settle(r, 1)
    expect(keep().checked).toBe(false)
    expect(badge()).toBeNull()
  })

  it('the Play through switch is disabled without a connected piano (P12, U27)', async () => {
    connectionStatus.value = { state: 'disconnected' }
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    expect(playThroughSwitch(view.container).disabled).toBe(true)
  })

  describe('footer menu (U76)', () => {
    const menuButton = () => byLabel($(view!.container, 'footer')!, 'Menu')!
    const panel = () => byLabel(view!.container, 'Practice menu')
    /** Lets the 160 ms fade-out finish. */
    const faded = () =>
      act(async () => {
        await new Promise((res) => setTimeout(res, 400))
      })

    async function opened(): Promise<Rig> {
      const r = await rig()
      practiceRequest.value = { pieceId: r.pieceId }
      view = mount(<PracticeViewWith env={r.env} />)
      await settle(r)
      return r
    }

    it('opens a popover dialog with Note names, Play through, Keep time and Show keys; aria-expanded follows', async () => {
      await opened()
      const button = menuButton()
      expect(button.getAttribute('aria-haspopup')).toBe('dialog')
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(panel()).toBeNull()
      click(button)
      expect(button.getAttribute('aria-expanded')).toBe('true')
      const dialog = panel()!
      expect(dialog.getAttribute('role')).toBe('dialog')
      expect(dialog.getAttribute('aria-modal')).toBeNull()
      expect(
        [...dialog.children].map(
          (row) => row.textContent?.trim().match(/^(Note names|Play through|Keep time|Show keys)/)?.[0],
        ),
      ).toEqual(['Note names', 'Play through', 'Keep time', 'Show keys'])
      expect(byLabel(dialog, 'Faster by 5 percent')).toBeNull()
      expect(byLabel(dialog, 'Note names on the score')).not.toBeNull()
      expect(dialog.querySelectorAll('input[role="switch"]')).toHaveLength(3)
      expect(dialog.contains(document.activeElement)).toBe(true)
      // The Menu button again closes it.
      click(button)
      expect(button.getAttribute('aria-expanded')).toBe('false')
      await faded()
      expect(panel()).toBeNull()
    })

    it('Escape closes it and returns focus to the Menu button', async () => {
      await opened()
      const dialog = openMenu(view!.container)
      press(dialog, 'Escape')
      expect(menuButton().getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(menuButton())
      await faded()
      expect(panel()).toBeNull()
    })

    it('a press outside the menu closes it; one inside does not', async () => {
      await opened()
      const dialog = openMenu(view!.container)
      act(() => {
        dialog.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      })
      expect(menuButton().getAttribute('aria-expanded')).toBe('true')
      act(() => {
        $(view!.container, 'header')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      })
      expect(menuButton().getAttribute('aria-expanded')).toBe('false')
    })

    it('closes when playback starts', async () => {
      const r = await opened()
      openMenu(view!.container)
      click(byLabel(view!.container, 'Start'))
      await settle(r)
      expect(byLabel(view!.container, 'Pause')).not.toBeNull()
      expect(menuButton().getAttribute('aria-expanded')).toBe('false')
    })

    it('Show keys is a switch in the menu; Speed stays in the footer outside it', async () => {
      const r = await opened()
      const footer = $(view!.container, 'footer')!
      expect(byLabel(footer, 'Show keys')).toBeNull()
      expect(byLabel(footer, 'Faster by 5 percent')).not.toBeNull()
      const dialog = openMenu(view!.container)
      expect(byLabel(dialog, 'Faster by 5 percent')).toBeNull()
      const keys = menuSwitch(view!.container, 'Show keys')
      expect(keys.checked).toBe(false)
      expect($(view!.container, '[aria-label="Keyboard guide"]')).toBeNull()
      click(keys)
      await settle(r, 1)
      expect(menuSwitch(view!.container, 'Show keys').checked).toBe(true)
      expect($(view!.container, '[aria-label="Keyboard guide"]')).not.toBeNull()
      // The menu stays open while toggling.
      expect(menuButton().getAttribute('aria-expanded')).toBe('true')
    })
  })

  it('the chrome recedes while playing and comes back on a tap near it or on pause (U13)', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    const screen = () => $(view!.container, '[data-activity]')!
    click(byLabel(view.container, 'Start'))
    await settle(r)
    expect(screen().dataset['recede']).toBeUndefined()
    act(() => r.clock.advance(RECEDE_DELAY_MS))
    await settle(r, 1)
    expect(screen().dataset['recede']).toBe('true')
    // A tap on the footer brings it back for a while; the main button never recedes.
    expect($(view.container, 'header')!.hasAttribute('inert')).toBe(true)
    expect($(view.container, '[data-testid="footer-tools-slot"]')!.hasAttribute('inert')).toBe(true)
    act(() => {
      $(view!.container, 'footer')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    await settle(r, 1)
    expect(screen().dataset['recede']).toBeUndefined()
    expect($(view.container, 'header')!.hasAttribute('inert')).toBe(false)
    expect($(view.container, '[data-testid="footer-tools-slot"]')!.hasAttribute('inert')).toBe(false)
    act(() => r.clock.advance(REVEAL_MS))
    await settle(r, 1)
    expect(screen().dataset['recede']).toBe('true')
    // Safari pointer clicks need not focus the play button: Tab can originate on the document.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    await settle(r, 1)
    expect(screen().dataset['recede']).toBeUndefined()
    // Error feedback remains the damage vignette; there is no text over the score.
    act(() => {
      r.midi.on(70, r.clock.now)
      r.frames.flush()
    })
    await settle(r, 2)
    expect($(view.container, '[data-testid="wrong-note-flash"]')).not.toBeNull()
    expect(view.container.textContent).not.toContain('Wrong key')
    click(byLabel(view.container, 'Pause'))
    await settle(r, 1)
    expect(screen().dataset['recede']).toBeUndefined()
  })

  it('the speed ladder select offers goals above the speed, shows its status and is saved on the piece', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    act(() => r.strips.at(-1)!.options.onCursorAction?.())
    await settle(r)
    const panel = $(view.container, '[data-testid="repeat-controls"]')!
    const select = $(panel, '[data-testid="ladder-select"]') as HTMLSelectElement
    expect(select.closest('label')?.textContent).toContain('Speed ladder')
    // At 100% the goals are the faster presets.
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Ladder: off',
      'Ladder to 125%',
      'Ladder to 150%',
      'Ladder to 200%',
    ])
    expect($(panel, '[data-testid="ladder-line"]')).toBeNull()
    act(() => {
      select.value = '150'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle(r)
    expect($(panel, '[data-testid="ladder-line"]')?.textContent).toBe('Ladder 100% → 150%')
    act(() => r.clock.advance(1500))
    await settle(r)
    expect((await r.storage.getPiece(r.pieceId))?.ladder).toEqual({ goal: 1.5, step: 0.05 })
    act(() => {
      select.value = ''
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle(r)
    expect($(panel, '[data-testid="ladder-line"]')).toBeNull()
    act(() => r.clock.advance(1500))
    await settle(r)
    expect((await r.storage.getPiece(r.pieceId))?.ladder).toBeNull()
  })

  it('remembers hands, passage and speed on the piece', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    act(() => r.strips.at(-1)!.options.onCursorAction?.())
    await settle(r)
    click(byLabel(view.container, 'Move loop end one bar later'))
    act(() => r.clock.advance(1500))
    await settle(r)
    const piece = await r.storage.getPiece(r.pieceId)
    expect(piece?.lastPassage).toEqual({ fromOcc: 0, toOcc: 1 })
  })

  describe('portrait page mode', () => {
    let portrait = false
    const listeners = new Set<() => void>()
    const original = window.matchMedia

    beforeEach(() => {
      portrait = false
      listeners.clear()
      window.matchMedia = ((query: string) => ({
        get matches() {
          return query.includes('portrait') ? portrait : false
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      })) as unknown as typeof window.matchMedia
    })

    afterEach(() => {
      window.matchMedia = original
    })

    /** A rig recording each view's mode and prepare options. */
    async function pageRig() {
      const r = await rig()
      const modes: (string | undefined)[] = []
      const prepared: { mode?: string; pageWidth?: number }[] = []
      const env: PracticeEnv = {
        ...r.env,
        prepare: async (_s, _i, options) => {
          prepared.push({
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.pageWidth ? { pageWidth: options.pageWidth } : {}),
          })
          return { key: 'fake' } as unknown as PreparedLayout
        },
        createStrip: (host, layout, options, mode) => {
          modes.push(mode)
          return r.env.createStrip(host, layout, options, mode)
        },
      }
      return { ...r, env, modes, prepared }
    }

    const rotate = (to: boolean) =>
      act(() => {
        portrait = to
        for (const fn of [...listeners]) fn()
      })

    it('portrait creates the page view, landscape the strip, and a rotation swaps them in place', async () => {
      portrait = true
      const r = await pageRig()
      practiceRequest.value = { pieceId: r.pieceId }
      view = mount(<PracticeViewWith env={r.env} />)
      await settle(r)
      expect(r.modes).toEqual(['page'])
      expect(r.prepared.at(-1)?.mode).toBe('page')
      expect(r.prepared.at(-1)?.pageWidth).toBeGreaterThan(0)
      expect(r.strips[0]!.options.initialZoom).toBe(1)

      rotate(false)
      await settle(r)
      expect(r.modes).toEqual(['page', 'strip'])
      expect(r.strips[0]!.destroyed).toBe(true)
      expect(r.prepared.at(-1)?.mode).toBeUndefined()
      expect($(view.container, '[data-testid="strip-host"]')?.dataset['mode']).toBe('strip')

      rotate(true)
      await settle(r)
      expect(r.modes).toEqual(['page', 'strip', 'page'])
      expect(r.strips[1]!.destroyed).toBe(true)
    })

    it('page zoom persists apart from the strip zoom and re-prepares the page', async () => {
      portrait = true
      const r = await pageRig()
      practiceRequest.value = { pieceId: r.pieceId }
      view = mount(<PracticeViewWith env={r.env} />)
      await settle(r)
      const width = r.prepared.at(-1)!.pageWidth!
      act(() => r.strips.at(-1)!.options.onZoomChange?.(2))
      await settle(r)
      expect(settings.value.view.pageZoom).toBe(2)
      expect(settings.value.view.zoom).toBe(1)
      expect(r.modes).toEqual(['page', 'page'])
      expect(r.prepared.at(-1)!.pageWidth!).toBeLessThan(width)
      expect(r.strips.at(-1)!.options.initialZoom).toBe(2)
    })
  })
})
