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
import { $, $$, byLabel, byText, click, mount, type Mounted } from '../shared/testing'
import type { PracticeEnv, PracticeStripOptions, StripHandle } from './env'
import { REPEAT_PANEL_FADE_MS } from './PracticeScreen'
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
  setZoom(): void {}
  returnToCurrent(): void {}
  destroy(): void {
    this.destroyed = true
  }
}

interface Rig {
  env: PracticeEnv
  storage: PianissimoStorage
  clock: ManualClock
  frames: ManualFrames
  midi: FakeMidi
  strips: TestStrip[]
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
  const env: PracticeEnv = {
    storage: async () => storage,
    midi: () => midi,
    clock: clock.clock,
    timers: clock,
    frames,
    timeOrigin: 0,
    prepare: async () => ({ key: 'fake' }) as unknown as PreparedLayout,
    createStrip: (_host, _layout, options) => {
      const s = new TestStrip()
      s.options = options
      strips.push(s)
      return s
    },
  }
  return { env, storage, clock, frames, midi, strips, pieceId: piece.id }
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
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
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

  it('the Labels control applies label settings; both hands off turns Start into Listen', async () => {
    const r = await rig()
    practiceRequest.value = { pieceId: r.pieceId }
    view = mount(<PracticeViewWith env={r.env} />)
    await settle(r)
    click($$(view.container, '[role="radio"]').find((el) => el.textContent === 'All'))
    expect(settings.value.labels.mode).toBe('all')
    await settle(r, 1)
    act(() => r.clock.advance(400))
    act(() => r.frames.flush())
    expect(r.strips[0]!.opacity.size).toBeGreaterThan(0)
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
    const overview = $(view.container, '[role="slider"]')!.closest('header + div')!
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
  })

  it('has no passage bar; Settings is in the header, Speed and Labels in the footer (U12)', async () => {
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
    expect(byLabel(footer, 'Note names on the score')).not.toBeNull()
    expect(byLabel(footer, 'Faster by 5 percent')).not.toBeNull()
    expect(byLabel(header, 'Faster by 5 percent')).toBeNull()
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
    act(() => {
      $(view!.container, 'footer')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    await settle(r, 1)
    expect(screen().dataset['recede']).toBeUndefined()
    act(() => r.clock.advance(REVEAL_MS))
    await settle(r, 1)
    expect(screen().dataset['recede']).toBe('true')
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
})
