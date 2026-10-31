/**
 * Step 5, "Set hint pedal" (spec "MIDI input, output, and pedal controls"): press the desired
 * pedal, the app observes its message, a test press confirms the mapping (one press = one
 * hint; holding never retriggers), then save it. Prefer the middle pedal when it sends a usable
 * message; if the piano does not transmit it, say so — the on-screen Hint button remains.
 * Advanced: inversion and threshold. The pedal's action mirrors Settings → Pedal.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { MidiService, MidiSnapshot } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import { NO_MIDDLE_PEDAL_EXPLANATION, PEDAL_SOUND_CAVEAT } from '../../core/midi/hintPedal'
import { CC_SOSTENUTO, CC_SUSTAIN } from '../../core/midi/types'
import type { HintPedalMapping } from '../../core/model/settings'
import { Button, Segmented, Slider, Toggle } from '../../ui/controls'
import { controllerName, describeHintPedal } from '../settings/pedalSummary'
import { HintPedalSetup } from './hintPedalFlow'
import { PedalMeter } from './Meter'
import { Callout, Help, Step, useFrameRender } from './parts'
import { capitalize, channelLabel, type StepStatus } from './status'
import styles from './connection.module.css'

/** After this long without a usable pedal message, explain that the pedal may not be transmitted. */
export const QUIET_PEDAL_MS = 10_000

export function HintPedalStep({
  index,
  status,
  snap,
  service,
}: {
  index: number
  status: StepStatus
  snap: MidiSnapshot
  service: MidiService
}) {
  const pedal = settings.value.pedal
  const saved = pedal.hintPedal
  const setup = useMemo(
    () => new HintPedalSetup((controller, channel) => service.adapter.physical.observedValue(controller, channel)),
    [service],
  )
  const render = useFrameRender()
  const [active, setActive] = useState(false)
  const [quiet, setQuiet] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const phase = active ? setup.phase : 'idle'
  const inputReady = snap.input?.connected === true

  useEffect(() => {
    if (!active) return
    return service.adapter.subscribe((ev) => {
      const watched = setup.mapping
      if (setup.feed(ev) || (ev.kind === 'cc' && watched !== null && ev.controller === watched.controller)) render()
    })
  }, [active, service, setup, render])

  useEffect(() => {
    if (phase !== 'listening' || setup.detected) return
    setQuiet(false)
    const timer = setTimeout(() => setQuiet(true), QUIET_PEDAL_MS)
    return () => clearTimeout(timer)
  }, [phase, setup])

  const begin = (fn: () => void) => {
    fn()
    setJustSaved(false)
    setActive(true)
    render()
  }
  const start = () => begin(() => setup.start())
  const testSaved = () => saved && begin(() => setup.test(saved))
  const adjust = (change: { inverted?: boolean; threshold?: number }) => {
    if (!active && saved) setup.test(saved)
    setup.adjust(change)
    setJustSaved(false)
    setActive(true)
    render()
  }
  const save = () => {
    const mapping = setup.mapping
    if (!mapping?.verified) return
    updateSettings({ pedal: { hintPedal: mapping } })
    setActive(false)
    setJustSaved(true)
  }
  const cancel = () => {
    setup.cancel()
    setActive(false)
  }

  const mapping: HintPedalMapping | null = active ? setup.mapping : saved

  return (
    <Step
      id="pedal"
      index={index}
      title="Hint pedal"
      status={status}
      lead="Reveal a hint with your foot instead of touching the screen. The middle pedal works best."
    >
      {!inputReady && !active ? (
        <Help>Choose your piano input first; then press the pedal you want to use.</Help>
      ) : null}

      {phase === 'idle' ? (
        <>
          <p class={styles.summary} data-testid="hint-pedal-summary">
            {describeHintPedal(saved)}
          </p>
          {justSaved ? (
            <Callout tone="success" title="Hint pedal saved" live>
              <p>One press reveals one hint during practice.</p>
            </Callout>
          ) : null}
          <div class={styles.actions}>
            <Button variant={saved ? 'secondary' : 'primary'} onClick={start} disabled={!inputReady}>
              {saved ? 'Set hint pedal again' : 'Set hint pedal'}
            </Button>
            {saved ? (
              <>
                <Button onClick={testSaved} disabled={!inputReady}>
                  Test it
                </Button>
                <Button variant="ghost" onClick={() => updateSettings({ pedal: { hintPedal: null } })}>
                  Remove
                </Button>
              </>
            ) : null}
          </div>
        </>
      ) : (
        <FlowPanel setup={setup} quiet={quiet} service={service} onSave={save} onRestart={start} onCancel={cancel} />
      )}

      <div class={styles.inline}>
        <span class={styles.inlineLabel} aria-hidden="true">
          A press shows
        </span>
        <Segmented
          label="Hint pedal action"
          value={pedal.hintPedalAction}
          compact
          options={[
            { value: 'names', label: 'Note names' },
            { value: 'keys', label: 'Show keys' },
          ]}
          onChange={(hintPedalAction) => updateSettings({ pedal: { hintPedalAction } })}
        />
      </div>

      {mapping ? (
        <details class={styles.details}>
          <summary>Advanced: inversion and threshold</summary>
          <div class={styles.detailsBody}>
            <Toggle
              label="Inverted pedal"
              description="For pedals that send a high value at rest and a low value when pressed."
              checked={mapping.inverted}
              onChange={(inverted) => adjust({ inverted })}
            />
            <Slider
              label="Threshold"
              min={1}
              max={127}
              step={1}
              value={mapping.threshold}
              onChange={(threshold) => adjust({ threshold })}
            />
            <Help>Changing either needs a new test press before saving.</Help>
          </div>
        </details>
      ) : null}

      <Help>The on-screen Hint button always works, with or without a pedal. {PEDAL_SOUND_CAVEAT}</Help>
    </Step>
  )
}

