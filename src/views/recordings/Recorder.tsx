import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { createPortal } from 'preact/compat'
import { Icon } from '../../ui/icons'
import pill from '../../ui/statusPill.module.css'
import control from './recordingControl.module.css'
import { Button, Sheet } from '../../ui/controls'
import { msg } from '../../i18n/messages'
import { openConnection } from '../../app/navigation'
import { connectionStatus, pushNotice, updateSettings } from '../../app/state'
import { openPerformanceInput, type PerformanceInput } from '../../app/audio/performanceInput'
import { describePassage } from '../../core/model/passage'
import { rememberInput } from '../../core/recording/input'
import { discarded, discardHeld } from './discard'
import { RecordingHistory, handName } from './History'
import { SavedTakePill, savedTakeText } from './SavedTakePill'
import { recorderErrorText } from './errors'
import { beginTake, type TakeTarget } from './take'
import { TAKE_LIMIT_MS, TAKE_WARNING_MS, startTakeClock } from './takeClock'
import type { SavedTake } from './unsaved'
import type { OneTap, TakeActions, TakePhase } from './useRecordingDialog'
import styles from './recordings.module.css'

/** `enabling` and `ready` are the setup sheet's; `opening` is a one-tap take's, without a sheet. */
type Phase = 'setup' | 'enabling' | 'ready' | Exclude<TakePhase, 'setup'>

/**
 * One take, from its setup sheet (or at once, `oneTap`, DECISIONS D20) to its saved pill. It owns
 * the audio input and, until it is saved, the take.
 */
