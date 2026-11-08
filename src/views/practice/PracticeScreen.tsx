/**
 * The practice screen (spec "Practice screen"; DECISIONS U1–U14): a header that blends into the
 * background (back, title, connection, Settings), the full-width score overview (which never
 * recedes), the
 * full-width notation stage with its overlays (Repeat panel in Repeat mode, banners, correction cue), the
 * keyboard-guide panel and the footer (Speed | hand toggles around Start / Pause / Listen |
 * Menu). While playing, the chrome recedes (U13).
 *
 * On a phone-size screen (`usePhone`, U80) there is no header and no footer: one top bar holds
 * Back, the title (or, with the phone on its side, the piece overview), the hand toggles around
 * Start and a Menu button whose sheet holds Speed, Note names, Play through, Keep time, Show keys
 * (not on its side: no keyboard guide there), the connection status and Settings. The score takes the rest, and in portrait the page is engraved
 * to the stage's width and fitted to it (R17).
 *
 * The `PracticeSession` owns every live behavior; this component only wires it to Preact and
 * re-renders on its coarse `ui` store. Per-frame state (cursor, correction cue, keyboard guide) goes to
 * small subscribed children.
 */
import { createMicFollowerDep } from '../../app/audio/micFollower'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { effect } from '@preact/signals'
import {
  connectionOpen,
  navigate,
  openResults,
  openSettings,
  settingsOpen,
  type PracticePreset,
} from '../../app/navigation'
import {
  PracticeSession,
  createPieceSaver,
  practiceModel,
  type PieceSaver,
  type SessionSettings,
} from '../../app/session'
import {
  applyLabelSettings,
  connectionStatus,
  onBeforeApplyLabels,
  pushNotice,
  settings,
  updateSettings,
} from '../../app/state'
import { passageBounds, positionText } from '../../core/model/passage'
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
import { usePhone, usePhoneLandscape } from '../shared/usePhone'
import { pageWidthFor } from '../../render/page/geometry'
import type { LabelRoom, PreparedLayout, PrepareOptions } from '../../render'
import { MemoryLayoutCache } from '../../render/cache'
import type { PracticeEnv, StripHandle } from './env'
import { GuidePanel, OverviewBar, StageCue } from './live'
import { Banners } from './Banners'
import { CountIn } from './CountIn'
import { Footer, HANDS_UNAVAILABLE, HANDS_UNAVAILABLE_NOTICE } from './Footer'
import { PracticeMenuItems } from './FooterMenu'
import { RepeatPanel } from './RepeatPanel'
import { ScoreSkeleton } from './ScoreSkeleton'
import { TempoSheet } from './TempoSheet'
import { useBrowsedBar } from './browse'
import { useRecede } from './recede'
import { useOrientation, useStageWidth } from './useOrientation'
import { useStore } from './useStore'
import styles from './practice.module.css'