function FlowPanel({
  setup,
  quiet,
  service,
  onSave,
  onRestart,
  onCancel,
}: {
  setup: HintPedalSetup
  quiet: boolean
  service: MidiService
  onSave: () => void
  onRestart: () => void
  onCancel: () => void
}) {
  const mapping = setup.mapping
  const detected = setup.detected
  const phase = setup.phase
  const value =
    mapping === null ? 0 : service.adapter.physical.controllerValue(mapping.controller, mapping.channel ?? undefined)
  const name = mapping ? capitalize(controllerName(mapping.controller)) : ''
  const missingMiddle = detected !== null && mapping?.controller !== CC_SOSTENUTO && !setup.middlePedalSeen

  return (
    <div class={styles.flow} data-phase={phase}>
      {phase === 'listening' ? (
        <div class={styles.listening} role="status">
          <span class={styles.pulse} aria-hidden="true" />
          <div>
            <strong>Press and release the pedal you want to use.</strong>
            <p class={styles.help}>The middle pedal is best: it rarely matters for the music you are reading.</p>
          </div>
        </div>
      ) : null}
      {phase === 'listening' && quiet ? (
        <Callout tone="warning" title="No pedal message yet">
          <p>
            If you are pressing the middle pedal, your piano may not send it. Try another pedal, or keep using the
            on-screen Hint button.
          </p>
        </Callout>
      ) : null}

      {mapping && phase !== 'listening' ? (
        <>
          <p class={styles.summary}>
            {detected ? 'Detected: ' : 'Testing: '}
            <strong>{name}</strong>
            {mapping.channel === null ? '' : `, ${channelLabel(mapping.channel)}`}
            {detected ? ` — values ${mapping.observedMin}–${mapping.observedMax}` : ''}.
          </p>
          <PedalMeter
            label={name}
            value={value}
            threshold={mapping.threshold}
            inverted={mapping.inverted}
            thresholdNote="learned"
          />
          {detected?.preferredMiddle ? (
            <Help>The middle pedal was chosen because it sends a usable message.</Help>
          ) : null}
          {missingMiddle ? (
            <Callout tone="info" title="The middle pedal was not received">
              <p>{NO_MIDDLE_PEDAL_EXPLANATION}</p>
            </Callout>
          ) : null}
          {mapping.controller === CC_SUSTAIN ? (
            <Callout tone="warning" title="This is the sustain pedal">
              <p>You will want it for playing. The middle or soft pedal usually makes a better hint pedal.</p>
            </Callout>
          ) : null}
        </>
      ) : null}

      {phase === 'confirming' ? (
        <div class={styles.listening} role="status">
          <span class={styles.pulse} aria-hidden="true" />
          <strong>Now press it once more to test it.</strong>
        </div>
      ) : null}
      {phase === 'pressed' ? <Callout tone="success" title="Hint! Now release the pedal." live /> : null}
      {phase === 'confirmed' ? (
        <Callout tone="success" title="It works: one press, one hint" live>
          <p>
            Hints triggered: <strong data-testid="hint-trigger-count">{setup.triggerCount}</strong>. Hold the pedal
            down: the count does not rise until you release and press again.
          </p>
        </Callout>
      ) : null}

      <div class={styles.actions}>
        {phase === 'confirmed' ? (
          <Button variant="primary" icon="check" onClick={onSave}>
            Save hint pedal
          </Button>
        ) : null}
        {phase !== 'listening' ? <Button onClick={onRestart}>Start over</Button> : null}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
