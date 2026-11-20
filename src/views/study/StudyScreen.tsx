/**
 * Sheet music (DECISIONS U72, U105, U106): the score, playback and ungraded live following. A
 * header (back, title, Settings), the whole-piece overview, the notation stage (the landscape
 * strip or the portrait page, as in Practice), the keyboard-guide slot and Practice's footer
 * (`FooterBar`, U90): Speed at the start edge, Listen and Follow my playing in the middle,
 * and Menu at the end edge.
 *
 * On a phone-size screen (`usePhone`, U74) the header carries both transport actions and a
 * menu button. Other controls are in the untitled menu sheet, so the score and keyboard guide get the
 * height. A phone on its side (`usePhoneLandscape`, U80) goes further: the overview sits in the
 * header in place of the title, there is no keyboard guide and no Show keys, and in portrait the
 * page is engraved to the stage's width and fitted to it (R17).
 *
 * It runs a `PracticeSession` with no history and no piece writes, so
 * a phone with no piano and no Web MIDI plays the piece through browser sound (S3, S4) and the
 * practice state of the piece (resume position, hands, loop) is never touched. No Repeat mode, no
 * loop handles, no cursor repeat button, no corrections, no receding chrome: the controls stay
 * where the fingers expect them on a small screen.
 */
import { effect } from '@preact/signals'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { createMicFollowerDep, microphoneSupported } from '../../app/audio/micFollower'
import { connectionOpen, navigate, openSettings, settingsOpen } from '../../app/navigation'
import { PracticeSession, metronomeOn, metronomePatch, practiceModel, type SessionSettings } from '../../app/session'
import { applyLabelSettings, connectionStatus, onBeforeApplyLabels, settings, updateSettings } from '../../app/state'
import { passageBounds, positionText } from '../../core/model/passage'
import type { HandSelection, ScorePackage } from '../../core/model/score'
import type { PersistentLabelMode } from '../../core/model/settings'
import { effectiveTempoAt, hasTempo } from '../../core/music/tempo'
import { rat } from '../../core/music/rational'
import { maxLabelWidthChars } from '../../core/naming'
import type { PieceRecord, UserTempo } from '../../core/storage/records'
import type { PrepareOptions, PreparedLayout } from '../../render'
import { MemoryLayoutCache } from '../../render/cache'
import { pageWidthFor } from '../../render/page/geometry'
import { Button, Segmented, Sheet, Toggle } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { TempoControl } from '../../ui/TempoControl'
import type { PracticeEnv, StripHandle } from '../practice/env'
import { FooterBar } from '../practice/Footer'
import { FooterMenuPopover, LABEL_OPTIONS, footerMenuClasses } from '../practice/FooterMenu'
import { GuidePanel, OverviewBar } from '../practice/live'
import { labelRoom, prepareOptionsFor, sameParams, type LayoutParamsKey } from '../practice/PracticeScreen'
import { ScoreSkeleton } from '../practice/ScoreSkeleton'
import { TempoSheet } from '../practice/TempoSheet'
import { useOrientation, useStageWidth } from '../practice/useOrientation'
import { useStore } from '../practice/useStore'
import { usePhone, usePhoneLandscape } from '../shared/usePhone'
import practiceStyles from '../practice/practice.module.css'
import styles from './study.module.css'

