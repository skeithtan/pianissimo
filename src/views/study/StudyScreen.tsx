/**
 * The Study screen (DECISIONS U72): the score and its playback, nothing to practice. A
 * header (back, title, Settings), the whole-piece overview, the notation stage (the landscape
 * strip or the portrait page, as in Practice), the keyboard-guide slot and a footer: Note names,
 * the "Name the notes at the cursor" hint and Show keys, then Speed, Go to the start and Play /
 * Pause.
 *
 * On a phone-size screen (`usePhone`, U74) there is no footer at all: the header carries Play /
 * Pause and a menu button, and every other control (Speed, Note names, Show keys, the hint, Go to
 * the start, Settings) is in the untitled menu sheet, so the score and the keyboard guide get the
 * height. A phone on its side (`usePhoneLandscape`, U80) goes further: the overview sits in the
 * header in place of the title, there is no keyboard guide and no Show keys, and in portrait the
 * page is engraved to the stage's width and fitted to it (R17).
 *
 * It runs a `PracticeSession` in Listen (hands 'none') with no history and no piece writes, so
 * a phone with no piano and no Web MIDI plays the piece through browser sound (S3, S4) and the
 * practice state of the piece (resume position, hands, loop) is never touched. No Repeat mode, no
 * loop handles, no cursor repeat button, no corrections, no receding chrome: the controls stay
 * where the fingers expect them on a small screen.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { navigate, openSettings } from '../../app/navigation'
import { PracticeSession, practiceModel, type SessionSettings } from '../../app/session'
import { applyLabelSettings, onBeforeApplyLabels, pushNotice, settings, updateSettings } from '../../app/state'
import { passageBounds, positionText } from '../../core/model/passage'
import type { ScorePackage } from '../../core/model/score'
import type { PersistentLabelMode } from '../../core/model/settings'
import { effectiveTempoAt, hasTempo } from '../../core/music/tempo'
import { rat } from '../../core/music/rational'
import { maxLabelWidthChars } from '../../core/naming'
import type { PieceRecord, UserTempo } from '../../core/storage/records'
import type { PrepareOptions, PreparedLayout } from '../../render'
import { MemoryLayoutCache } from '../../render/cache'
import { pageWidthFor } from '../../render/page/geometry'
import { Button, Segmented, Sheet, Toggle } from '../../ui/controls'
import { Icon, type IconName } from '../../ui/icons'
import { TempoControl } from '../../ui/TempoControl'
import type { PracticeEnv, StripHandle } from '../practice/env'
import { GuidePanel, OverviewBar } from '../practice/live'
import { labelRoom, prepareOptionsFor, sameParams, type LayoutParamsKey } from '../practice/PracticeScreen'
import { ScoreSkeleton } from '../practice/ScoreSkeleton'
import { TempoSheet } from '../practice/TempoSheet'
import { useOrientation, useStageWidth } from '../practice/useOrientation'
import { useStore } from '../practice/useStore'
import { usePhone, usePhoneLandscape } from '../shared/usePhone'
import styles from './study.module.css'

export interface StudyScreenProps {
  readonly env: PracticeEnv
  readonly piece: PieceRecord
  readonly pkg: ScorePackage
  readonly onTempoSaved: (tempo: UserTempo) => Promise<void>
}

/** The toast when the Hint button finds no note at the cursor (past the end of the piece). */
export const NO_NOTES_HERE = 'No notes at the cursor to name.'

const LABEL_OPTIONS = [
  { value: 'off', label: 'Off', title: 'No persistent note names' },
  { value: 'conditional', label: 'Conditional', title: 'Name notes outside your chosen range' },
  { value: 'all', label: 'All', title: 'Name every note' },
] as const

const QUARTER = rat(1, 4)

/** In-memory layouts per Study screen (both label rooms, a rotation). */
const RECENT_LAYOUT_BYTES = 24 * 1024 * 1024

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

/** Icon-only footer tool: the name is the accessible label and the tooltip. */
function Tool({
  icon,
  label,
  pressed,
  disabled,
  onClick,
}: {
  icon: IconName
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class={styles.tool}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={24} />
    </button>
  )
}