export function Recorder({
  target,
  oneTap,
  onClose,
  onPhase,
  controlsHost,
  covered = false,
  takeActions,
}: {
  target: TakeTarget
  oneTap: OneTap | null
  onClose: () => void
  onPhase: (phase: TakePhase) => void
  controlsHost: HTMLElement | null
  /** Progress or Recordings is open over the score. */
  covered?: boolean
  /** Filled with this take's Stop and Discard, for the menus. */
  takeActions?: { current: TakeActions | null }
}) {
  const [phase, setPhase] = useState<Phase>(oneTap ? 'opening' : 'setup')
  const [saved, setSaved] = useState<SavedTake | null>(null)
  /** The Recordings list, opened from the saved take's pill, which stays under it. */
  const [listOpen, setListOpen] = useState(false)
  const [error, setError] = useState('')
  const [input, setInput] = useState<PerformanceInput | null>(null)
  const [seconds, setSeconds] = useState(0)
  const meter = useRef<HTMLMeterElement>(null)
  const owned = useRef<PerformanceInput | null>(null)
  const request = useRef<AbortController | null>(null)
  const recording = useRef<ReturnType<typeof beginTake> | null>(null)
  const saving = useRef(false)
  const mounted = useRef(true)
  /** Where the take's controls are drawn now (a closure may hold the place before a rotation). */
  const host = useRef(controlsHost)
  host.current = controlsHost
  const stopHadFocus = useRef(false)
  const connection = connectionStatus.value
  const reported: TakePhase = phase === 'enabling' || phase === 'ready' ? 'setup' : listOpen ? 'list' : phase
  useLayoutEffect(() => onPhase(reported), [reported])
  const savedGone = saved !== null && discarded.value.has(saved.info.id)
  useLayoutEffect(() => {
    // Deleted in a list of takes: the pill goes, once the list opened from it has.
    if (savedGone && !listOpen) onClose()
  }, [savedGone, listOpen])
  async function finish(interrupted: boolean) {
    const take = recording.current
    if (!take) return
    recording.current = null
    request.current = null
    saving.current = true
    owned.current = null
    if (mounted.current) {
      stopHadFocus.current = !!host.current?.contains(document.activeElement)
      setPhase('saving')
      setInput(null)
    }
    try {
      const kept = await take.stop(interrupted)
      if (mounted.current) {
        setSaved(kept)
        setPhase('saved')
      }
    } catch {
      pushNotice({
        kind: 'warning',
        text: msg('Recording could not be saved. Open Recordings to download it or retry.'),
      })
      // It exists only in memory: the list, over the score, offers Retry saving and the download.
      if (mounted.current) setPhase('list')
    } finally {
      saving.current = false
    }
  }
  /** Stop, and drop the take unless Undo asks for it. */
  function discard() {
    const take = recording.current
    if (!take) return
    recording.current = null
    request.current = null
    owned.current = null
    discardHeld(target.env.storage, take.discard())
    onClose()
  }
  function release() {
    request.current?.abort()
    request.current = null
    owned.current?.close()
    owned.current = null
  }
  function lost() {
    if (recording.current) {
      void finish(true)
      return
    }
    if (saving.current || (!owned.current && !request.current)) return
    release()
    if (mounted.current) {
      setInput(null)
      setError(msg('Audio input was interrupted.'))
      setPhase('setup')
    }
  }
  // A layout effect: its cleanup runs as the recorder goes, before a late input could start a take.
  useLayoutEffect(() => {
    mounted.current = true
    if (takeActions) takeActions.current = { stop: () => void finish(false), discard }
    const hidden = () => {
      if (document.hidden) lost()
    }
    const leaving = () => {
      if (recording.current) void finish(true)
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', leaving)
    return () => {
      mounted.current = false
      if (takeActions) takeActions.current = null
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', leaving)
      if (recording.current) void finish(true)
      if (!saving.current) release()
    }
  }, [])
  useEffect(() => {
    if (phase !== 'ready' || !input) return
    const t = setInterval(() => {
      if (meter.current) meter.current.value = input.level()
    }, 90)
    return () => clearInterval(t)
  }, [phase, input])
  useEffect(() => {
    if (phase !== 'recording') return
    return startTakeClock(
      () => performance.now(),
      (run, ms) => {
        const t = setInterval(run, ms)
        return () => clearInterval(t)
      },
      {
        tick: setSeconds,
        warn: () =>
          pushNotice({
            kind: 'info',
            text: msg(
              'This take has been recording for {0} minutes. Recording stops automatically at {1} minutes.',
              TAKE_WARNING_MS / 60_000,
              TAKE_LIMIT_MS / 60_000,
            ),
            timeoutMs: 10_000,
          }),
        limit: () => {
          pushNotice({
            kind: 'warning',
            text: msg(
              'Recording stopped automatically at {0} minutes, the longest a take can be. The take is being saved.',
              TAKE_LIMIT_MS / 60_000,
            ),
            timeoutMs: null,
          })
          void finish(false)
        },
      },
    )
  }, [phase])
  useLayoutEffect(() => {
    if (oneTap) void startAtOnce(oneTap)
  }, [])
  /** The remembered input, and only that one, records as soon as it is open. */
  async function startAtOnce({ input: remembered, context }: OneTap) {
    const controller = new AbortController()
    request.current = controller
    try {
      const next = await openPerformanceInput('', lost, controller.signal, { remembered, context })
      if (controller.signal.aborted) {
        next.close()
        return
      }
      owned.current = next
      // The piano may be gone by now. The setup sheet says what to do.
      if (connectionStatus.peek().state !== 'connected') giveUp('')
      else begin(next)
    } catch (e) {
      if (!controller.signal.aborted) giveUp(recorderErrorText(e, owned.current ? 'start' : 'open'))
    }
  }
  /** A one-tap take that could not start: the setup sheet, with the reason, as for a first take. */
  function giveUp(reason: string) {
    release()
    setError(reason)
    setPhase('setup')
  }
  async function open(id = '', preferPiano = false) {
    release()
    const controller = new AbortController()
    request.current = controller
    setError('')
    setPhase('enabling')
    setInput(null)
    try {
      const preferredName = preferPiano && connection.state === 'connected' ? connection.inputName : undefined
      const next = await openPerformanceInput(id, lost, controller.signal, { preferredName })
      if (controller.signal.aborted) {
        next.close()
        return
      }
      owned.current = next
      setInput(next)
      setPhase('ready')
    } catch (e) {
      if (!controller.signal.aborted) {
        request.current = null
        setError(recorderErrorText(e, 'open'))
        setPhase('setup')
      }
    }
  }
  function begin(next: PerformanceInput) {
    recording.current = beginTake(target, next, lost)
    setSeconds(0)
    setPhase('recording')
  }
  function start() {
    const next = owned.current
    if (!next || recording.current) return
    try {
      begin(next)
      // Chosen: the next take starts from it in one tap.
      updateSettings({ recording: rememberInput({ deviceId: next.deviceId, label: next.deviceLabel }) })
    } catch (e) {
      setError(recorderErrorText(e, 'start'))
    }
  }
  const list = (
    <RecordingHistory
      initialId={saved?.info.id}
      storage={target.env.storage}
      pieceId={target.pieceId}
      model={target.model}
      onClose={() => {
        if (listOpen) setListOpen(false)
        else onClose()
      }}
    />
  )
  if (phase === 'list') return list
  if (phase === 'opening' || phase === 'recording' || phase === 'saving' || phase === 'saved')
    return (
      <>
        {/* On the page before the pill is, so that the change is announced. */}
        <span class={styles.announcer} role="status">
          {saved ? savedTakeText(saved.info) : ''}
        </span>
        {saved ? (
          <SavedTakePill
            take={saved}
            host={controlsHost}
            listOpen={listOpen}
            covered={covered}
            takeFocus={stopHadFocus.current}
            onRecordings={() => setListOpen(true)}
            onClose={onClose}
          />
        ) : (
          controlsHost && createPortal(transport(), controlsHost)
        )}
        {listOpen ? list : null}
      </>
    )
  /** The take's place while its input opens, then its timer, Stop and Discard. */
  function transport() {
    if (phase === 'opening')
      return (
        <span
          class={`${pill.pill} ${control.opening}`}
          role="group"
          aria-label={msg('Opening audio input…')}
          aria-busy="true"
        >
          <span class={control.text}>
            <span class={`${pill.dot} ${control.pulse}`} aria-hidden="true" />
            <span class={control.words}>{msg('Opening audio input…')}</span>
          </span>
          <button
            type="button"
            class={`${pill.action} ${control.icon}`}
            aria-label={msg('Cancel')}
            title={msg('Cancel')}
            onClick={() => {
              release()
              onClose()
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </span>
      )
    const savingTake = phase === 'saving'
    return (
      <span
        class={`${pill.pill} ${control.transport}`}
        role="group"
        aria-label={savingTake ? msg('Saving recording…') : msg('Recording')}
      >
        <span class={control.readout}>
          <span class={pill.dot} aria-hidden="true" />
          <span role="timer">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </span>
        </span>
        <button
          type="button"
          class={`${pill.action} ${control.stop}`}
          disabled={savingTake}
          aria-label={msg('Stop recording')}
          title={msg('Stop recording')}
          onClick={() => void finish(false)}
        >
          <Icon name="stop" size={17} />
          <span class={control.label}>{savingTake ? msg('Saving…') : msg('Stop')}</span>
        </button>
        <button
          type="button"
          class={`${pill.action} ${control.icon}`}
          disabled={savingTake}
          aria-label={msg('Discard recording')}
          title={msg('Discard recording')}
          onClick={discard}
        >
          <Icon name="trash" size={18} />
        </button>
      </span>
    )
  }
  return (
    <Sheet open title={msg('Record performance')} onClose={onClose}>
      <div class={styles.setup}>
        <div class={styles.piece}>
          <strong>{target.title}</strong>
          <p>
            {describePassage(target.model, target.range, target.hands)} · {handName(target.hands)}
          </p>
        </div>
        {connection.state !== 'connected' && (
          <div>
            <p role="status">{msg('Connect and select a MIDI piano to record a performance.')}</p>
            <Button
              onClick={() => {
                onClose()
                openConnection()
              }}
            >
              {msg('Connect piano')}
            </Button>
          </div>
        )}
        <div class={styles.source}>
          <p>{msg('Select the piano’s USB audio input to record its own sound. Check the level by playing a note.')}</p>
          {phase === 'ready' && input && (
            <>
              <label>
                {msg('Audio input')}
                <select
                  aria-label={msg('Audio input')}
                  value={input.deviceId}
                  onChange={(e) => void open(e.currentTarget.value)}
                >
                  {!input.devices.some((d) => d.deviceId === input.deviceId) && (
                    <option value={input.deviceId}>{input.label}</option>
                  )}
                  {input.devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || msg('Input {0}', i + 1)}
                    </option>
                  ))}
                </select>
              </label>
              <meter ref={meter} min={0} max={1} value={0} aria-label={msg('Audio level')} />
            </>
          )}
          <p>{msg('This choice is kept for next time.')}</p>
        </div>
        {error && <p role="alert">{error}</p>}
        <div class={styles.actions}>
          {phase === 'ready' ? (
            <Button variant="primary" disabled={connection.state !== 'connected'} onClick={start}>
              <span class={styles.startContent}>
                <span class={pill.dot} aria-hidden="true" />
                {msg('Start recording')}
              </span>
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={phase === 'enabling' || connection.state !== 'connected'}
              onClick={() => void open('', true)}
            >
              {phase === 'enabling' ? msg('Opening audio input…') : msg('Enable audio input')}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              release()
              setPhase('list')
            }}
          >
            {msg('Recordings')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
