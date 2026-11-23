// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { connectionOpen, studyRequest, currentView, practiceRequest, settingsOpen } from '../../app/navigation'
import { connectionStatus, resetAppStateForTests, settings } from '../../app/state'
import { FakeMidi, FakeStrip, ManualFrames } from '../../app/session/testkit'
import { newPieceRecord } from '../../core/storage/records'
import { openFresh } from '../../core/storage/testkit'
import type { PianissimoStorage } from '../../core/storage'
import type { PreparedLayout, RespaceSnapshot } from '../../render'
import { ManualClock } from '../../core/playback/testkit'
import { importFixture } from '../../../tests/unit/import/fixtures'
import { $, $$, byLabel, byText, click, hasRecordIcon, mount, press, type Mounted } from '../shared/testing'
import { untranslatedText, usePseudoCatalog } from '../shared/catalogTesting'
import { msg } from '../../i18n/messages'
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
  /** `pageMaxWidth` of every preparation (R17: every page is capped at its width). */
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
    micSupported: () => false,
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

/** A tablet held upright: only the portrait query matches. */
function onTabletPortrait(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === '(orientation: portrait)',
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

/** The tablet footer's popover (U90), when open. */
const studyMenu = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Sheet music menu"]')
const footerMenuButton = () => byLabel($(view!.container, 'footer')!, 'Menu') as HTMLButtonElement

/** Opens the footer's Sheet music menu and returns its popover. */
function openStudyMenu(): HTMLElement {
  if (footerMenuButton().getAttribute('aria-expanded') !== 'true') click(footerMenuButton())
  return studyMenu()!
}

/** The switch of a menu row, by its label. */
function menuSwitch(menu: HTMLElement, name: string): HTMLInputElement {
  return $$(menu, 'label')
    .find((el) => el.textContent?.trim() === name)!
    .querySelector<HTMLInputElement>('input[role="switch"]')!
}

describe('StudyView (U72)', () => {
  it('without a request shows an empty state that leads back to the Library and lists recent pieces', async () => {
    const r = await rig()
    view = mount(<StudyViewWith env={r.env} />)
    await settle(r)
    expect(view.container.textContent).toContain('Choose a piece')
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
    // Listen and Follow live in the footer alongside Speed.
    expect(byLabel(view!.container, 'Listen')).not.toBeNull()
    expect((byLabel(view!.container, 'Listen') as HTMLButtonElement).disabled).toBe(false)
    expect(byLabel(view!.container, 'Go to the start')).toBeNull()
    expect(byLabel(view!.container, 'Name the notes at the cursor')).toBeNull()
    const menu = openStudyMenu()
    expect(menuSwitch(menu, 'Show keys')).toBeTruthy()
    expect(byLabel(menu, 'Note names on the score')).not.toBeNull()
    // Nothing of Practice: hands, Start, Listen, Repeat, the cursor's repeat button, loop handles.
    expect(byLabel(view!.container, 'Left hand')).toBeNull()
    expect(byLabel(view!.container, 'Right hand')).toBeNull()
    expect(byLabel(view!.container, 'Start')).toBeNull()
    expect(byLabel(view!.container, 'Follow my playing')).not.toBeNull()
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
    click(byLabel(view!.container, 'Listen'))
    await settle(r, 3)
    expect($(view!.container, '[data-testid="study-screen"]')?.dataset['playing']).toBe('true')
    expect(byLabel(view!.container, 'Listen')?.getAttribute('aria-pressed')).toBe('true')
    act(() => {
      r.clock.advance(1500)
      r.frames.flush()
    })
    expect(strip.cursor).toBeGreaterThan(0)
    click(byLabel(view!.container, 'Listen'))
    await settle(r, 1)
    expect(byLabel(view!.container, 'Listen')).not.toBeNull()
    // The overview moves between the last and first bars.
    const overview = byLabel(view!.container, 'Piece overview')
    press(overview, 'End')
    act(() => r.frames.flush())
    expect(overview?.getAttribute('aria-valuenow')).toBe('2')
    press(overview, 'Home')
    act(() => r.frames.flush())
    expect(strip.cursor).toBe(0)
    expect(strip.returned).toBe(2)
    view!.unmount()
    view = null
    const piece = (await r.storage.getPiece(r.pieceId))!
    expect(piece.lastHands).toBe('left')
    expect(piece.lastMultiplier).toBe(0.5)
    expect(piece.resume).toBeNull()
    expect(piece.lastPassage).toBeFalsy()
  })

  it('follows a selected hand through the microphone and releases it when switching to Listen', async () => {
    const r = await rig()
    const dispose = vi.fn()
    const openFollower = vi.fn<NonNullable<PracticeEnv['createMicFollower']>>(() => ({
      start: async () => undefined,
      reset: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      dispose,
    }))
    r.env = { ...r.env, micSupported: () => true, createMicFollower: openFollower }
    await openPiece(r)
    const menu = openStudyMenu()
    const source = $(menu, '[aria-label="Follow input"]')!
    expect(byText(source, 'Microphone', 'button')?.getAttribute('aria-checked')).toBe('true')
    expect((byText(source, 'Piano', 'button') as HTMLButtonElement).disabled).toBe(true)
    click(byText($(menu, '[aria-label="Hands to follow"]')!, 'Left', 'button'))
    const follow = byLabel(view!.container, 'Follow my playing')
    click(follow)
    await settle(r)
    expect(openFollower.mock.calls[0]?.[3]).toBe('left')
    expect(follow?.getAttribute('aria-pressed')).toBe('true')
    const listen = byLabel(view!.container, 'Listen')
    click(listen)
    await settle(r)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(follow?.getAttribute('aria-pressed')).toBe('false')
    expect(listen?.getAttribute('aria-pressed')).toBe('true')
  })

  it("has Practice's footer with Listen and Follow my playing at its center", async () => {
    const r = await rig()
    await openPiece(r)
    const footers = $$(view!.container, 'footer')
    expect(footers).toHaveLength(1)
    const footer = footers[0]!
    expect($(footer, '[data-testid="footer-tools-slot"]')).not.toBeNull()
    expect(byLabel(footer, 'Faster by 5 percent')).not.toBeNull()
    const center = byLabel(footer, 'Listen')!.parentElement!
    expect($$(center, 'button').map((el) => el.textContent)).toEqual(['Listen', 'Follow my playing'])
    const menu = footerMenuButton()
    expect(menu.getAttribute('aria-haspopup')).toBe('dialog')
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    // The old footer tools are gone from the footer itself.
    expect(byLabel(footer, 'Show keys')).toBeNull()
    expect(byLabel(footer, 'Metronome')).toBeNull()
    expect(byLabel(footer, 'Note names on the score')).toBeNull()
  })

  it('the Sheet music menu holds Note names, Metronome and Show keys, stays open while playing, and Escape closes it (U90)', async () => {
    const r = await rig()
    await openPiece(r)
    expect(studyMenu()).toBeNull()
    const menu = openStudyMenu()
    expect(footerMenuButton().getAttribute('aria-expanded')).toBe('true')
    expect(
      [...menu.children].map(
        (row) =>
          row.textContent
            ?.trim()
            .match(/^(Note names|Play through|Keep time|Metronome|Show keys|Record performance)/)?.[0],
      ),
    ).toEqual(['Note names', 'Metronome', 'Show keys', 'Record performance'])
    expect(hasRecordIcon(byLabel(menu, 'Record performance'))).toBe(true)
    expect(menu.querySelectorAll('input[role="switch"]')).toHaveLength(2)
    expect(menu.contains(document.activeElement)).toBe(true)
    // Playback does not close it: Study never recedes.
    click(byLabel(view!.container, 'Listen'))
    await settle(r, 3)
    expect(byLabel(view!.container, 'Listen')?.getAttribute('aria-pressed')).toBe('true')
    expect(footerMenuButton().getAttribute('aria-expanded')).toBe('true')
    expect(studyMenu()).not.toBeNull()
    press(studyMenu(), 'Escape')
    expect(footerMenuButton().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(footerMenuButton())
  })

  it('the Note names control re-engraves with room for labels, gliding from the tight view', async () => {
    const r = await rig()
    await openPiece(r)
    click($$(openStudyMenu(), '[role="radio"]').find((el) => el.textContent === 'All'))
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

  it("the menu's Show keys switch opens the keyboard guide slot", async () => {
    const r = await rig()
    await openPiece(r)
    const slot = () => $(view!.container, '[data-testid="guide-slot"]')
    expect(slot()?.dataset['open']).toBe('false')
    const keys = menuSwitch(openStudyMenu(), 'Show keys')
    expect(keys.checked).toBe(false)
    click(keys)
    await settle(r, 1)
    expect(slot()?.dataset['open']).toBe('true')
    expect(menuSwitch(studyMenu()!, 'Show keys').checked).toBe(true)
  })

  it("the menu's Metronome switch follows and edits metronome.enabled, priming audio once when it turns on (U87)", async () => {
    let primed = 0
    const r = await rig()
    r.env = { ...r.env, primeAudio: () => primed++ }
    await openPiece(r)
    const metronome = () => menuSwitch(openStudyMenu(), 'Metronome')
    expect(metronome().checked).toBe(false)
    expect(metronome().disabled).toBe(false)
    click(metronome())
    await settle(r, 1)
    expect(settings.value.metronome.enabled).toBe(true)
    expect(metronome().checked).toBe(true)
    expect(primed).toBe(1)
    click(metronome())
    await settle(r, 1)
    expect(settings.value.metronome.enabled).toBe(false)
    expect(metronome().checked).toBe(false)
    expect(primed).toBe(1)
  })

  it("the menu's Metronome switch is disabled without Web Audio (U87)", async () => {
    const r = await rig()
    r.env = { ...r.env, hasWebAudio: () => false }
    await openPiece(r)
    expect(menuSwitch(openStudyMenu(), 'Metronome').disabled).toBe(true)
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

  it('a tablet held upright caps the page and fits it to the stage, with no image zoom (R17)', async () => {
    onTabletPortrait()
    const r = await rig()
    await openPiece(r)
    expect(r.modes).toEqual(['page'])
    expect(r.caps[0]).toBeGreaterThan(0)
    expect(r.strips[0]!.options.fitWidth).toBe(true)
    expect(r.strips[0]!.options.imageZoom).toBe(false)
    expect(r.strips[0]!.options.initialMagnify).toBe(1)
  })

  describe('on a phone-size screen (U74)', () => {
    it('puts Listen, Follow my playing, and Menu in the phone header', async () => {
      onPhone()
      const r = await rig()
      await openPiece(r)
      const root = view!.container
      expect($(root, '[data-testid="study-screen"]')?.dataset['compact']).toBe('true')
      expect($(root, 'footer')).toBeNull()
      const header = $(root, 'header')!
      for (const name of ['Back to Library', 'Listen', 'Follow my playing', 'Menu'])
        expect(byLabel(header, name), name).not.toBeNull()
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
      expect(hasRecordIcon(byLabel(menu, 'Record performance'))).toBe(true)
      expect(byLabel(menu, 'Settings')).not.toBeNull()
      expect(byLabel(menu, 'Name the notes at the cursor')).toBeNull()
      expect(byLabel(menu, 'Go to the start')).toBeNull()
    })

    it('the menu has the Metronome switch right after Speed (U87)', async () => {
      onPhone()
      let primed = 0
      const r = await rig()
      r.env = { ...r.env, primeAudio: () => primed++ }
      await openPiece(r)
      const root = view!.container
      expect(byLabel(root, 'Metronome')).toBeNull()
      click(byLabel(root, 'Menu'))
      await settle(r, 1)
      const row = $$(dialog()!, 'label').find((el) => el.textContent?.trim() === 'Metronome')!
      expect(row.previousElementSibling?.textContent).toContain('Speed')
      const input = row.querySelector<HTMLInputElement>('input[role="switch"]')!
      expect(input.checked).toBe(false)
      click(input)
      await settle(r, 1)
      expect(settings.value.metronome.enabled).toBe(true)
      expect(primed).toBe(1)
    })

    it('shows keys from the menu and seeks through the overview while listening', async () => {
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

      click(byLabel(dialog()!, 'Close'))
      expect(byLabel(root, 'Menu')?.getAttribute('aria-expanded')).toBe('false')

      click(byLabel(root, 'Listen'))
      await settle(r, 3)
      expect(byLabel(root, 'Listen')?.getAttribute('aria-pressed')).toBe('true')
      act(() => {
        r.clock.advance(1500)
        r.frames.flush()
      })
      expect(strip.cursor).toBeGreaterThan(0)
      press(byLabel(root, 'Piece overview'), 'End')
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
      // A phone's page magnifies like a photo (U83), engraved at zoom 1.
      expect(r.strips[0]!.options.imageZoom).toBe(true)
      expect(r.strips[0]!.options.initialZoom).toBe(1)
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
      for (const name of ['Back to Library', 'Listen', 'Menu']) expect(byLabel(header, name), name).not.toBeNull()
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

describe('translation coverage', () => {
  // The piece title, the composer and note names are literal data.
  const literal = ['Two Hands', 'Pianissimo fixtures', /\b[A-G][♯♭]?-?\d\b/u]

  it('shows no text that bypasses the catalogs', async () => {
    const restore = usePseudoCatalog()
    try {
      const r = await rig()
      view = mount(<StudyViewWith env={r.env} />)
      await settle(r)
      expect(untranslatedText(view.container, literal)).toEqual([])
      view.unmount()

      studyRequest.value = { pieceId: 'gone' }
      view = mount(<StudyViewWith env={r.env} />)
      await settle(r)
      expect(untranslatedText(view.container, literal)).toEqual([])
      view.unmount()

      await openPiece(r)
      expect(untranslatedText(view!.container, literal)).toEqual([])
      click(byLabel($(view!.container, 'footer')!, msg('Menu')))
      expect(untranslatedText(document.body, literal)).toEqual([])
    } finally {
      restore()
    }
  })

  it('on a phone shows no text that bypasses the catalogs', async () => {
    const restore = usePseudoCatalog()
    try {
      onPhone()
      const r = await rig()
      await openPiece(r)
      expect(untranslatedText(view!.container, literal)).toEqual([])
    } finally {
      restore()
    }
  })
})