export interface PracticeScreenProps {
  readonly env: PracticeEnv
  readonly piece: PieceRecord
  readonly pkg: ScorePackage
  readonly autoStart?: boolean | undefined
  readonly onAutoStart?: (() => void) | undefined
  readonly preset?: PracticePreset | undefined
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

/** In-memory layouts per Practice screen: a few engravings of one piece on the reference tablet. */
const RECENT_LAYOUT_BYTES = 24 * 1024 * 1024

/**
 * Idle time (nothing playing) before the other label room's engraving is prepared ahead, so the
 * first Labels Off ↔ on switch does not wait for it (user). Engraving holds the main thread for a
 * moment, so it never starts while something plays; once started it runs to the end.
 */
export const PREPARE_AHEAD_MS = 1500

const QUARTER = rat(1, 4)

/** The preparation parameters a mounted view was made with. */
export interface LayoutParamsKey {
  readonly maxChars: number
  readonly mode: 'strip' | 'page'
  readonly pageWidth: number
  readonly room: LabelRoom
  /** The page is capped at its requested width and fitted to the stage (a phone, R17). */
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

/** The prepare options a layout key means (R17: a phone's page never grows past its width). */
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

export function PracticeScreen({ env, piece, pkg, preset, autoStart, onAutoStart, onTempoSaved }: PracticeScreenProps) {
  const model = useMemo(() => practiceModel(pkg.model, piece.userTempo), [pkg, piece.userTempo])
  const [saver] = useState<PieceSaver>(() =>
    createPieceSaver(async (patch) => (await env.storage()).updatePiece(piece.id, patch), env.timers),
  )
  const [session] = useState(() => {
    const presetRange = preset?.passage ?? null
    // Practice opens with Repeat closed (reading from the resume position); the last loop is
    // remembered for Repeat. A preset passage opens Repeat mode with that loop (U10).
    const resume = !preset && piece.resume ? piece.resume : null
    const multiplier = preset?.multiplier ?? piece.lastMultiplier ?? 1
    return new PracticeSession(
      {
        pieceId: piece.id,
        model,
        selection: {
          hands: preset?.hands ?? piece.lastHands ?? 'both',
          range: preset ? presetRange : piece.lastPassage,
          multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1,
        },
        settings: pickSettings(),
        startPosition: resume?.position ?? null,
        repeatTarget: piece.repeatTarget,
        ladder: piece.ladder ?? null,
        rhythm: piece.rhythm === true,
        repeat: presetRange !== null,
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
        createMicFollower: createMicFollowerDep,
        ...(env.loadBrowserAudio ? { loadBrowserAudio: env.loadBrowserAudio } : {}),
        ...(env.hasWebAudio ? { hasWebAudio: env.hasWebAudio } : {}),
        ...(env.loadMetronome ? { loadMetronome: env.loadMetronome } : {}),
      },
    )
  })
  const ui = useStore(session.ui)
  const appSettings = settings.value
  const [prep, setPrep] = useState<Prep>({ state: 'preparing', fraction: 0 })
  const [tempoOpen, setTempoOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // A phone-size screen: one top bar and a menu sheet instead of the header and footer (U80).
  const phone = usePhone()
  const sideways = usePhoneLandscape()
  const host = useRef<HTMLDivElement>(null)
  const stripRef = useRef<StripHandle | null>(null)
  /** The page's image-zoom magnification (U83), kept across re-engravings, not saved. */
  const magnifyRef = useRef(1)
  const autoStarted = useRef(false)
  const maxChars = maxLabelWidthChars(appSettings.naming)
  // Labels Off engraves tight, with room for hints only; a mode showing names leaves room for all
  // of them (DECISIONS R3 revised).
  const room = labelRoom(appSettings.labels.mode)
  /** What the mounted view was prepared with (a change of `room` alone is a respacing glide). */
  const shown = useRef<LayoutParamsKey | null>(null)
  /** This screen's recent layouts (both label rooms, a rotation), checked before IndexedDB. */
  const recentLayouts = useMemo(() => new MemoryLayoutCache(RECENT_LAYOUT_BYTES), [session])
  /** Layouts prepared ahead (by `paramsId`): in flight, and done this session. */
  const ahead = useMemo(
    () => ({ running: new Map<string, Promise<PreparedLayout>>(), done: new Set<string>() }),
    [session],
  )
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
  // Portrait shows the page (systems, moving cursor), landscape the strip (DECISIONS "Portrait
  // page mode"). The page is engraved for the stage width at its own zoom (`view.pageZoom`).
  const mode = useOrientation() === 'portrait' ? 'page' : 'strip'
  const stageWidth = useStageWidth(host)
  // A phone's page opens fitted to the stage's width, never scrolling sideways (R17), and a
  // pinch magnifies it like a photo without re-engraving (U83), so it is always engraved at
  // zoom 1: a page zoom saved before U83 (or on a wider screen) does not apply.
  const fit = phone && mode === 'page'
  const pageZoom = fit ? 1 : appSettings.view.pageZoom
  const pageWidth = mode === 'page' && stageWidth > 0 ? pageWidthFor(stageWidth, pageZoom) : 0
  // The chrome recedes while something plays; an interruption or pause brings it back (U13).
  // The phone's menu sheet is modal: it closes when playback starts, and with the layout it
  // belongs to.
  useEffect(() => {
    if (ui.playing || !phone) setMenuOpen(false)
  }, [ui.playing, phone])
  const recede = useRecede(ui.playing, env.timers)
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
    const offSettings = settings.subscribe(() => session.updateSettings(pickSettings()))
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        session.suspend()
        void saver.flush()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Settings and Connection open over Practice: keys belong to them while they are open.
    const offOverlay = effect(() => session.holdInput(settingsOpen.value || connectionOpen.value))
    // Without a connected piano the learner cannot play a hand: Listen only (U27).
    const offInput = effect(() => session.setInputAvailable(connectionStatus.value.state === 'connected'))
    const portrait = typeof matchMedia === 'function' ? matchMedia('(orientation: portrait)') : null
    const onOrientation = () => session.viewChanged()
    portrait?.addEventListener?.('change', onOrientation)
    return () => {
      offLabels()
      offSettings()
      offOverlay()
      offInput()
      document.removeEventListener('visibilitychange', onVisibility)
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
    void (async () => {
      try {
        // Already being prepared ahead: wait for that instead of engraving it a second time.
        const layout = await (ahead.running.get(paramsId(key)) ??
          prepareLayoutFor(key, {
            signal: ctrl.signal,
            onProgress: (_stage, fraction) => live && !respace && setPrep({ state: 'preparing', fraction }),
          }))
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
        if (!fit) magnifyRef.current = 1
        const strip = env.createStrip(
          el,
          layout,
          {
            initialZoom: mode === 'page' ? (fit ? 1 : settings.peek().view.pageZoom) : settings.peek().view.zoom,
            fitWidth: fit,
            // A phone's page zooms like a photo (U83); a re-engraved page keeps the magnification,
            // a rotation or a new visit starts fitted again.
            imageZoom: fit,
            initialMagnify: fit ? magnifyRef.current : 1,
            onMagnify: (m) => {
              magnifyRef.current = m
            },
            returnLabel: 'Return to current position',
            // Browsing while something plays stops it and drops that attempt (U41).
            onBrowse: (browsing) => {
              if (browsing) session.browseStarted()
              browsed.onBrowse(browsing)
            },
            onSeekRequest: (occ) => session.seek(occ),
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
        shown.current = key
        session.attachStrip(strip)
        strip.respaceFrom?.(snapshot)
        setPrep({ state: 'ready' })
      } catch (e) {
        if (live) setPrep({ state: 'error', message: e instanceof Error ? e.message : 'The score could not be drawn.' })
      }
    })()
    return () => {
      live = false
      ctrl.abort()
    }
  }, [session, maxChars, mode, pageWidth, room, fit])

  // Prepare the other label room ahead once nothing has played for a moment, so the first switch
  // of Labels Off ↔ on glides at once instead of waiting for an engraving (user).
  useEffect(() => {
    if (prep.state !== 'ready' || ui.playing) return
    if (mode === 'page' && pageWidth <= 0) return
    const other: LayoutParamsKey = { maxChars, mode, pageWidth, room: room === 'all' ? 'hints' : 'all', fit }
    const id = paramsId(other)
    if (ahead.done.has(id) || ahead.running.has(id)) return
    const timer = env.timers.setTimeout(() => {
      const run = prepareLayoutFor(other)
      ahead.running.set(id, run)
      run.then(
        () => {
          ahead.running.delete(id)
          ahead.done.add(id)
        },
        () => ahead.running.delete(id),
      )
    }, PREPARE_AHEAD_MS)
    return () => env.timers.clearTimeout(timer)
  }, [session, prep.state, ui.playing, maxChars, mode, pageWidth, room, fit])

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

  // Add to library starts once the score is ready. Consume the request so history navigation
  // cannot start it again, and never retry automatically after a pause or an output failure.
  useEffect(() => {
    if (!autoStart || autoStarted.current || prep.state !== 'ready' || !ui.startEnabled) return
    autoStarted.current = true
    onAutoStart?.()
    void session.start()
  }, [autoStart, prep.state, ui.startEnabled, session, onAutoStart])

  const tempo = model.tempo
  const startPos = passageBounds(model, ui.range).start
  const source = hasTempo(tempo) ? effectiveTempoAt(tempo, startPos, 1) : null

  const onLabels = (mode: PersistentLabelMode) => {
    applyLabelSettings({ ...settings.peek().labels, mode })
  }
  // Play-through (DECISIONS P12) uses reading's words: Start, Pause, Resume when paused mid-piece.
  const playLabel =
    ui.activity === 'playing'
      ? ui.playing
        ? 'Pause'
        : ui.phase === 'paused'
          ? 'Resume'
          : 'Start'
      : ui.playing && ui.activity === 'listening'
        ? 'Pause'
        : ui.activity === 'listening'
          ? 'Play'
          : ui.playing
            ? 'Pause'
            : ui.startAction === 'listen'
              ? 'Listen'
              : ui.activity === 'reading' &&
                  (ui.phase === 'paused' || ui.interruption?.reason === 'disconnect') &&
                  ui.startAction !== 'scored'
                ? 'Resume'
                : 'Start'

  const back = (
    <button
      type="button"
      class={phone ? `${styles.iconButton} ${styles.recedes}` : styles.iconButton}
      aria-label="Back to Library"
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
      hands={ui.hands}
      onHandsChange={(hands) => session.setSelection({ hands })}
      handsUnavailable={ui.handsAvailable ? undefined : HANDS_UNAVAILABLE}
      onHandsUnavailable={() => pushNotice({ kind: 'info', text: HANDS_UNAVAILABLE_NOTICE })}
      playing={ui.playing}
      onPlayPause={() => session.togglePlay()}
      playLabel={playLabel}
      playDisabled={!ui.playing && !ui.startEnabled && ui.activity !== 'listening'}
      handClass={styles.recedes}
      compact
    />
  )

  return (
    <div
      class={styles.screen}
      data-activity={ui.activity}
      data-phase={ui.phase ?? ''}
      data-recede={recede.receded ? 'true' : undefined}
      data-compact={phone ? 'true' : undefined}
      data-sideways={sideways ? 'true' : undefined}
    >
      {phone ? (
        // The phone's top bar (U80). It never collapses: the overview (on its side) and Start /
        // Pause live here; the other controls dim with the chrome and a tap brings them back.
        // The connection status is in the menu.
        <div class={styles.bar} data-testid="practice-bar" {...recede.zone}>
          {back}
          {sideways ? (
            <>
              <h1 class={styles.srOnly}>{piece.title}</h1>
              <OverviewBar session={session} model={model} range={ui.range} view={stripRef} inline />
            </>
          ) : (
            titleText
          )}
          {hands}
          <button
            type="button"
            class={`${styles.iconButton} ${styles.menuButton} ${styles.recedes}`}
            aria-label="Menu"
            title="Menu"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Icon name="menu" size={22} />
            {ui.rhythm ? (
              <span class={styles.menuBadge} data-testid="keep-time-badge" aria-hidden="true">
                <Icon name="metronome" size={12} />
              </span>
            ) : null}
          </button>
        </div>
      ) : (
        <div class={styles.headerSlot} data-testid="practice-header-slot">
          <div class={styles.headerClip}>
            <header class={styles.header} inert={recede.receded} {...recede.zone}>
              <div class={styles.titleBlock}>
                {back}
                {titleText}
              </div>
              <div class={styles.headerTools}>
                <ConnectionChip compact="narrow" />
                <button
                  type="button"
                  class={styles.iconButton}
                  aria-label="Settings"
                  title="Settings"
                  onClick={openSettings}
                >
                  <Icon name="settings" size={22} />
                </button>
              </div>
            </header>
          </div>
        </div>
      )}

      {sideways ? null : <OverviewBar session={session} model={model} range={ui.range} view={stripRef} />}

      <div
        class={styles.stage}
        // A pointer near the cursor line, or a tap anywhere, leaves focus mode (U13, U14). The
        // events still reach the strip.
        onPointerMove={(event) => {
          if (ui.playing && nearCursor(event, stripRef.current)) recede.zone.onPointerMove()
        }}
        onPointerDown={(event) => {
          if (!ui.playing) return
          if (event.pointerType === 'touch' || nearCursor(event, stripRef.current)) recede.zone.onPointerDown()
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
        {phone && !ui.playing && ui.startReason ? (
          <p class={styles.stageNote} role="note">
            {ui.startReason}
          </p>
        ) : null}
        <div class={styles.banners}>
          {repeatPresence.mounted ? (
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
              leaving={repeatPresence.phase === 'leaving'}
            />
          ) : null}
          <Banners
            ui={ui}
            onRestart={() => session.restart()}
            onResume={() => session.resume()}
            onResults={(attemptId) => openResults({ pieceId: piece.id, attemptId })}
            onDismissResult={() => session.dismissResult()}
            onConnection={() => navigate('connection')}
          />
        </div>
      </div>

      <GuidePanel session={session} fadeMs={appSettings.hints.fadeMs} naming={appSettings.naming} />

      {phone ? (
        <div class={styles.safeBottom} />
      ) : (
        <Footer
          ui={ui}
          session={session}
          zone={recede.zone}
          receded={recede.receded}
          playLabel={playLabel}
          tempo={source}
          labels={appSettings.labels.mode}
          onLabels={onLabels}
          onRequestTempo={() => setTempoOpen(true)}
        />
      )}

      <Sheet title="Menu" untitled floating open={phone && menuOpen} onClose={() => setMenuOpen(false)}>
        <div class={styles.menu}>
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>Speed</span>
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
            ui={ui}
            session={session}
            labels={appSettings.labels.mode}
            onLabels={onLabels}
            hasTempo={source !== null}
            showKeys={!sideways}
            rowClass={styles.menuRow}
            labelClass={styles.menuLabel}
            toggleClass={styles.menuToggle}
          />
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>Piano</span>
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
              Settings
            </Button>
          </div>
        </div>
      </Sheet>

      <WrongNoteFlash onReady={(handle) => session.attachFlash(handle)} />
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
