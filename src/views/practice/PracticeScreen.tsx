import { useRecordingDialog } from '../recordings/useRecordingDialog'
import { msg, messageLanguage } from '../../i18n/messages'
/**
 * The score screen (spec "Practice screen"; DECISIONS U1–U14, U141): one screen per piece, in the
 * mode the learner chooses (Listen, Wait, Keep time or Follow). A header that blends into the
 * background (back, title, the mode, connection, Settings), the full-width score overview (which
 * never recedes), the full-width notation stage with its overlays (Repeat panel in Repeat mode,
 * banners, correction cue), the keyboard-guide panel and the footer (Speed | hand toggles around
 * Start / Pause / Play | Menu). While playing, the chrome recedes (U13), except in Listen.
 *
 * On a phone-size screen (`usePhone`, U80) there is no header and no footer: one top bar holds
 * Back, the title with the mode under it (or, with the phone on its side, the piece overview and a
 * mode button), the hand toggles around Start and a Menu button whose sheet holds Speed, the
 * mode's rows, Show keys (not on its side: no keyboard guide there), the connection status and
 * Settings. The score takes the rest, and in portrait the page is engraved
 * to the stage's width and fitted to it (R17, as on every device). In focus mode the bar slides up
 * and fades, its row giving the score its height; any press on the score brings it back, and that
 * press does not seek (U93). A tablet's or desktop's header stays in focus mode.
 *
 * The `PracticeSession` owns every live behavior; this component only wires it to Preact and
 * re-renders on its coarse `ui` store. Per-frame state (cursor, correction cue, keyboard guide) goes to
 * small subscribed children.
 */
import type { RefObject } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { effect, signal, untracked } from '@preact/signals'
import { createMicFollowerDep, microphoneSupported } from '../../app/audio/micFollower'
import {
  navigate,
  openConnection,
  openNoteRules,
  openSettings,
  settingsOpen,
  type PracticePreset,
} from '../../app/navigation'
import {
  PracticeSession,
  createPieceSaver,
  isPractice,
  learnerHands,
  metronomeOn,
  metronomePatch,
  openingMode,
  practiceModel,
  type PieceSaver,
  type OpeningEnv,
  type SessionSettings,
  type AttemptSummary,
} from '../../app/session'
import {
  applyLabelSettings,
  connectionStatus,
  onBeforeApplyLabels,
  pushNotice,
  settings,
  updateSettings,
} from '../../app/state'
import type { Suggestion } from '../../core/history'
import { passageBounds, positionText } from '../../core/model/passage'
import type { PracticeMode } from '../../core/model/practice'
import type { ScorePackage } from '../../core/model/score'
import type { PersistentLabelMode } from '../../core/model/settings'
import { effectiveTempoAt, hasTempo } from '../../core/music/tempo'
import { maxLabelWidthChars } from '../../core/naming'
import type { PieceRecord, UserTempo } from '../../core/storage/records'
import { rat } from '../../core/music/rational'
import { Button, Sheet } from '../../ui/controls'
import { useFadePresence } from '../../ui/fade'
import { HandToggles } from '../../ui/HandToggles'
import { Icon } from '../../ui/icons'
import { TempoControl } from '../../ui/TempoControl'
import { WrongNoteFlash } from '../../ui/WrongNoteFlash'
import { ConnectionChip } from '../shared/ConnectionChip'
import { ProgressSheet } from '../progress/ProgressSheet'
import { usePhone, usePhoneLandscape } from '../shared/usePhone'
import { pageWidthFor } from '../../render/page/geometry'
import type { LabelRoom, PreparedLayout, PrepareOptions } from '../../render'
import { MemoryLayoutCache } from '../../render/cache'
import type { PracticeEnv, StripHandle } from './env'
import { GuidePanel, OverviewBar, StageCue } from './live'
import { AttemptResult, Banners } from './Banners'
import { ResultDetailsLoader } from './ResultDetailsLoader'
import { ResultPeek } from './ResultPeek'
import { CountIn } from './CountIn'
import { Footer, StartReason, handToggles } from './Footer'
import { KEEPS_AHEAD, PracticeMenuItems, type MetronomeRow } from './FooterMenu'
import { ModeButton, ModeChoice, ModeSheet, ModeTitle } from './ModeControl'
import { OtherHandSheet } from './OtherHandSheet'
import { RepeatOptions, RepeatPanel } from './RepeatPanel'
import { ScoreSkeleton } from './ScoreSkeleton'
import { TempoSheet } from './TempoSheet'
import { useBrowsedBar } from './browse'
import { useModeFit } from './modeFit'
import { useRecede } from './recede'
import { useReviewInset } from './reviewInset'
import { useOrientation, useStageWidth } from './useOrientation'
import { useStore } from './useStore'
import modeStyles from './ModeControl.module.css'
import styles from './practice.module.css'

export interface PracticeScreenProps {
  readonly env: PracticeEnv
  readonly piece: PieceRecord
  readonly pkg: ScorePackage
  readonly preset?: PracticePreset | undefined
  /** Opens in this mode whatever the piece's own is, which stays as it is (an old study link). */
  readonly openIn?: PracticeMode | undefined
  readonly onTempoSaved: (tempo: UserTempo) => Promise<void>
}

/** How long the Repeat panel stays while it sinks away (matches `--dur-base`). */
export const REPEAT_PANEL_FADE_MS = 200

/** A pointer this close to the fixed cursor line (px either side) reveals the chrome (U13, U14). */
export const CURSOR_REVEAL_PX = 56

/**
 * Is the pointer near the cursor line: the strip's fixed line at one third of the stage's width
 * (U28), or the page's moving cursor in portrait?
 */
function nearCursor(event: PointerEvent, view: StripHandle | null): boolean {
  const el = event.currentTarget
  if (!(el instanceof Element)) return false
  const moving = view?.cursorClientX?.()
  if (moving !== undefined) return Math.abs(event.clientX - moving) <= CURSOR_REVEAL_PX
  const rect = el.getBoundingClientRect()
  return Math.abs(event.clientX - (rect.left + rect.width / 3)) <= CURSOR_REVEAL_PX
}

/** Space kept between Restart loop and the result pill beside it (px). */
const RESTART_GAP_PX = 8