export interface StudyScreenProps {
  readonly env: PracticeEnv
  readonly piece: PieceRecord
  readonly pkg: ScorePackage
  readonly onTempoSaved: (tempo: UserTempo) => Promise<void>
}

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
    mic: s.mic,
  }
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
          createMicFollower: env.createMicFollower ?? createMicFollowerDep,
          micSupported: env.micSupported ?? microphoneSupported,
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
  const [followHands, setFollowHands] = useState<Exclude<HandSelection, 'none'>>('both')
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
    const offInput = effect(() => session.setInputAvailable(connectionStatus.value.state === 'connected'))
    const offOverlay = effect(() => session.holdInput(settingsOpen.value || connectionOpen.value))
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
      offInput()
      offOverlay()
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
            // Browsing while the piece plays holds it until the release (U41, U95).
            onBrowse: (browsing) => {
              if (browsing) session.browseStarted()
            },
            onBrowseRelease: () => void session.browseReleased(),
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
  const listening = ui.playing && !ui.playThrough
  const following = ui.playing && ui.playThrough
  const listenDisabled = !listening && (source === null || (!ui.playThrough && !ui.startEnabled))
  const canFollow = ui.pianoConnected || ui.micSupported
  const followDisabled = !following && (source === null || !canFollow)
  const followTitle = followDisabled
    ? source === null
      ? 'Set a practice tempo to follow your playing'
      : 'Connect a piano or use a device with microphone access'
    : 'Follow my playing'
  const onFollow = () => session.toggleStudyPlayback('follow', followHands)
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
  const followInput = ui.micSupported ? (
    <Segmented
      label="Follow input"
      value={ui.follow}
      options={[
        {
          value: 'piano',
          label: 'Piano',
          title: ui.pianoConnected ? 'Follow the connected piano' : 'Piano not connected',
          disabled: !ui.pianoConnected,
        },
        { value: 'mic', label: 'Microphone', title: 'Follow what this device’s microphone hears' },
      ]}
      onChange={(follow) => updateSettings({ mic: { follow: follow === 'mic' } })}
      compact
    />
  ) : null
  const followHandChoice = canFollow ? (
    <Segmented
      label="Hands to follow"
      value={followHands}
      options={[
        { value: 'both', label: 'Both' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
      ]}
      onChange={(hands) => {
        setFollowHands(hands)
        if (session.ui.get().playThrough) session.setSelection({ hands })
      }}
      compact
    />
  ) : null
  // A following microphone mutes the click so it does not hear the app's own sound.
  const metronomeIsOn = !ui.metronomeMuted && metronomeOn(appSettings.metronome, ui.metronomeScope)
  const metronomeDisabled = ui.metronomeMuted || source === null || env.hasWebAudio?.() === false
  const toggleMetronome = (on: boolean) => {
    // Inside the tap: iPadOS starts an AudioContext only during a gesture.
    if (on) env.primeAudio?.()
    updateSettings(metronomePatch(ui.metronomeScope, on))
  }
  const status = ui.micStatus ?? (!ui.playing && ui.startReason ? ui.startReason : ui.soundStatus)

  return (
    <div
      class={styles.screen}
      data-testid="study-screen"
      data-playing={ui.playing ? 'true' : 'false'}
      data-following={following ? 'true' : 'false'}
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
              aria-label="Listen"
              title="Listen"
              aria-pressed={listening}
              disabled={listenDisabled}
              onClick={() => session.toggleStudyPlayback('listen')}
            >
              <Icon name={listening ? 'pause' : 'play'} size={22} />
            </button>
            <button
              type="button"
              class={styles.iconButton}
              aria-label="Follow my playing"
              title={followTitle}
              aria-pressed={following}
              disabled={followDisabled}
              onClick={onFollow}
            >
              <Icon name={following ? 'pause' : 'flow'} size={22} />
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
        <FooterBar
          start={speed('up')}
          end={
            <FooterMenuPopover label="Sheet music menu">
              <div class={footerMenuClasses.row}>
                <span class={footerMenuClasses.label} aria-hidden="true">
                  Note names
                </span>
                {noteNames}
              </div>
              {followInput ? (
                <div class={footerMenuClasses.row}>
                  <span class={footerMenuClasses.label} aria-hidden="true">
                    Follow input
                  </span>
                  {followInput}
                </div>
              ) : null}
              {followHandChoice ? (
                <div class={footerMenuClasses.row}>
                  <span class={footerMenuClasses.label} aria-hidden="true">
                    Hands to follow
                  </span>
                  {followHandChoice}
                </div>
              ) : null}
              <Toggle
                class={`${footerMenuClasses.row} ${footerMenuClasses.toggle}`}
                label="Metronome"
                checked={metronomeIsOn}
                disabled={metronomeDisabled}
                {...(ui.metronomeMuted ? { description: 'Silent while the microphone follows.' } : {})}
                onChange={toggleMetronome}
              />
              <Toggle
                class={`${footerMenuClasses.row} ${footerMenuClasses.toggle}`}
                label="Show keys"
                checked={ui.keyboardVisible}
                onChange={(on) => session.setKeyboardVisible(on)}
              />
            </FooterMenuPopover>
          }
          center={
            <>
              <div class={styles.transport}>
                <Button
                  variant={following ? 'secondary' : 'primary'}
                  icon={listening ? 'pause' : 'play'}
                  pressed={listening}
                  disabled={listenDisabled}
                  onClick={() => session.toggleStudyPlayback('listen')}
                >
                  Listen
                </Button>
                <Button
                  icon={following ? 'pause' : 'flow'}
                  title={followTitle}
                  pressed={following}
                  disabled={followDisabled}
                  onClick={onFollow}
                >
                  Follow my playing
                </Button>
              </div>
              {status ? (
                <p class={practiceStyles.startReason} role="status">
                  {status}
                </p>
              ) : null}
            </>
          }
        />
      )}

      <Sheet title="Menu" untitled floating open={phone && menuOpen} onClose={() => setMenuOpen(false)}>
        <div class={styles.menu}>
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>Speed</span>
            {speed('down')}
          </div>
          <Toggle
            class={`${styles.menuRow} ${styles.menuToggle}`}
            label="Metronome"
            checked={metronomeIsOn}
            disabled={metronomeDisabled}
            {...(ui.metronomeMuted ? { description: 'Silent while the microphone follows.' } : {})}
            onChange={toggleMetronome}
          />
          <div class={styles.menuRow}>
            <span class={styles.menuLabel}>Note names</span>
            {noteNames}
          </div>
          {followInput ? (
            <div class={styles.menuRow}>
              <span class={styles.menuLabel} aria-hidden="true">
                Follow input
              </span>
              {followInput}
            </div>
          ) : null}
          {followHandChoice ? (
            <div class={styles.menuRow}>
              <span class={styles.menuLabel} aria-hidden="true">
                Hands to follow
              </span>
              {followHandChoice}
            </div>
          ) : null}
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
