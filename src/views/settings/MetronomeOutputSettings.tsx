import { msg } from '../../i18n/messages'
/**
 * Metronome output (DECISIONS U114). The picker appears only where the browser can send Web
 * Audio to a chosen device. Nothing asks for a permission until the learner taps Show audio
 * outputs, which a browser that hides its outputs (their IDs or names are empty) needs first.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { settings, updateSettings } from '../../app/state'
import { loadWebAudioMetronome } from '../../core/playback/lazy'
import {
  canSelectMetronomeOutput,
  hasAudioOutputPicker,
  listMetronomeOutputs,
  metronomeAudioOutput,
  requestMetronomeOutputAccess,
  type MetronomeOutputList,
} from '../../core/playback/webaudio/metronomeOutput'
import { Button, Field, Notice } from '../../ui/controls'
import { Help } from './parts'

export function MetronomeOutputSettings() {
  const { outputId, volume } = settings.value.metronome
  const canSelect = canSelectMetronomeOutput()
  /** Null until the first listing arrives. */
  const [list, setList] = useState<MetronomeOutputList | null>(null)
  const [asking, setAsking] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const refresh = useRef<() => void>(() => undefined)

  useEffect(() => {
    mounted.current = true
    let revision = 0
    const update = () => {
      const request = ++revision
      void listMetronomeOutputs().then(
        (next) => {
          if (mounted.current && request === revision) setList(next)
        },
        () => {
          if (mounted.current && request === revision) setList({ outputs: [], hidden: false })
        },
      )
    }
    refresh.current = update
    if (canSelect) {
      update()
      navigator.mediaDevices.addEventListener('devicechange', update)
    }
    return () => {
      mounted.current = false
      if (canSelect) navigator.mediaDevices.removeEventListener('devicechange', update)
    }
  }, [canSelect])

  async function showOutputs(): Promise<void> {
    setAsking(true)
    setError('')
    try {
      const chosen = await requestMetronomeOutputAccess()
      if (!mounted.current) return
      if (chosen?.deviceId) updateSettings({ metronome: { outputId: chosen.deviceId } })
      refresh.current()
    } catch {
      if (mounted.current)
        setError('The browser did not allow it, so its audio outputs stay hidden. System audio is used.')
    } finally {
      if (mounted.current) setAsking(false)
    }
  }

  async function testClick(): Promise<void> {
    setTesting(true)
    setError('')
    try {
      const [{ context, deviceSelected }, { WebAudioMetronome }] = await Promise.all([
        metronomeAudioOutput(outputId),
        loadWebAudioMetronome(),
      ])
      if (!mounted.current || settings.peek().metronome.outputId !== outputId) return
      const clock = () => performance.now()
      new WebAudioMetronome({ context, clock, volume }).click(clock(), true)
      if (outputId && canSelect && !deviceSelected) {
        setError('The selected output was unavailable. The test used system audio.')
      }
    } catch {
      if (mounted.current) setError('The metronome test could not play.')
    } finally {
      if (mounted.current) setTesting(false)
    }
  }

  const devices = list?.outputs ?? []
  const loading = canSelect && list === null
  const outputMissing = canSelect && list !== null && outputId !== null && !devices.some((d) => d.deviceId === outputId)
  return (
    <>
      {canSelect ? (
        <Field
          label={msg('Metronome output')}
          hint={
            devices.length > 0
              ? msg(
                  'For piano speakers, connect the piano by USB and choose its audio output here or in your system audio settings.',
                )
              : msg('For piano speakers, connect the piano by USB and use your device’s audio output controls.')
          }
        >
          <select
            value={outputId ?? ''}
            disabled={testing || loading || (!outputMissing && devices.length === 0)}
            onChange={(event) => {
              setError('')
              updateSettings({ metronome: { outputId: event.currentTarget.value || null } })
            }}
          >
            <option value="">{msg('System audio')}</option>
            {loading && outputId !== null ? <option value={outputId}>{msg('Loading…')}</option> : null}
            {outputMissing ? <option value={outputId}>{msg('Saved output unavailable')}</option> : null}
            {devices.map(({ deviceId, label }, index) => (
              <option key={deviceId} value={deviceId}>
                {label || msg('Audio output {0}', index + 1)}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Help>{msg('For piano speakers, connect the piano by USB and use your device’s audio output controls.')}</Help>
      )}
      {list?.hidden ? (
        <>
          <Help>
            {hasAudioOutputPicker()
              ? msg('This browser shows its audio outputs only when you choose one in its own list.')
              : msg(
                  'This browser shows its audio outputs only after you allow the microphone. Pianissimo turns the microphone off at once and records nothing.',
                )}
          </Help>
          <div>
            <Button disabled={asking} onClick={() => void showOutputs()}>
              {msg('Show audio outputs')}
            </Button>
          </div>
        </>
      ) : null}
      <div>
        <Button icon="sound" disabled={testing || volume === 0} onClick={() => void testClick()}>
          {msg('Test click')}
        </Button>
      </div>
      {error ? <Notice tone="warning">{msg(error)}</Notice> : null}
    </>
  )
}
