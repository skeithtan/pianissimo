// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { connectionOpen, studyRequest, currentView, practiceRequest, settingsOpen } from '../../app/navigation'
import { connectionStatus, notices, resetAppStateForTests, settings } from '../../app/state'
import { FakeMidi, FakeStrip, ManualFrames } from '../../app/session/testkit'
import { newPieceRecord } from '../../core/storage/records'
import { openFresh } from '../../core/storage/testkit'
import type { PianissimoStorage } from '../../core/storage'
import type { PreparedLayout, RespaceSnapshot } from '../../render'
import { ManualClock } from '../../core/playback/testkit'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { $, $$, byLabel, byText, click, mount, type Mounted } from '../shared/testing'
import type { PracticeEnv, PracticeStripOptions, StripHandle } from '../practice/env'
import { StudyViewWith } from './StudyView'
import { PHONE_LANDSCAPE_QUERY, PHONE_QUERY } from '../shared/usePhone'

class TestStrip extends FakeStrip implements StripHandle {
  destroyed = false
  options: PracticeStripOptions = {}
  returned = 0
  occAt(): number {
    return 0
  }
  setZoom(): void {}
  returnToCurrent(): void {
    this.returned++
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
  whenRespaced(): Promise<void> {
    return Promise.resolve()
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
  rooms: (string | undefined)[]
  modes: (string | undefined)[]
  /** `pageMaxWidth` of every preparation (R17: a phone's page is capped at its width). */
  caps: (number | undefined)[]
  pieceId: string
}

async function rig(): Promise<Rig> {
  const storage = await openFresh()
  const built = await importFixture('two-hands.musicxml')
  const piece = newPieceRecord(built.package, { id: 'piece-1', now: 1 })
  await storage.commitImport({ source: built.source, pkg: built.package, piece })
  // Practice state that Study must leave alone.
  await storage.updatePiece(piece.id, { lastHands: 'left', lastMultiplier: 0.5, resume: null })
  const clock = new ManualClock()
  clock.now = 1000
  const frames = new ManualFrames(clock.clock)
  const midi = new FakeMidi()
  const strips: TestStrip[] = []
  const rooms: (string | undefined)[] = []
  const modes: (string | undefined)[] = []
  const caps: (number | undefined)[] = []
  const env: PracticeEnv = {
    storage: async () => storage,
    midi: () => midi,
    clock: clock.clock,
    timers: clock,
    frames,
    timeOrigin: 0,
    prepare: async (_s, _i, options) => {
      rooms.push(options.labels.room)
      modes.push(options.mode)
      caps.push(options.pageMaxWidth)
      return { key: 'fake' } as unknown as PreparedLayout
    },
    createStrip: (_host, _layout, options) => {
      const s = new TestStrip()
      s.options = options
      strips.push(s)
      return s
    },
  }
  return { env, storage, clock, frames, midi, strips, rooms, modes, caps, pieceId: piece.id }
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

let view: Mounted | null = null

beforeEach(() => {
  resetAppStateForTests()
  // A phone: no Web MIDI at all.
  connectionStatus.value = { state: 'unsupported' }
  studyRequest.value = null
  practiceRequest.value = null
  settingsOpen.value = false
  connectionOpen.value = false
})

afterEach(() => {
  view?.unmount()
  view = null
  vi.unstubAllGlobals()
})

/** A phone-size screen: the phone query matches (and the portrait one, as on an upright phone). */
function onPhone(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === PHONE_QUERY || q === '(orientation: portrait)',
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

/** A phone on its side: the phone and phone-landscape queries match, portrait does not (U80). */
function onPhoneSideways(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === PHONE_QUERY || q === PHONE_LANDSCAPE_QUERY,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]')

async function openPiece(r: Rig): Promise<void> {
  studyRequest.value = { pieceId: r.pieceId }
  view = mount(<StudyViewWith env={r.env} />)
  await settle(r)
}

describe('StudyView (U72)', () => {
  it('without a request shows an empty state that leads back to the Library and lists recent pieces', async () => {
    const r = await rig()
    view = mount(<StudyViewWith env={r.env} />)
    await settle(r)
    expect(view.container.textContent).toContain('Choose a piece to study')
    click(byText(view.container, 'Back to Library'))
    expect(currentView.value).toBe('library')
    click(byText(view.container, 'Two Hands'))
    expect(studyRequest.value).toEqual({ pieceId: 'piece-1' })
  })

  it('explains a missing piece', async () => {
    const r = await rig()
    studyRequest.value = { pieceId: 'gone' }
    view = mount(<StudyViewWith env={r.env} />)
    await settle(r)
    expect(view.container.textContent).toContain('Can’t open this piece')
    expect(view.container.textContent).toContain('no longer in the library')
  })

  it('opens the piece in Listen with playback controls and no practice controls', async () => {
    const r = await rig()
    await openPiece(r)
    expect($(view!.container, 'h1')?.textContent).toBe('Two Hands')
    expect(r.strips).toHaveLength(1)
    expect(r.rooms).toEqual(['hints'])
    // Playback: Play, Go to the start, Speed; names and keys as reading aids.
    expect(byLabel(view!.container, 'Play')).not.toBeNull()
    expect((byLabel(view!.container, 'Play') as HTMLButtonElement).disabled).toBe(false)
    expect(byLabel(view!.container, 'Go to the start')).not.toBeNull()
    expect(byLabel(view!.container, 'Name the notes at the cursor')).not.toBeNull()
    expect(byLabel(view!.container, 'Show keys')).not.toBeNull()
    expect(byLabel(view!.container, 'Note names on the score')).not.toBeNull()
    // Nothing of Practice: hands, Start, Listen, Repeat, the cursor's repeat button, loop handles.
    expect(byLabel(view!.container, 'Left hand')).toBeNull()
    expect(byLabel(view!.container, 'Right hand')).toBeNull()
    expect(byLabel(view!.container, 'Start')).toBeNull()
    expect(byLabel(view!.container, 'Listen')).toBeNull()
    expect(r.strips[0]!.cursorAction).toBe(false)
    expect(r.strips[0]!.loopEditable).toBe(false)
    expect(r.strips[0]!.options.onLoopChange).toBeUndefined()
    expect(r.strips[0]!.options.onCursorAction).toBeUndefined()
    // No targets are marked: nobody is expected to play.
    expect(r.strips[0]!.targets).toEqual([])
  })

  it('plays the piece through the output, pauses, and never writes practice state', async () => {
    const r = await rig()
    await openPiece(r)
    const strip = r.strips[0]!
    click(byLabel(view!.container, 'Play'))
    await settle(r, 3)
    expect($(view!.container, '[data-testid="study-screen"]')?.dataset['playing']).toBe('true')
    expect(byLabel(view!.container, 'Pause')).not.toBeNull()
    act(() => {
      r.clock.advance(1500)
      r.frames.flush()
    })
    expect(strip.cursor).toBeGreaterThan(0)
    click(byLabel(view!.container, 'Pause'))
    await settle(r, 1)
    expect(byLabel(view!.container, 'Play')).not.toBeNull()
    // Back to the start: the cursor returns to the first bar and the view follows it.
    click(byLabel(view!.container, 'Go to the start'))
    act(() => r.frames.flush())
    expect(strip.cursor).toBe(0)
    expect(strip.returned).toBe(1)
    view!.unmount()
    view = null
    const piece = (await r.storage.getPiece(r.pieceId))!
    expect(piece.lastHands).toBe('left')
    expect(piece.lastMultiplier).toBe(0.5)
    expect(piece.resume).toBeNull()
    expect(piece.lastPassage).toBeFalsy()
  })

  it('the Hint tool names the notes at the cursor for the hint lifetime', async () => {
    const r = await rig()
    await openPiece(r)
    const strip = r.strips[0]!
    expect(strip.opacity.size).toBe(0)
    click(byLabel(view!.container, 'Name the notes at the cursor'))
    expect(strip.opacity.size).toBeGreaterThan(0)
    for (const v of strip.opacity.values()) expect(v).toBe(1)
    expect(notices.value).toHaveLength(0)
    // The names go after the hint lifetime (30 s by default) plus the fade.
    act(() => {
      r.clock.advance(settings.value.hints.lifetime === 'until-correct' ? 5000 : 31_000)
      r.frames.flush()
    })
    expect(strip.opacity.size).toBe(0)
  })

  it('the Note names control re-engraves with room for labels, gliding from the tight view', async () => {
    const r = await rig()
    await openPiece(r)
    click($$(view!.container, '[role="radio"]').find((el) => el.textContent === 'All'))
    expect(settings.value.labels.mode).toBe('all')
    expect(r.strips[0]!.held).toEqual([true])
    await settle(r, 2)
    expect(r.rooms).toEqual(['hints', 'all'])
    expect(r.strips).toHaveLength(2)
    expect(r.strips[0]!.destroyed).toBe(true)
    expect(r.strips[1]!.respacedFrom).toEqual([r.strips[0]!.snapshot])
    act(() => {
      r.clock.advance(400)
      r.frames.flush()
    })
    expect(r.strips[1]!.opacity.size).toBeGreaterThan(0)
  })

  it('Show keys opens the keyboard guide slot', async () => {
    const r = await rig()
    await openPiece(r)
    const slot = () => $(view!.container, '[data-testid="guide-slot"]')
    expect(slot()?.dataset['open']).toBe('false')
    click(byLabel(view!.container, 'Show keys'))
    await settle(r, 1)
    expect(slot()?.dataset['open']).toBe('true')
    expect(byLabel(view!.container, 'Hide keys')).not.toBeNull()
  })

  it('Settings opens over the score and Back leads to the Library', async () => {
    const r = await rig()
    await openPiece(r)
    click(byLabel(view!.container, 'Settings'))
    expect(settingsOpen.value).toBe(true)
    click(byLabel(view!.container, 'Back to Library'))
    expect(currentView.value).toBe('library')
    expect(settingsOpen.value).toBe(false)
  })

  describe('on a phone-size screen (U74)', () => {
    it('has no footer: Play and the menu are in the header, the rest is in the menu', async () => {
      onPhone()
      const r = await rig()
      await openPiece(r)
      const root = view!.container
      expect($(root, '[data-testid="study-screen"]')?.dataset['compact']).toBe('true')
      expect($(root, 'footer')).toBeNull()
      const header = $(root, 'header')!
      for (const name of ['Back to Library', 'Play', 'Menu']) expect(byLabel(header, name), name).not.toBeNull()
      expect(byLabel(header, 'Show keys')).toBeNull()
      // Not on screen until the menu opens.
      expect(byLabel(root, 'Go to the start')).toBeNull()
      expect(byLabel(root, 'Note names on the score')).toBeNull()
      expect(byLabel(root, 'Settings')).toBeNull()
      expect(dialog()).toBeNull()

      click(byLabel(header, 'Menu'))
      await settle(r, 1)
      const menu = dialog()!
      expect(menu.getAttribute('aria-label')).toBe('Menu')
      // No visible title: the close button alone.
      expect($(menu, 'h2')).toBeNull()
      expect(byLabel(menu, 'Close')).not.toBeNull()
      expect(byLabel(menu, 'Note names on the score')).not.toBeNull()
      expect(menu.textContent).toContain('Speed')
      expect(menu.textContent).toContain('Show keys')
      for (const text of ['Name the notes at the cursor', 'Go to the start', 'Settings'])
        expect(byLabel(menu, text), text).not.toBeNull()
    })

    it('the menu shows the keys; its hint names the notes and closes the menu; the header plays', async () => {
      onPhone()
      const r = await rig()
      await openPiece(r)
      const root = view!.container
      const strip = r.strips[0]!
      click(byLabel(root, 'Menu'))
      await settle(r, 1)
      const keys = $$(dialog()!, 'label')
        .find((el) => el.textContent?.trim() === 'Show keys')!
        .querySelector<HTMLInputElement>('input[role="switch"]')!
      click(keys)
      await settle(r, 1)
      expect($(root, '[data-testid="guide-slot"]')?.dataset['open']).toBe('true')
      expect(keys.checked).toBe(true)
      // The phone's guide: highlighted keys, no name chips (U75).
      expect($$(root, '[data-part="bar"]').length).toBeGreaterThan(0)
      expect($$(root, '[data-part="label"]')).toHaveLength(0)
      expect($(root, '[data-part="keyboard-guide"]')?.dataset['labels']).toBe('false')

      click(byLabel(dialog()!, 'Name the notes at the cursor'))
      expect(strip.opacity.size).toBeGreaterThan(0)
      expect(byLabel(root, 'Menu')?.getAttribute('aria-expanded')).toBe('false')

      click(byLabel(root, 'Play'))
      await settle(r, 3)
      expect(byLabel(root, 'Pause')).not.toBeNull()
      act(() => {
        r.clock.advance(1500)
        r.frames.flush()
      })
      expect(strip.cursor).toBeGreaterThan(0)
      // Go to the start, from the menu.
      click(byLabel(root, 'Menu'))
      await settle(r, 1)
      click(byLabel(dialog()!, 'Go to the start'))
      act(() => r.frames.flush())
      expect(strip.returned).toBe(1)
    })

    it('engraves the page to the stage width, capped, and fits the view to it (R17)', async () => {
      onPhone()
      const r = await rig()
      await openPiece(r)
      expect(r.modes).toEqual(['page'])
      expect(r.caps[0]).toBeGreaterThan(0)
      expect(r.strips[0]!.options.fitWidth).toBe(true)
    })

    it('on its side puts the overview in the header, with no keyboard guide and no Show keys (U80)', async () => {
      onPhoneSideways()
      const r = await rig()
      await openPiece(r)
      const root = view!.container
      expect(r.modes).toEqual([undefined]) // the strip: no page options
      expect(r.caps[0]).toBeUndefined()
      expect(r.strips[0]!.options.fitWidth).toBe(false)
      expect($(root, '[data-testid="study-screen"]')?.dataset['sideways']).toBe('true')
      const header = $(root, 'header')!
      expect($(header, 'h1')?.textContent).toBe('Two Hands')
      expect(byLabel(header, 'Piece overview'), 'overview in the header').not.toBeNull()
      expect($$(root, '[aria-label="Piece overview"]')).toHaveLength(1)
      for (const name of ['Back to Library', 'Play', 'Menu']) expect(byLabel(header, name), name).not.toBeNull()
      expect(byLabel(root, 'Show keys')).toBeNull()
      expect($(root, '[data-testid="guide-slot"]')?.dataset['open']).toBe('false')
      click(byLabel(header, 'Menu'))
      await settle(r, 1)
      expect(dialog()!.textContent).not.toContain('Show keys')
    })

    it('Note names and Settings work from the menu', async () => {
      onPhone()
      const r = await rig()
      await openPiece(r)
      const root = view!.container
      expect(r.modes).toEqual(['page'])
      click(byLabel(root, 'Menu'))
      await settle(r, 1)
      click($$(dialog()!, '[role="radio"]').find((el) => el.textContent === 'All'))
      expect(settings.value.labels.mode).toBe('all')
      await settle(r, 2)
      expect(r.rooms).toEqual(['hints', 'all'])
      click(byLabel(dialog()!, 'Settings'))
      expect(settingsOpen.value).toBe(true)
      expect(byLabel(root, 'Menu')?.getAttribute('aria-expanded')).toBe('false')
    })
  })
})