/**
 * Restart loop sits at the start edge of the result dock, beside the centered pill. Where the pill
 * (as wide as its words, in the language shown) leaves it no room there, it moves up above the pill
 * (P11). Measured when the dock, the pill or the button change size or come and go, never on a render.
 */
function useRestartStacked(dock: RefObject<HTMLElement | null>, layout: string): boolean {
  const [stacked, setStacked] = useState(false)
  useEffect(() => {
    const el = dock.current
    if (!el || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return
    const check = () => {
      const restart = el.querySelector(`:scope > .${styles.loopRestart}`)
      const pill = el.querySelector(':scope > [data-testid="attempt-result"]')
      if (!restart || !pill) return setStacked(false)
      const room = pill.getBoundingClientRect().left - el.getBoundingClientRect().left
      setStacked(restart.getBoundingClientRect().width + RESTART_GAP_PX > room)
    }
    const resize = new ResizeObserver(check)
    const follow = () => {
      resize.disconnect()
      resize.observe(el)
      for (const child of Array.from(el.children)) resize.observe(child)
      check()
    }
    const children = new MutationObserver(follow)
    children.observe(el, { childList: true })
    follow()
    return () => {
      resize.disconnect()
      children.disconnect()
    }
  }, [dock, layout])
  return stacked
}

/** In-memory layouts per Practice screen: a few engravings of one piece on the reference tablet. */
const RECENT_LAYOUT_BYTES = 24 * 1024 * 1024

/**
 * Idle time (nothing playing) before the other label room's engraving is prepared ahead, so the
 * first Labels Off ↔ on switch does not wait for it (user). Engraving holds the main thread for
 * seconds on the tablet, so it never starts while something plays, and a run still in flight when
 * playback starts is canceled unless a label switch has adopted it.
 */
export const PREPARE_AHEAD_MS = 1500

/** The idle delay stops doubling after this many canceled runs (1.5 s → 24 s). */
const PREPARE_AHEAD_MAX_DOUBLINGS = 4

/**
 * Idle time before the next run prepared ahead, after `canceled` runs of this screen were canceled.
 * A canceled run starts again from nothing and holds the main thread again, so each cancellation
 * doubles the wait: a learner who keeps touching the screen or the piano between short pauses meets
 * that work a few times, not after every pause.
 */
export function prepareAheadDelay(canceled: number): number {
  return PREPARE_AHEAD_MS * 2 ** Math.min(canceled, PREPARE_AHEAD_MAX_DOUBLINGS)
}

/** A layout being prepared ahead; `adopted` while a label switch waits for it. */
interface AheadRun {
  readonly promise: Promise<PreparedLayout>
  readonly ctrl: AbortController
  adopted: boolean
}

const QUARTER = rat(1, 4)

/** The preparation parameters a mounted view was made with. */
export interface LayoutParamsKey {
  readonly maxChars: number
  readonly mode: 'strip' | 'page'
  readonly pageWidth: number
  readonly room: LabelRoom
  /** The page is capped at its requested width and fitted to the stage (every page, R17). */
  readonly fit: boolean
}

function paramsId(k: LayoutParamsKey): string {
  return `${k.maxChars}|${k.mode}|${k.pageWidth}|${k.room}|${k.fit ? 'fit' : ''}`
}

export function sameParams(a: LayoutParamsKey, b: LayoutParamsKey): boolean {
  return (
    a.maxChars === b.maxChars &&
    a.mode === b.mode &&
    a.pageWidth === b.pageWidth &&
    a.room === b.room &&
    a.fit === b.fit
  )
}

/** The prepare options a layout key means (R17: a fitted page never grows past its width). */
export function prepareOptionsFor(
  key: LayoutParamsKey,
): Pick<PrepareOptions, 'labels' | 'mode' | 'pageWidth' | 'pageMaxWidth'> {
  return {
    labels: { maxChars: key.maxChars, room: key.room },
    ...(key.mode === 'page'
      ? { mode: key.mode, pageWidth: key.pageWidth, ...(key.fit ? { pageMaxWidth: key.pageWidth } : {}) }
      : {}),
  }
}

/** The engraving's room for note names under a Labels mode (DECISIONS R3 revised). */
export function labelRoom(mode: PersistentLabelMode): LabelRoom {
  return mode === 'off' ? 'hints' : 'all'
}

type Prep =
  | { readonly state: 'preparing'; readonly fraction: number }
  | { readonly state: 'ready' }
  | { readonly state: 'error'; readonly message: string }

function pickSettings(): SessionSettings {
  const s = settings.value
  return {
    naming: s.naming,
    labels: s.labels,
    hints: s.hints,
    pedal: s.pedal,
    route: s.route,
    sound: s.sound,
    metronome: s.metronome,
    rhythm: s.rhythm,
    mic: s.mic,
  }
}

/** What the mode a piece opens in depends on. */
function openingEnv(): OpeningEnv {
  const connection = connectionStatus.peek().state
  return {
    pianoConnected: connection === 'connected',
    pianoRemembered: settings.peek().route.inputId !== null,
    midiSupported: connection !== 'unsupported',
  }
}

export function PracticeScreen({ env, piece, pkg, preset, openIn, onTempoSaved }: PracticeScreenProps) {
  const model = useMemo(() => practiceModel(pkg.model, piece.userTempo), [pkg, piece.userTempo])
  const [saver] = useState<PieceSaver>(() =>
    createPieceSaver(async (patch) => (await env.storage()).updatePiece(piece.id, patch), env.timers),
  )
  const [session] = useState(() => {
    const presetRange = preset?.passage ?? null
    // A preset passage opens Repeat mode with that loop (U10). Otherwise Practice opens as the
    // piece was last left (DECISIONS U98): Repeat mode on over the last loop, paused at its start,
    // when it was on; else Repeat closed, reading from the resume position, the last loop
    // remembered for Repeat. The stored resume position is left alone either way.
    const repeat = preset ? presetRange !== null : piece.repeatOpen === true && piece.lastPassage !== null
    const resume = !preset && !repeat && piece.resume ? piece.resume : null
    const multiplier = preset?.multiplier ?? piece.lastMultiplier ?? 1
    const mode = openIn ?? openingMode(piece, openingEnv(), preset !== undefined)
    const created = new PracticeSession(
      {
        pieceId: piece.id,
        model,
        mode,
        selection: {
          hands: learnerHands(preset?.hands ?? piece.lastHands ?? 'both'),
          range: preset ? presetRange : piece.lastPassage,
          multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1,
        },
        settings: pickSettings(),
        startPosition: resume?.position ?? null,
        repeatTarget: piece.repeatTarget,
        ladder: piece.ladder ?? null,
        repeat,
      },
      {
        clock: env.clock,
        timers: env.timers,
        frames: env.frames,
        midi: env.midi(),
        history: {
          queueAttempt: (r) => void env.storage().then((s) => s.history.queueAttempt(r)),
          queueAbandon: (e) => void env.storage().then((s) => s.history.queueAbandon(e)),
        },
        piece: saver,
        timeOrigin: env.timeOrigin,
        createMicFollower: env.createMicFollower ?? createMicFollowerDep,
        micSupported: env.micSupported ?? microphoneSupported,
        ...(env.loadBrowserAudio ? { loadBrowserAudio: env.loadBrowserAudio } : {}),
        ...(env.hasWebAudio ? { hasWebAudio: env.hasWebAudio } : {}),
        ...(env.loadMetronome ? { loadMetronome: env.loadMetronome } : {}),
      },
    )
    if (preset) {
      // The preset wins over the stored state, and becomes it at once (U98): a reload reopens
      // what is on screen (the router does not apply a preset again at boot).
      saver.save(
        {
          lastPassage: created.loop,
          lastHands: created.selection.hands,
          lastMultiplier: created.selection.multiplier,
          repeatOpen: presetRange !== null,
          ...(mode === 'wait' ? { mode } : {}),
        },
        true,
      )
    }
    return created
  })
  const ui = useStore(session.ui)
  const [progressOpen] = useState(() => signal(false))
  const recorder = useRecordingDialog(ui.playing, progressOpen.value)
  const appSettings = settings.value
  const [prep, setPrep] = useState<Prep>({ state: 'preparing', fraction: 0 })
  const [tempoOpen, setTempoOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  /** The start that waits for where the other hand should sound (U149); the sheet is open meanwhile. */
  const [askedStart] = useState(() => signal<(() => void) | null>(null))
  // A phone-size screen: one top bar and a menu sheet instead of the header and footer (U80).
  const phone = usePhone()
  const sideways = usePhoneLandscape()
  const host = useRef<HTMLDivElement>(null)
  const stripRef = useRef<StripHandle | null>(null)
  /** The layout the score view shows: the expanded result card cuts its excerpts from it (U99). */
  const layoutRef = useRef<PreparedLayout | null>(null)
  /** The result whose details are open (U99): kept here so a rotation keeps the card open. */
  const [expandedResult, setExpandedResult] = useState<string | null>(null)
  /** The page's image-zoom magnification (U83), kept across re-engravings, not saved. */
  const magnifyRef = useRef(1)
  /** The press now on the score brought a phone's hidden top bar back: its tap does not seek (U93). */
  const revealOnlyTap = useRef(false)
  const maxChars = maxLabelWidthChars(appSettings.naming)
  // Labels Off engraves tight, with room for hints only; a mode showing names leaves room for all
  // of them (DECISIONS R3 revised).
  const room = labelRoom(appSettings.labels.mode)
  /** What the mounted view was prepared with (a change of `room` alone is a respacing glide). */
  const shown = useRef<LayoutParamsKey | null>(null)
  /** This screen's recent layouts (both label rooms, a rotation), checked before IndexedDB. */
  const recentLayouts = useMemo(() => new MemoryLayoutCache(RECENT_LAYOUT_BYTES), [session])
  /** Layouts prepared ahead (by `paramsId`): in flight, done this session, and how many were canceled. */
  const ahead = useMemo(
    () => ({ running: new Map<string, AheadRun>(), done: new Set<string>(), canceled: 0 }),
    [session],
  )
  /** Restarts the idle delay before the next run prepared ahead (null while none may start). */
  const rearmAhead = useRef<(() => void) | null>(null)
  /**
   * Cancels a run prepared ahead: it leaves nothing behind and starts again after the next idle
   * period, which is longer after every cancellation (`prepareAheadDelay`).
   */
  const cancelAhead = (id: string): void => {
    const run = ahead.running.get(id)
    if (!run) return
    ahead.running.delete(id)
    ahead.canceled++
    run.ctrl.abort()
  }
  /** Prepares (or loads from memory / IndexedDB) the layout for `key`. */
  const prepareLayoutFor = async (
    key: LayoutParamsKey,
    opts: Pick<PrepareOptions, 'signal' | 'onProgress'> = {},
  ): Promise<PreparedLayout> => {
    const storage = await env.storage().catch(() => null)
    return env.prepare(
      storage,
      { ...model, renderXml: pkg.renderXml },
      { ...opts, ...prepareOptionsFor(key) },
      recentLayouts,
    )
  }
  const lastOcc = model.occurrences.length - 1
  const browsed = useBrowsedBar(host, stripRef, lastOcc, env.frames)
  // The strip's review after a pass keeps the result card's height free under the score (U97).
  const resultDock = useRef<HTMLDivElement>(null)
  const topOverlays = useRef<HTMLDivElement>(null)
  // Portrait shows the page (systems, moving cursor), landscape the strip (DECISIONS "Portrait
  // page mode"). The page is engraved for the stage width at its own zoom (`view.pageZoom`).
  const mode = useOrientation() === 'portrait' ? 'page' : 'strip'
  const reviewInset = useReviewInset(resultDock, topOverlays, stripRef, mode)
  const restartStacked = useRestartStacked(resultDock, mode)
  const stageWidth = useStageWidth(host)
  // Every page is capped at the width it was engraved for and fitted to the stage, so the whole
  // system shows and the page never scrolls sideways (R17). A phone's page pinches like a photo
  // without re-engraving (U83), so it is always engraved at zoom 1: a page zoom saved before U83
  // (or on a wider screen) does not apply there.
  const fit = mode === 'page'
  const phonePage = phone && mode === 'page'
  const pageZoom = phonePage ? 1 : appSettings.view.pageZoom
  const pageWidth = mode === 'page' && stageWidth > 0 ? pageWidthFor(stageWidth, pageZoom) : 0
  // The chrome recedes while something plays; an interruption or pause brings it back (U13).
  // The phone's menu sheet is modal: it closes when playback starts, and with the layout it
  // belongs to.
  useEffect(() => {
    if (ui.playing || !phone) setMenuOpen(false)
  }, [ui.playing, phone])
  // Focus mode waits for the review to end (U102), even when Repeat at Ready counts as playing.
  const recede = useRecede(ui.playing && !ui.reviewing, env.timers)
  // In Listen the controls stay where they are (U72). Only the cursor's repeat button goes.
  const receded = recede.receded && ui.mode !== 'listen'
  // Focus mode hides the top bar of a phone only (U93): a tablet's or desktop's header has room to
  // stay, faded when upright (U147). While recording, a phone on its side keeps Stop and the status
  // pills in its bar; an upright phone has them in its footer.
  const recordingInBar = phone && sideways && recorder.showing
  const barInert = receded && !recordingInBar
  const header = useRef<HTMLElement>(null)
  /** The press now on the header brought its receded mode control back: its click changes nothing. */
  const revealOnlyPress = useRef(false)
  const headerRevealTap = useRef(false)
  const fits = useModeFit(header, !phone)
  // An upright phone gives the Repeat controls a row of their own that folds away while playing;
  // elsewhere they float over the score (U14, U80, revised 15 November 2026). Their options open
  // in a sheet on a phone, which closes when playback starts, like the menu.
  const dockedRepeat = phone && !sideways
  const [repeatOptionsOpen, setRepeatOptionsOpen] = useState(false)
  useEffect(() => {
    if (ui.playing || !phone || !ui.repeat) setRepeatOptionsOpen(false)
  }, [ui.playing, phone, ui.repeat])
  // Leaving Repeat mode (U14): the panel sinks away over the loop it had before it unmounts.
  const repeatPresence = useFadePresence(ui.repeat, REPEAT_PANEL_FADE_MS)
  const lastRange = useRef(ui.range)
  if (ui.range) lastRange.current = ui.range

  // While playing, the cursor's repeat button goes with focus mode (U14).
  useEffect(() => session.setChromeRevealed(!recede.receded), [session, recede.receded])

  // Session lifetime: settings, label hook, page visibility, orientation, cleanup.
  useEffect(() => {
    const offLabels = onBeforeApplyLabels((next) => {
      session.beforeApplyLabels(next)
      // Names about to show on the tight engraving stay hidden until the roomy one glides in.
      if (shown.current?.room === 'hints' && labelRoom(next.mode) === 'all') stripRef.current?.holdLabels?.(true)
    })
    const offLanguage = effect(() => {
      messageLanguage()
      untracked(() => session.refreshLanguage())
    })
    const offSettings = settings.subscribe(() => session.updateSettings(pickSettings()))
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        session.suspend()
        void saver.flush()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Safari does not reliably report a reload as hidden: the page hide writes pending state too.
    const onPageHide = () => {
      session.suspend()
      void saver.flush()
    }
    window.addEventListener('pagehide', onPageHide)
    // Settings (with the piano setup), the other-hand question and Progress open over Practice: keys
    // belong to them while they are open (the test notes may come back as keys).
    const offOverlay = effect(() =>
      session.holdInput(settingsOpen.value || askedStart.value !== null || progressOpen.value),
    )
    // Without a connected piano, Wait and Keep time cannot start, and Follow uses the microphone.
    const offInput = effect(() => session.setInputAvailable(connectionStatus.value.state === 'connected'))
    const portrait = typeof matchMedia === 'function' ? matchMedia('(orientation: portrait)') : null
    const onOrientation = () => session.viewChanged()
    portrait?.addEventListener?.('change', onOrientation)
    return () => {
      offLabels()
      offSettings()
      offLanguage()
      offOverlay()
      offInput()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      portrait?.removeEventListener?.('change', onOrientation)
      session.dispose()
      saver.dispose()
    }
  }, [session, saver])

  // Layout: cached → instant; otherwise OSMD prepares it. A label-width or label-room change
  // re-prepares, so does a rotation (strip ↔ page) and, in portrait, a page width change (stage
  // size, page zoom). The session restores the position, loop and hands on `attachStrip`. A
  // change of the label room alone keeps the current view until the new engraving is ready, then
  // glides the notes to their new places around the cursor (R3 revised).
  useEffect(() => {
    const el = host.current
    if (!el) return
    const key: LayoutParamsKey = { maxChars, mode, pageWidth, room, fit }
    const was = stripRef.current ? shown.current : null
    if (was && sameParams(was, key)) {
      // Back to what is shown (a quick Off → on → Off): nothing to prepare.
      stripRef.current?.holdLabels?.(false)
      return
    }
    const respace = !!was && sameParams(was, { ...key, room: was.room })
    if (respace) session.layoutChanging(true)
    else {
      session.layoutChanging()
      stripRef.current?.destroy()
      stripRef.current = null
      shown.current = null
    }
    // The page waits for the stage's first measurement (its width decides the systems).
    if (mode === 'page' && pageWidth <= 0) return
    let live = true
    const ctrl = new AbortController()
    if (!respace) setPrep({ state: 'preparing', fraction: 0 })
    // Already being prepared ahead: wait for that instead of engraving it a second time. Adopted,
    // the run is the learner's own request: playback starting no longer cancels it.
    const adopted = ahead.running.get(paramsId(key))
    if (adopted) adopted.adopted = true
    const prepareHere = () =>
      prepareLayoutFor(key, {
        signal: ctrl.signal,
        onProgress: (_stage, fraction) => live && !respace && setPrep({ state: 'preparing', fraction }),
      })
    void (async () => {
      try {
        let layout: PreparedLayout
        if (!adopted) layout = await prepareHere()
        else {
          try {
            layout = await adopted.promise
          } catch (e) {
            // Canceled after all (never by playback): engrave it here instead of failing.
            if (!live || !adopted.ctrl.signal.aborted) throw e
            layout = await prepareHere()
          }
        }
        ahead.done.add(paramsId(key))
        if (!live) return
        // A rapid reversal starts from the current glide's visible destination, never from
        // hidden notation partway through it. A newer choice cancels this pending replacement.
        const old = stripRef.current
        if (respace) await old?.whenRespaced?.()
        if (!live) return
        const snapshot = respace ? (old?.respaceSnapshot?.(layout) ?? null) : null
        old?.destroy()
        // Turned sideways (or a wider stage): the next phone page starts fitted again.
        if (!phonePage) magnifyRef.current = 1
        const strip = env.createStrip(
          el,
          layout,
          {
            initialZoom: mode === 'page' ? (phonePage ? 1 : settings.peek().view.pageZoom) : settings.peek().view.zoom,
            fitWidth: fit,
            // A phone's page zooms like a photo (U83); a re-engraved page keeps the magnification,
            // a rotation or a new visit starts fitted again.
            imageZoom: phonePage,
            initialMagnify: phonePage ? magnifyRef.current : 1,
            onMagnify: (m) => {
              magnifyRef.current = m
            },
            // Browsing while something plays holds it and drops that attempt (U41); the release
            // continues from the note under the cursor line (U95).
            onBrowse: (browsing) => {
              if (browsing) session.browseStarted()
              browsed.onBrowse(browsing)
            },
            onBrowseRelease: () => void session.browseReleased(),
            // A tap seeks, except the one that brought a phone's hidden top bar back (U93).
            onSeekRequest: (occ) => {
              if (revealOnlyTap.current) revealOnlyTap.current = false
              else session.seek(occ)
            },
            // The dragged playhead lands on a note; practice continues from there (U23).
            onCursorSeek: (position) => session.seekPosition(position),
            cursorDragLabel: (position) => positionText(model, position),
            onLoopChange: (range) => session.setSelection({ range }),
            // The repeat button on the cursor pauses and loops the bar it is over: the bar under
            // the strip's fixed cursor line while browsing, else the cursor's bar (U14).
            onCursorAction: (occ) => session.repeatAtCursor(occ),
            onVisibleLabels: (added) => session.onVisibleLabels(added),
            // Strip: a CSS scale. Page: a new page width, so the layout is re-prepared (above).
            onZoomChange: (zoom) => {
              updateSettings({ view: mode === 'page' ? { pageZoom: zoom } : { zoom } })
              session.viewChanged()
            },
          },
          mode,
        )
        stripRef.current = strip
        layoutRef.current = layout
        shown.current = key
        // Measured against the new view's root (and followed from now on), then handed to it.
        reviewInset.attach()
        session.attachStrip(strip)
        strip.respaceFrom?.(snapshot)
        setPrep({ state: 'ready' })
      } catch (e) {
        if (live)
          setPrep({ state: 'error', message: e instanceof Error ? e.message : msg('The score could not be drawn.') })
      }
    })()
    return () => {
      live = false
      ctrl.abort()
      // A run still in flight goes back to the runs prepared ahead, under their rule (below).
      if (adopted) adopted.adopted = false
    }
  }, [session, maxChars, mode, pageWidth, room, fit, phonePage])

  // Prepare the other label room ahead once nothing has played for a moment, so the first switch
  // of Labels Off ↔ on glides at once instead of waiting for an engraving (user). Its engraving is
  // seconds of main-thread work on the tablet, so it must never run during playback: a run not
  // adopted by a label switch (above) is canceled when something starts playing or when the
  // parameters it was started for no longer apply (it stops at the adapter's next stage
  // boundary), and starts again after the next idle period (longer each time, `prepareAheadDelay`).
  useEffect(() => {
    const other: LayoutParamsKey = { maxChars, mode, pageWidth, room: room === 'all' ? 'hints' : 'all', fit }
    const id = paramsId(other)
    for (const [runId, run] of [...ahead.running]) if (!run.adopted && (ui.playing || runId !== id)) cancelAhead(runId)
    if (prep.state !== 'ready' || ui.playing) return
    if (mode === 'page' && pageWidth <= 0) return
    const start = () => {
      if (ahead.done.has(id) || ahead.running.has(id)) return
      const ctrl = new AbortController()
      const run: AheadRun = { promise: prepareLayoutFor(other, { signal: ctrl.signal }), ctrl, adopted: false }
      ahead.running.set(id, run)
      const settled = (done: boolean) => () => {
        if (ahead.running.get(id) !== run) return
        ahead.running.delete(id)
        if (done) ahead.done.add(id)
      }
      run.promise.then(settled(true), settled(false))
    }
    let timer: unknown
    // (Re)starts the idle delay: on entering this state, and on every input (below).
    const arm = () => {
      if (timer !== undefined) env.timers.clearTimeout(timer)
      timer = ahead.done.has(id) ? undefined : env.timers.setTimeout(start, prepareAheadDelay(ahead.canceled))
    }
    rearmAhead.current = arm
    if (!ahead.done.has(id) && !ahead.running.has(id)) arm()
    return () => {
      if (timer !== undefined) env.timers.clearTimeout(timer)
      if (rearmAhead.current === arm) rearmAhead.current = null
    }
  }, [session, prep.state, ui.playing, maxChars, mode, pageWidth, room, fit])

  // The learner's intent cancels a run not adopted at once, in the same task as the input: waiting
  // for `ui.playing` (the session's async start, its frame, a render, the effect flush) let whole
  // engraving stages run into playback. Pointer and keyboard input on the screen (except on the
  // menu that switches labels, whose switch adopts the run) also postpones the next run; a key on
  // the piano only aborts (the MIDI path stays O(small)) and re-arms if it canceled something.
  // Leaving Practice (or another piece's session) cancels every run, adopted or not.
  useEffect(() => {
    const cancelIdle = (): boolean => {
      let canceled = false
      for (const [id, run] of [...ahead.running]) {
        if (run.adopted) continue
        ahead.running.delete(id)
        ahead.canceled++
        run.ctrl.abort()
        canceled = true
      }
      return canceled
    }
    const onInput = (e: Event) => {
      const target = e.target as Partial<Element> | null
      if (target?.closest?.(`[${KEEPS_AHEAD}]`)) return
      cancelIdle()
      rearmAhead.current?.()
    }
    document.addEventListener('pointerdown', onInput, true)
    document.addEventListener('keydown', onInput, true)
    const offMidi = env.midi().subscribe(() => {
      if (ahead.running.size && cancelIdle()) rearmAhead.current?.()
    })
    return () => {
      document.removeEventListener('pointerdown', onInput, true)
      document.removeEventListener('keydown', onInput, true)
      offMidi()
      for (const run of ahead.running.values()) run.ctrl.abort()
      ahead.running.clear()
    }
  }, [ahead])

  // Leaving Practice (or another piece's session): the view goes with it.
  useEffect(
    () => () => {
      session.layoutChanging()
      stripRef.current?.destroy()
      stripRef.current = null
      shown.current = null
    },
    [session],
  )

  const openRecorder = () => {
    if (recorder.busy) return
    if (session.ui.get().playing) session.pause()
    setMenuOpen(false)
    void recorder.open(env.storage, {
      pieceId: piece.id,
      title: piece.title,
      model,
      env,
      hands: ui.hands,
      range: ui.repeat ? ui.range : null,
    })
  }
  const openProgress = () => {
    setMenuOpen(false)
    progressOpen.value = true
  }
  const closeProgress = () => {
    progressOpen.value = false
  }
  const practiceSuggestion = (s: Suggestion) => {
    closeProgress()
    // As a suggestion opens from the Library, except that Wait and Keep time always stay.
    const mode = isPractice(ui.mode) ? ui.mode : openingMode({ mode: ui.mode, lastHands: ui.hands }, openingEnv(), true)
    session.practiceBars(s.passage, learnerHands(s.hands), s.multiplier, mode)
  }
  const tempo = model.tempo
  const startPos = passageBounds(model, ui.range).start
  const source = hasTempo(tempo) ? effectiveTempoAt(tempo, startPos, 1) : null

  // The menu's Metronome switch (DECISIONS U87, P20): edits the preference the current mode uses.
  const metronome: MetronomeRow = {
    on: !ui.metronomeMuted && metronomeOn(appSettings.metronome, ui.metronomeScope),
    disabled: ui.metronomeMuted || source === null || env.hasWebAudio?.() === false,
    ...(ui.metronomeMuted ? { note: msg('Silent while the microphone follows.') } : {}),
  }
  const onMetronome = (on: boolean) => {
    // Inside the tap: iPadOS starts an AudioContext only during a gesture.
    if (on) env.primeAudio?.()
    updateSettings(metronomePatch(ui.metronomeScope, on))
  }

  const scorePlayback = {
    on: appSettings.rhythm.scorePlayback,
    volume: appSettings.rhythm.scorePlaybackVolume,
    onToggle(on: boolean) {
      if (on) env.primeAudio?.()
      updateSettings({ rhythm: { scorePlayback: on } })
    },
    onVolume(volume: number) {
      updateSettings({ rhythm: { scorePlaybackVolume: volume } })
    },
  }

  const onLabels = (mode: PersistentLabelMode) => {
    applyLabelSettings({ ...settings.peek().labels, mode })
  }
  // The app plays in Listen, the learner in the other modes: Play there, else Start or Resume.
  const resumes =
    ui.mode === 'follow'
      ? ui.phase === 'paused'
      : ui.activity === 'reading' &&
        (ui.phase === 'paused' || ui.interruption?.reason === 'disconnect') &&
        ui.startAction !== 'scored'
  const playLabel = ui.playing
    ? msg('Pause')
    : ui.mode === 'listen'
      ? msg('Play')
      : resumes
        ? msg('Resume')
        : msg('Start')
  const playDisabled = !ui.playing && !ui.startEnabled && !ui.otherHand && ui.activity !== 'listening'
  // One hand, and the app does not know where the other should sound: the press asks first (U149).
  const asking = (start: () => void) => () => {
    if (ui.otherHand && !ui.playing) askedStart.value = start
    else start()
  }
  const onPlayPause = asking(() => session.togglePlay())
  const startAsked = () => {
    const start = askedStart.peek()
    // Keys are the session's again before it starts, still inside the tap.
    askedStart.value = null
    start?.()
  }
  // The disconnect banner is about a piano the mode is played on (U71): not in Listen, and not in
  // Follow over the microphone. While it shows it is the only word about the piano.
  const disconnected = ui.inputDisconnected && ui.mode !== 'listen' && !(ui.mode === 'follow' && ui.follow === 'mic')
  const startReason = disconnected ? null : <StartReason ui={ui} phone={phone} onConnect={openConnection} />
  const onMode = (next: PracticeMode) => session.setMode(next)
  const modeButton = { mode: ui.mode, open: modeOpen, onOpen: () => setModeOpen(true) }

  const back = (
    <button
      type="button"
      class={phone ? `${styles.iconButton} ${styles.recedes}` : styles.iconButton}
      aria-label={msg('Back to Library')}
      onClick={() => navigate('library')}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  )
  const titleText = (
    <div class={styles.titleText}>
      <h1 class={styles.title}>{piece.title}</h1>
      {piece.composer ? <p class={styles.subtitle}>{piece.composer}</p> : null}
    </div>
  )
  const hands = (
    <HandToggles
      {...handToggles(ui, session)}
      playing={ui.playing}
      onPlayPause={onPlayPause}
      playLabel={playLabel}
      playDisabled={playDisabled}
      handClass={styles.recedes}
      compact
    />
  )

  const restartLoop =
    ui.canRestartLoop && prep.state === 'ready' && !(ui.lastResult && expandedResult === ui.lastResult.id) ? (
      <button type="button" class={`pn-score-action ${styles.loopRestart}`} onClick={() => void session.restartLoop()}>
        <Icon name="restart" size={18} />
        <span>{msg('Restart loop')}</span>
      </button>
    ) : null

  const detailsOf = (result: AttemptSummary) => ({
    session,
    result,
    model,
    naming: appSettings.naming,
    pieceId: piece.id,
    layout: layoutRef.current,
    goal: ui.repeat ? ui.repeatTarget : null,
  })
  const resultDockEl = (
    <div
      ref={resultDock}
      class={mode === 'page' ? styles.resultRow : styles.resultDock}
      data-testid="result-dock"
      data-mode={mode}
      data-stack={restartStacked || undefined}
    >
      {mode === 'strip' ? restartLoop : null}
      <AttemptResult
        ui={ui}
        model={model}
        naming={appSettings.naming}
        phone={phone}
        onRestart={() => void session.again()}
        onLoop={() => session.loopRoughBars()}
        // The details open in place over Practice (U99): nothing here leaves the screen.
        details={(r, actions) => <ResultDetailsLoader key={r.id} {...detailsOf(r)} actions={actions} />}
        peek={(r, state) => <ResultPeek {...detailsOf(r)} {...state} />}
        onDismiss={() => session.dismissResult()}
        expandedId={expandedResult}
        onExpandedChange={(id) => {
          if (id !== null) session.openResultDetails(id)
          setExpandedResult(id)
        }}
      />
    </div>
  )

  return (
    <div
      class={styles.screen}
      data-activity={ui.activity}
      data-phase={ui.phase ?? ''}
      data-mode={ui.mode}
      data-recede={receded ? 'true' : undefined}
      data-recording-header={recordingInBar || undefined}
      data-compact={phone ? 'true' : undefined}
      data-sideways={sideways ? 'true' : undefined}
    >
      {phone ? (
        // The phone's top bar (U80). In focus mode it slides up, fades and its row collapses (U93),
        // the overview with it on its side; a tap on the score brings it back without seeking.
        // The connection status is in the menu.
        <div class={styles.headerSlot} data-testid="practice-bar-slot">
          <div class={styles.headerClip}>
            <div class={styles.bar} data-testid="practice-bar" inert={barInert} {...recede.zone}>
              {back}
              {sideways ? (
                <>
                  <h1 class={styles.srOnly}>{piece.title}</h1>
                  <OverviewBar session={session} model={model} range={ui.range} view={stripRef} inline />
                  <ModeButton {...modeButton} class={`${styles.barMode} ${styles.recedes}`} />
                </>
              ) : (
                <>
                  <h1 class={styles.srOnly}>{piece.title}</h1>
                  <ModeTitle {...modeButton} title={piece.title} class={`${styles.barTitle} ${styles.recedes}`} />
                </>
              )}
              {hands}
              {recorder.controls(openRecorder, sideways)}
              <button
                type="button"
                class={`${styles.iconButton} ${styles.recedes}`}
                aria-label={msg('Menu')}
                data-keeps-ahead
                title={msg('Menu')}
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
              >
                <Icon name="menu" size={22} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        // A tablet's or desktop's header keeps its place in focus mode: there is room. Upright, its
        // contents fade (U147); a take in progress keeps its controls and the connection pill.
        <header
          ref={header}
          class={styles.header}
          data-testid="practice-header"
          data-modes={fits.modes ? 'all' : 'one'}
          data-fades={mode === 'page' || undefined}
          data-recording={recorder.showing || undefined}
          {...recede.zone}
          // The touch that brings a faded header back must not also press what it uncovers; a take's
          // own controls never fade, so they act at once. The mode control guards its own press.
          onPointerDownCapture={(event) => {
            const kept = (event.target as Element).closest('button') !== null
            revealOnlyPress.current = receded
            headerRevealTap.current = mode === 'page' && receded && !kept
          }}
          onClickCapture={(event) => {
            if (headerRevealTap.current) event.stopPropagation()
            headerRevealTap.current = false
          }}
        >
          <div class={styles.titleBlock}>
            {back}
            {titleText}
          </div>
          {/* The mode dims with the footer's tools while playing, and a brush then changes nothing: the
              press brings it back before a touch's click arrives (a key's click has no detail). */}
          <div
            class={`${styles.modes} ${styles.recedes}`}
            data-testid="practice-modes"
            inert={receded}
            onClickCapture={(event) => {
              if (revealOnlyPress.current && event.detail > 0) event.stopPropagation()
              revealOnlyPress.current = false
            }}
          >
            <div class={modeStyles.choice} data-mode-choice data-measure={fits.modes ? undefined : ''}>
              <div>
                <ModeChoice mode={ui.mode} onMode={onMode} />
              </div>
            </div>
            {fits.modes ? null : <ModeButton {...modeButton} />}
          </div>
          <div class={styles.headerTools} data-header-tools>
            {recorder.controls(openRecorder)}
            <ConnectionChip dot={!fits.chip} />
            <button
              type="button"
              class={`${styles.iconButton} ${styles.settingsButton}`}
              aria-label={msg('Settings')}
              title={msg('Settings')}
              onClick={openSettings}
            >
              <Icon name="settings" size={22} />
            </button>
          </div>
        </header>
      )}

      {sideways ? null : <OverviewBar session={session} model={model} range={ui.range} view={stripRef} />}

      {dockedRepeat && repeatPresence.mounted ? (
        <div
          class={styles.repeatSlot}
          data-testid="repeat-slot"
          data-leaving={repeatPresence.phase === 'leaving' || undefined}
          inert={receded}
          {...recede.zone}
        >
          <div class={styles.repeatSlotClip}>
            <RepeatPanel
              session={session}
              model={model}
              loop={ui.range ?? lastRange.current}
              hands={ui.hands}
              repeatTarget={ui.repeatTarget}
              multiplier={ui.multiplier}
              ladder={ui.ladder}
              browsedOcc={browsed.occ}
              zone={recede.zone}
              layout="docked"
              playing={ui.playing}
              onOpenOptions={() => setRepeatOptionsOpen(true)}
              optionsOpen={repeatOptionsOpen}
              leaving={repeatPresence.phase === 'leaving'}
            />
          </div>
        </div>
      ) : null}

      <div
        class={styles.stage}
        data-repeat-bounds
        // A pointer near the cursor line, or a tap anywhere, leaves focus mode (U13, U14); on a
        // phone any press does, since the hidden bar holds Pause (U93). The events still reach
        // the strip, but on a phone a tap that brings the hidden bar back does not seek (U93 e):
        // set in the capture phase, before the view's own handlers, for its tap on release.
        onPointerDownCapture={() => {
          revealOnlyTap.current = phone && ui.playing && receded
        }}
        onPointerMove={(event) => {
          if (ui.playing && nearCursor(event, stripRef.current)) recede.zone.onPointerMove()
        }}
        onPointerDown={(event) => {
          if (!ui.playing) return
          if (phone || event.pointerType === 'touch' || nearCursor(event, stripRef.current)) recede.zone.onPointerDown()
        }}
      >
        <div ref={host} class={styles.stripHost} data-testid="strip-host" data-mode={mode} />
        {prep.state === 'preparing' ? <ScoreSkeleton mode={mode} fraction={prep.fraction} /> : null}
        {prep.state === 'error' ? (
          <div class={styles.preparing} role="alert">
            {prep.message}
          </div>
        ) : null}
        <StageCue session={session} />
        <CountIn beats={ui.countIn} />
        {phone ? startReason : null}
        <div ref={topOverlays} class={styles.banners}>
          {repeatPresence.mounted && !dockedRepeat ? (
            <RepeatPanel
              session={session}
              model={model}
              loop={ui.range ?? lastRange.current}
              hands={ui.hands}
              repeatTarget={ui.repeatTarget}
              multiplier={ui.multiplier}
              ladder={ui.ladder}
              browsedOcc={browsed.occ}
              zone={recede.zone}
              layout={phone ? 'compact' : 'float'}
              playing={ui.playing}
              onOpenOptions={() => setRepeatOptionsOpen(true)}
              optionsOpen={repeatOptionsOpen}
              leaving={repeatPresence.phase === 'leaving'}
            />
          ) : null}
          <Banners
            ui={{ ...ui, inputDisconnected: disconnected }}
            onRestart={asking(() => session.restart())}
            onResume={asking(() => session.resume())}
            onConnection={() => navigate('connection')}
          />
        </div>
        {/* The strip docks its result above the footer. The page's result sits outside the score. */}
        {mode === 'strip' ? resultDockEl : restartLoop}
      </div>
      {/* The page scrolls under anything over it: there the result takes a row of its own. */}
      {mode === 'page' ? resultDockEl : null}

      <GuidePanel session={session} fadeMs={appSettings.hints.fadeMs} naming={appSettings.naming} />

      {phone ? (
        <>
          {sideways ? null : recorder.phoneFooter}
          <div class={styles.safeBottom} />
        </>
      ) : (
        <Footer
          onProgress={openProgress}
          onRecord={openRecorder}
          recordingOpen={recorder.isOpen}
          recordDisabled={recorder.busy}
          ui={ui}
          session={session}
          zone={recede.zone}
          receded={receded}
          onPlayPause={onPlayPause}
          playLabel={playLabel}
          playDisabled={playDisabled}
          startReason={startReason}
          tempo={source}
          labels={appSettings.labels.mode}
          onLabels={onLabels}
          onNoteRules={openNoteRules}
          onRequestTempo={() => setTempoOpen(true)}
          scorePlayback={scorePlayback}
          metronome={metronome}
          onMetronome={onMetronome}
        />
      )}

      <Sheet
        title={msg('Repeat options')}
        floating
        open={phone && ui.repeat && repeatOptionsOpen}
        onClose={() => setRepeatOptionsOpen(false)}
      >
        <RepeatOptions session={session} repeatTarget={ui.repeatTarget} multiplier={ui.multiplier} ladder={ui.ladder} />
      </Sheet>

      <OtherHandSheet
        open={askedStart.value !== null}
        sound={ui.otherHand ?? { piano: false, device: false }}
        hand={ui.hands === 'right' ? 'left' : 'right'}
        testNotes={env.testNotes ?? (async () => null)}
        onPiano={startAsked}
        onDevice={() => {
          env.primeAudio?.()
          updateSettings({ sound: { destination: 'browser' } })
          pushNotice({
            kind: 'info',
            text: msg('The app’s sound now comes from this device. You can change it in Settings.'),
          })
          startAsked()
        }}
        onHelp={() => {
          askedStart.value = null
          openConnection()
        }}
        onClose={() => {
          askedStart.value = null
        }}
      />

      <ModeSheet mode={ui.mode} onMode={onMode} open={modeOpen} onClose={() => setModeOpen(false)} />

      <Sheet title={msg('Menu')} untitled floating open={phone && menuOpen} onClose={() => setMenuOpen(false)}>
        <div class={styles.menu}>
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>{msg('Speed')}</span>
            <TempoControl
              multiplier={ui.multiplier}
              sourceBeatBpm={source?.beatBpm ?? 0}
              beatUnit={source?.beatUnit ?? QUARTER}
              onChange={(multiplier) => session.setSelection({ multiplier })}
              noTempo={source === null}
              onRequestTempo={() => {
                setMenuOpen(false)
                setTempoOpen(true)
              }}
              placement="down"
            />
          </div>
          <PracticeMenuItems
            onProgress={openProgress}
            onRecord={openRecorder}
            recordDisabled={recorder.busy}
            ui={ui}
            session={session}
            labels={appSettings.labels.mode}
            onLabels={onLabels}
            onNoteRules={() => {
              setMenuOpen(false)
              openNoteRules()
            }}
            hasTempo={source !== null}
            scorePlayback={scorePlayback}
            metronome={metronome}
            onMetronome={onMetronome}
            showKeys={!sideways}
            rowClass={styles.menuRow}
            labelClass={styles.menuLabel}
            toggleClass={styles.menuToggle}
          />
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>{msg('Piano')}</span>
            <ConnectionChip
              onOpen={() => {
                setMenuOpen(false)
                navigate('connection')
              }}
            />
          </div>
          <div class={styles.menuActions}>
            <Button
              icon="settings"
              onClick={() => {
                setMenuOpen(false)
                openSettings()
              }}
            >
              {msg('Settings')}
            </Button>
          </div>
        </div>
      </Sheet>

      <ProgressSheet
        open={progressOpen.value}
        onClose={closeProgress}
        pieceId={piece.id}
        storage={env.storage}
        model={model}
        onPractice={practiceSuggestion}
        onOpenSettings={() => {
          closeProgress()
          openSettings()
        }}
      />

      <WrongNoteFlash onReady={(handle) => session.attachFlash(handle)} />
      {recorder.dialog}
      <TempoSheet
        open={tempoOpen}
        onClose={() => setTempoOpen(false)}
        onSave={async (t) => {
          setTempoOpen(false)
          await onTempoSaved(t)
        }}
      />
    </div>
  )
}
