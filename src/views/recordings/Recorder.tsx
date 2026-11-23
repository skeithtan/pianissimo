import { useEffect, useRef, useState } from 'preact/hooks'
import { createPortal } from 'preact/compat'
import { Icon } from '../../ui/icons'
import pill from '../../ui/statusPill.module.css'
import control from './recordingControl.module.css'
import { Button, Sheet } from '../../ui/controls'
import { msg } from '../../i18n/messages'
import { openConnection } from '../../app/navigation'
import { connectionStatus, pushNotice } from '../../app/state'
import { openPerformanceInput, type PerformanceInput } from '../../app/audio/performanceInput'
import { describePassage } from '../../core/model/passage'
import { RecordingHistory, handName } from './History'
import { recorderErrorText } from './errors'
import { beginTake, type TakeTarget } from './take'
import { TAKE_LIMIT_MS, TAKE_WARNING_MS, startTakeClock } from './takeClock'
import styles from './recordings.module.css'

export function Recorder({
  target,
  onClose,
  controlsHost,
}: {
  target: TakeTarget
  onClose: () => void
  controlsHost: HTMLElement | null
}) {
  const [phase, setPhase] = useState<'setup' | 'opening' | 'ready' | 'recording' | 'saving' | 'history'>('setup')
  const [savedId, setSavedId] = useState<string>()
  const [error, setError] = useState('')
  const [input, setInput] = useState<PerformanceInput | null>(null)
  const [seconds, setSeconds] = useState(0)
  const meter = useRef<HTMLMeterElement>(null)
  const owned = useRef<PerformanceInput | null>(null)
  const request = useRef<AbortController | null>(null)
  const recording = useRef<ReturnType<typeof beginTake> | null>(null)
  const saving = useRef(false)
  const mounted = useRef(true)
  const connection = connectionStatus.value
  async function finish(interrupted: boolean) {
    const take = recording.current
    if (!take) return
    recording.current = null
    request.current = null
    saving.current = true
    owned.current = null
    if (mounted.current) {
      setPhase('saving')
      setInput(null)
    }
    try {
      const saved = await take.stop(interrupted)
      if (mounted.current) setSavedId(saved.info.id)
    } catch {
      pushNotice({
        kind: 'warning',
        text: msg('Recording could not be saved. Open Recordings to download it or retry.'),
      })
    } finally {
      saving.current = false
      if (mounted.current) setPhase('history')
    }
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
  useEffect(() => {
    mounted.current = true
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
  async function open(id = '', preferPiano = false) {
    release()
    const controller = new AbortController()
    request.current = controller
    setError('')
    setPhase('opening')
    setInput(null)
    try {
      const preferred = preferPiano && connection.state === 'connected' ? connection.inputName : undefined
      const next = await openPerformanceInput(id, lost, controller.signal, preferred)
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
  function start() {
    if (!owned.current || recording.current) return
    try {
      recording.current = beginTake(target, owned.current, lost)
      setSeconds(0)
      setPhase('recording')
    } catch (e) {
      setError(recorderErrorText(e, 'start'))
    }
  }
  if (phase === 'history')
    return (
      <RecordingHistory
        initialId={savedId}
        storage={target.env.storage}
        pieceId={target.pieceId}
        model={target.model}
        onClose={onClose}
      />
    )
  if (phase === 'recording' || phase === 'saving') {
    if (!controlsHost) return null
    const savingTake = phase === 'saving'
    return createPortal(
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
      </span>,
      controlsHost,
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
              {msg('Connection')}
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
              disabled={phase === 'opening' || connection.state !== 'connected'}
              onClick={() => void open('', true)}
            >
              {phase === 'opening' ? msg('Opening audio input…') : msg('Enable audio input')}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              release()
              setPhase('history')
            }}
          >
            {msg('Recordings')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
