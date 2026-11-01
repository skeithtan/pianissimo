/**
 * The practice screen (spec "Practice screen"; DECISIONS U1–U14): a header that blends into the
 * background (back, title, connection, Settings), the full-width score overview (which never
 * recedes), the
 * full-width notation stage with its overlays (Repeat panel in Repeat mode, banners, correction cue), the
 * keyboard-guide panel and the footer (Repeat, Speed | hand toggles around Start / Pause /
 * Listen | Labels, Hint, Show keys). While playing, the chrome recedes (U13).
 *
 * The `PracticeSession` owns every live behavior; this component only wires it to Preact and
 * re-renders on its coarse `ui` store. Per-frame state (cursor, correction cue, keyboard guide) goes to
 * small subscribed children.
 */
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
import { applyLabelSettings, connectionStatus, onBeforeApplyLabels, settings, updateSettings } from '../../app/state'
import { passageBounds, positionText } from '../../core/model/passage'
import type { ScorePackage } from '../../core/model/score'
import type { PersistentLabelMode } from '../../core/model/settings'
import { effectiveTempoAt, hasTempo } from '../../core/music/tempo'
import { maxLabelWidthChars } from '../../core/naming'
import type { PieceRecord, UserTempo } from '../../core/storage/records'
import { useFadePresence } from '../../ui/fade'
import { Icon } from '../../ui/icons'
import { WrongNoteFlash } from '../../ui/WrongNoteFlash'
import { ConnectionChip } from '../shared/ConnectionChip'
import { pageWidthFor } from '../../render/page/geometry'
import type { PracticeEnv, StripHandle } from './env'
import { GuidePanel, OverviewBar, StageCue } from './live'
import { Banners } from './Banners'
import { Footer } from './Footer'
import { RepeatPanel } from './RepeatPanel'
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
        ...(env.loadBrowserAudio ? { loadBrowserAudio: env.loadBrowserAudio } : {}),
        ...(env.hasWebAudio ? { hasWebAudio: env.hasWebAudio } : {}),
        ...(env.loadMetronome ? { loadMetronome: env.loadMetronome } : {}),
      },
    )
  })
  const [resumedFrom] = useState(() => (!preset && piece.resume ? piece.resume.occ : null))
  const ui = useStore(session.ui)
  const appSettings = settings.value
  const [prep, setPrep] = useState<Prep>({ state: 'preparing', fraction: 0 })
  const [tempoOpen, setTempoOpen] = useState(false)
  const [showResume, setShowResume] = useState(resumedFrom !== null)
  const host = useRef<HTMLDivElement>(null)
  const stripRef = useRef<StripHandle | null>(null)
  const autoStarted = useRef(false)
  const maxChars = maxLabelWidthChars(appSettings.naming)
  const lastOcc = model.occurrences.length - 1
  const browsed = useBrowsedBar(host, stripRef, lastOcc, env.frames)
  // Portrait shows the page (systems, moving cursor), landscape the strip (DECISIONS "Portrait
  // page mode"). The page is engraved for the stage width at its own zoom (`view.pageZoom`).
  const mode = useOrientation() === 'portrait' ? 'page' : 'strip'
  const stageWidth = useStageWidth(host)
  const pageWidth = mode === 'page' && stageWidth > 0 ? pageWidthFor(stageWidth, appSettings.view.pageZoom) : 0
  // The chrome recedes while something plays; an interruption or pause brings it back (U13).
  const recede = useRecede(ui.playing, env.timers)
  // Leaving Repeat mode (U14): the panel sinks away over the loop it had before it unmounts.
  const repeatPresence = useFadePresence(ui.repeat, REPEAT_PANEL_FADE_MS)
  const lastRange = useRef(ui.range)
  if (ui.range) lastRange.current = ui.range

  // While playing, the cursor's repeat button goes with focus mode (U14).
  useEffect(() => session.setChromeRevealed(!recede.receded), [session, recede.receded])

  // Session lifetime: settings, label hook, page visibility, orientation, cleanup.
  useEffect(() => {
    const offLabels = onBeforeApplyLabels((next) => session.beforeApplyLabels(next))
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

  // Layout: cached → instant; otherwise OSMD prepares it. A label-width change re-prepares, so
  // does a rotation (strip ↔ page) and, in portrait, a page width change (stage size, page zoom).
  // The session restores the position, loop and hands on `attachStrip`.
  useEffect(() => {
    const el = host.current
    if (!el) return
    // The page waits for the stage's first measurement (its width decides the systems).
    if (mode === 'page' && pageWidth <= 0) return
    let live = true
    const ctrl = new AbortController()
    setPrep({ state: 'preparing', fraction: 0 })
    void (async () => {
      try {
        const storage = await env.storage().catch(() => null)
        const layout = await env.prepare(
          storage,
          { ...model, renderXml: pkg.renderXml },
          {
            labels: { maxChars },
            signal: ctrl.signal,
            onProgress: (_stage, fraction) => live && setPrep({ state: 'preparing', fraction }),
            ...(mode === 'page' ? { mode, pageWidth } : {}),
          },
        )
        if (!live) return
        const strip = env.createStrip(
          el,
          layout,
          {
            initialZoom: mode === 'page' ? settings.peek().view.pageZoom : settings.peek().view.zoom,
            returnLabel: 'Return to current position',
            onBrowse: browsed.onBrowse,
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
        session.attachStrip(strip)
        setPrep({ state: 'ready' })
      } catch (e) {
        if (live) setPrep({ state: 'error', message: e instanceof Error ? e.message : 'The score could not be drawn.' })
      }
    })()
    return () => {
      live = false
      ctrl.abort()
      session.layoutChanging()
      stripRef.current?.destroy()
      stripRef.current = null
    }
  }, [session, maxChars, mode, pageWidth])

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
  const playLabel =
    ui.playing && ui.activity === 'listening'
      ? 'Pause'
      : ui.activity === 'listening'
        ? 'Play'
        : ui.playing
          ? 'Pause'
          : ui.startAction === 'listen'
            ? 'Listen'
            : ui.activity === 'reading' && ui.phase === 'paused' && ui.startAction !== 'scored'
              ? 'Resume'
              : 'Start'

  return (
    <div
      class={styles.screen}
      data-activity={ui.activity}
      data-phase={ui.phase ?? ''}
      data-recede={recede.receded ? 'true' : undefined}
    >
      <header class={styles.header} {...recede.zone}>
        {/* The back button and the piece's title and composer never recede (U13 revised). */}
        <div class={styles.titleBlock}>
          <button
            type="button"
            class={styles.iconButton}
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
          <div class={styles.titleText}>
            <h1 class={styles.title}>{piece.title}</h1>
            {piece.composer ? <p class={styles.subtitle}>{piece.composer}</p> : null}
          </div>
        </div>
        <div class={`${styles.headerTools} ${styles.recedes}`}>
          <ConnectionChip compact="narrow" />
          <button type="button" class={styles.iconButton} aria-label="Settings" title="Settings" onClick={openSettings}>
            <Icon name="settings" size={22} />
          </button>
        </div>
      </header>

      <OverviewBar session={session} model={model} range={ui.range} view={stripRef} />

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
        {prep.state === 'preparing' ? (
          <div class={styles.preparing} role="status" aria-live="polite">
            <span class={styles.spinner} aria-hidden="true" />
            <span>Preparing the score… {prep.fraction > 0 ? `${Math.round(prep.fraction * 100)}%` : ''}</span>
          </div>
        ) : null}
        {prep.state === 'error' ? (
          <div class={styles.preparing} role="alert">
            {prep.message}
          </div>
        ) : null}
        <StageCue session={session} />
        <div class={styles.banners}>
          {repeatPresence.mounted ? (
            <RepeatPanel
              session={session}
              model={model}
              loop={ui.range ?? lastRange.current}
              hands={ui.hands}
              repeatTarget={ui.repeatTarget}
              browsedOcc={browsed.occ}
              zone={recede.zone}
              leaving={repeatPresence.phase === 'leaving'}
            />
          ) : null}
          <Banners
            ui={ui}
            resumedFrom={showResume ? resumedFrom : null}
            model={model}
            onResumeDismiss={() => setShowResume(false)}
            onFromStart={() => {
              setShowResume(false)
              session.seek(0)
            }}
            onRestart={() => session.restart()}
            onResume={() => session.resume()}
            onResults={(attemptId) => openResults({ pieceId: piece.id, attemptId })}
            onDismissResult={() => session.dismissResult()}
            onConnection={() => navigate('connection')}
          />
        </div>
      </div>

      <GuidePanel session={session} fadeMs={appSettings.hints.fadeMs} naming={appSettings.naming} />

      <Footer
        ui={ui}
        session={session}
        zone={recede.zone}
        playLabel={playLabel}
        tempo={source}
        labels={appSettings.labels.mode}
        onLabels={onLabels}
        onRequestTempo={() => setTempoOpen(true)}
      />

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
