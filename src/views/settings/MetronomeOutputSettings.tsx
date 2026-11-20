import { useEffect, useRef, useState } from 'preact/hooks'
import { settings, updateSettings } from '../../app/state'
import { loadWebAudioMetronome } from '../../core/playback/lazy'
import {
  canSelectMetronomeOutput,
  listMetronomeOutputs,
  metronomeAudioOutput,
} from '../../core/playback/webaudio/metronomeOutput'
import { Button, Field, Notice } from '../../ui/controls'

export function MetronomeOutputSettings() {
  const { outputId, volume } = settings.value.metronome
  const canSelect = canSelectMetronomeOutput()
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([])
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let revision = 0
    const refresh = () => {
      const request = ++revision
      void listMetronomeOutputs().then(
        (outputs) => {
          if (mounted.current && request === revision) setDevices(outputs)
        },
        () => {
          if (mounted.current && request === revision) setDevices([])
        },
      )
    }
    if (canSelect) {
      refresh()
      navigator.mediaDevices.addEventListener('devicechange', refresh)
    }
    return () => {
      mounted.current = false
      if (canSelect) navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [canSelect])

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

  const outputMissing = canSelect && outputId !== null && !devices.some((device) => device.deviceId === outputId)
  return (
    <>
      <Field
        label="Metronome output"
        hint={
          canSelect && devices.length > 0
            ? 'For piano speakers, connect the piano by USB and choose its audio output here or in your system audio settings.'
            : 'For piano speakers, connect the piano by USB and use your device’s audio output controls.'
        }
      >
        <select
          value={canSelect ? (outputId ?? '') : ''}
          disabled={testing || (!outputMissing && devices.length === 0)}
          onChange={(event) => {
            setError('')
            updateSettings({ metronome: { outputId: event.currentTarget.value || null } })
          }}
        >
          <option value="">System audio</option>
          {outputMissing ? <option value={outputId}>Saved output unavailable</option> : null}
          {devices.map(({ deviceId, label }, index) => (
            <option key={deviceId} value={deviceId}>
              {label || `Audio output ${index + 1}`}
            </option>
          ))}
        </select>
      </Field>
      <div>
        <Button icon="sound" disabled={testing || volume === 0} onClick={() => void testClick()}>
          Test click
        </Button>
      </div>
      {error ? <Notice tone="warning">{error}</Notice> : null}
    </>
  )
}