export function StudyScreen({ env, piece, pkg, onTempoSaved }: StudyScreenProps) {
  const model = useMemo(() => practiceModel(pkg.model, piece.userTempo), [pkg, piece.userTempo])
  const [session] = useState(
    () =>
      new PracticeSession(
        {
          pieceId: piece.id,
          model,
          // Listen over the whole piece from its start; the piece's practice state is not read.
          selection: { hands: 'none', range: null, multiplier: 1 },
          settings: pickSettings(),
          startPosition: null,
          repeat: false,
          cursorAction: false,
        },
        {
          clock: env.clock,
          timers: env.timers,
          frames: env.frames,
          midi: env.midi(),
          // Studying records nothing and changes nothing about the piece (U72).
          history: { queueAttempt: () => undefined, queueAbandon: () => undefined },
          piece: { save: () => undefined },
          timeOrigin: env.timeOrigin,
          ...(env.loadBrowserAudio ? { loadBrowserAudio: env.loadBrowserAudio } : {}),
          ...(env.hasWebAudio ? { hasWebAudio: env.hasWebAudio } : {}),
          ...(env.loadMetronome ? { loadMetronome: env.loadMetronome } : {}),
        },
      ),
  )
  const ui = useStore(session.ui)
  const appSettings = settings.value
  const [prep, setPrep] = useState<Prep>({ state: 'preparing', fraction: 0 })
  const [tempoOpen, setTempoOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const phone = usePhone()
  const sideways = usePhoneLandscape()
  const host = useRef<HTMLDivElement>(null)
  const stripRef = useRef<StripHandle | null>(null)
  /** The page's image-zoom magnification (U83), kept across re-engravings, not saved. */
  const magnifyRef = useRef(1)
  const maxChars = maxLabelWidthChars(appSettings.naming)
  const room = labelRoom(appSettings.labels.mode)
  const shown = useRef<LayoutParamsKey | null>(null)
  const recentLayouts = useMemo(() => new MemoryLayoutCache(RECENT_LAYOUT_BYTES), [session])
  const mode = useOrientation() === 'portrait' ? 'page' : 'strip'
  const stageWidth = useStageWidth(host)
  // A phone's page opens fitted to the stage's width, never scrolling sideways (R17), and a
  // pinch magnifies it like a photo without re-engraving (U83), so it is always engraved at
  // zoom 1: a page zoom saved before U83 (or on a wider screen) does not apply.
  const fit = phone && mode === 'page'
  const pageZoom = fit ? 1 : appSettings.view.pageZoom
  const pageWidth = mode === 'page' && stageWidth > 0 ? pageWidthFor(stageWidth, pageZoom) : 0

  // Session lifetime: settings, label hook, page visibility, orientation, cleanup.
  useEffect(() => {
    const offLabels = onBeforeApplyLabels((next) => {
      session.beforeApplyLabels(next)
      if (shown.current?.room === 'hints' && labelRoom(next.mode) === 'all') stripRef.current?.holdLabels?.(true)
    })
    const offSettings = settings.subscribe(() => session.updateSettings(pickSettings()))
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') session.suspend()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const portrait = typeof matchMedia === 'function' ? matchMedia('(orientation: portrait)') : null
    const onOrientation = () => session.viewChanged()
    portrait?.addEventListener?.('change', onOrientation)
    return () => {
      offLabels()
      offSettings()
      document.removeEventListener('visibilitychange', onVisibility)
      portrait?.removeEventListener?.('change', onOrientation)
      session.dispose()
    }
  }, [session])

  // Layout: cached → instant; otherwise OSMD prepares it. Re-prepared on a label-width or
  // label-room change, a rotation (strip ↔ page) and, in portrait, a page width change. A change
  // of the label room alone keeps the current view until the new engraving is ready, then glides
  // the notes to their new places (R3 revised), exactly as Practice does.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const key: LayoutParamsKey = { maxChars, mode, pageWidth, room, fit }
    const was = stripRef.current ? shown.current : null
    if (was && sameParams(was, key)) {
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
    if (mode === 'page' && pageWidth <= 0) return
    let live = true
    const ctrl = new AbortController()
    if (!respace) setPrep({ state: 'preparing', fraction: 0 })
    void (async () => {
      try {
        const storage = await env.storage().catch(() => null)
        const options: PrepareOptions = {
          signal: ctrl.signal,
          onProgress: (_stage, fraction) => live && !respace && setPrep({ state: 'preparing', fraction }),
          ...prepareOptionsFor(key),
        }
        const layout: PreparedLayout = await env.prepare(
          storage,
          { ...model, renderXml: pkg.renderXml },
          options,
          recentLayouts,
        )
        if (!live) return
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
            // Browsing while the piece plays pauses it (U41).
            onBrowse: (browsing) => {
              if (browsing) session.browseStarted()
            },
            onSeekRequest: (occ) => session.seek(occ),
            onCursorSeek: (position) => session.seekPosition(position),
            cursorDragLabel: (position) => positionText(model, position),
            onVisibleLabels: (added) => session.onVisibleLabels(added),
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

  // Leaving Study (or another piece's session): the view goes with it.
  useEffect(
    () => () => {
      session.layoutChanging()
      stripRef.current?.destroy()
      stripRef.current = null
      shown.current = null
    },
    [session],
  )

  const tempo = model.tempo
  const startPos = passageBounds(model, null).start
  const source = hasTempo(tempo) ? effectiveTempoAt(tempo, startPos, 1) : null
  const onLabels = (next: PersistentLabelMode) => applyLabelSettings({ ...settings.peek().labels, mode: next })
  const playLabel = ui.playing ? 'Pause' : 'Play'
  const onHint = () => {
    if (!session.revealAtCursor()) pushNotice({ kind: 'info', text: NO_NOTES_HERE })
  }
  const toStart = () => {
    session.seek(0)
    stripRef.current?.returnToCurrent()
  }
  // A menu left open across a rotation onto a larger layout has nothing to belong to.
  useEffect(() => {
    if (!phone) setMenuOpen(false)
  }, [phone])

  const speed = (placement: 'up' | 'down') => (
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
      placement={placement}
    />
  )
  const noteNames = (
    <Segmented<PersistentLabelMode>
      label="Note names on the score"
      value={appSettings.labels.mode}
      options={LABEL_OPTIONS}
      onChange={onLabels}
      compact
    />
  )
  const keysLabel = ui.keyboardVisible ? 'Hide keys' : 'Show keys'
  const toggleKeys = () => session.setKeyboardVisible(!ui.keyboardVisible)
  const playDisabled = !ui.playing && !ui.startEnabled
  const status = !ui.playing && ui.startReason ? ui.startReason : ui.soundStatus

  return (
    <div
      class={styles.screen}
      data-testid="study-screen"
      data-playing={ui.playing ? 'true' : 'false'}
      data-compact={phone ? 'true' : undefined}
      data-sideways={sideways ? 'true' : undefined}
    >
      <header class={styles.header}>
        <div class={styles.titleBlock}>
          <button
            type="button"
            class={styles.iconButton}
            aria-label="Back to Library"
            onClick={() => navigate('library')}
          >
            <Icon name="back" size={22} />
          </button>
          {sideways ? (
            <>
              <h1 class={styles.srOnly}>{piece.title}</h1>
              <OverviewBar session={session} model={model} range={null} view={stripRef} inline />
            </>
          ) : (
            <div class={styles.titleText}>
              <h1 class={styles.title}>{piece.title}</h1>
              {piece.composer ? <p class={styles.subtitle}>{piece.composer}</p> : null}
            </div>
          )}
        </div>
        {phone ? (
          <div class={styles.headerTools}>
            <button
              type="button"
              class={styles.headerPlay}
              aria-label={playLabel}
              title={playLabel}
              disabled={playDisabled}
              onClick={() => session.togglePlay()}
            >
              <Icon name={ui.playing ? 'pause' : 'play'} size={22} />
            </button>
            <button
              type="button"
              class={styles.iconButton}
              aria-label="Menu"
              title="Menu"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Icon name="menu" size={22} />
            </button>
          </div>
        ) : (
          <button type="button" class={styles.iconButton} aria-label="Settings" title="Settings" onClick={openSettings}>
            <Icon name="settings" size={22} />
          </button>
        )}
      </header>

      {sideways ? null : <OverviewBar session={session} model={model} range={null} view={stripRef} />}

      <div class={styles.stage}>
        <div ref={host} class={styles.stripHost} data-testid="strip-host" data-mode={mode} />
        {prep.state === 'preparing' ? <ScoreSkeleton mode={mode} fraction={prep.fraction} /> : null}
        {prep.state === 'error' ? (
          <div class={styles.preparing} role="alert">
            {prep.message}
          </div>
        ) : null}
        {phone && status ? (
          <p class={styles.stageNote} role="status">
            {status}
          </p>
        ) : null}
      </div>

      <GuidePanel session={session} fadeMs={appSettings.hints.fadeMs} naming={appSettings.naming} />

      {phone ? (
        <div class={styles.safeBottom} />
      ) : (
        <footer class={styles.footer}>
          <div class={styles.tools}>
            <div class={styles.labels}>
              {noteNames}
              <span class={styles.toolCaption} aria-hidden="true">
                Note names
              </span>
            </div>
            <Tool icon="hint" label="Name the notes at the cursor" onClick={onHint} />
            <Tool icon="keys" label={keysLabel} pressed={ui.keyboardVisible} onClick={toggleKeys} />
          </div>
          <div class={styles.transport}>
            {speed('up')}
            <Tool icon="restart" label="Go to the start" onClick={toStart} />
            <button
              type="button"
              class={styles.play}
              aria-label={playLabel}
              title={playLabel}
              disabled={playDisabled}
              onClick={() => session.togglePlay()}
            >
              <Icon name={ui.playing ? 'pause' : 'play'} size={32} />
            </button>
          </div>
          {!ui.playing && ui.startReason ? (
            <p class={styles.note} role="note">
              {ui.startReason}
            </p>
          ) : null}
          {ui.soundStatus ? (
            <p class={styles.note} role="status">
              {ui.soundStatus}
            </p>
          ) : null}
        </footer>
      )}

      <Sheet title="Menu" untitled floating open={phone && menuOpen} onClose={() => setMenuOpen(false)}>
        <div class={styles.menu}>
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>Speed</span>
            {speed('down')}
          </div>
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>Note names</span>
            {noteNames}
          </div>
          {sideways ? null : (
            <Toggle
              class={`${styles.menuRow} ${styles.menuToggle}`}
              label="Show keys"
              checked={ui.keyboardVisible}
              onChange={(on) => session.setKeyboardVisible(on)}
            />
          )}
          <div class={styles.menuActions}>
            <Button
              icon="hint"
              onClick={() => {
                setMenuOpen(false)
                onHint()
              }}
            >
              Name the notes at the cursor
            </Button>
            <Button
              icon="restart"
              onClick={() => {
                setMenuOpen(false)
                toStart()
              }}
            >
              Go to the start
            </Button>
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
