/**
 * Live input test (spec "MIDI input, output, and pedal controls": live key and pedal input
 * tests; hardware protocol "Input fidelity"): mini keyboard with held keys and velocity, event
 * counters for lost/duplicated checks, a meter for every controller seen (continuous value,
 * on/off threshold) and the last events. Re-renders at most once per animation frame; observed
 * pedal controllers are recorded in `settings.pedal.observedControllers` from the frame, never
 * from the input handler.
 */
import { useEffect, useMemo } from 'preact/hooks'
import type { MidiService, MidiSnapshot } from '../../app/services'
import { settings, updateSettings } from '../../app/state'
import { Button } from '../../ui/controls'
import { eventRow, meterBehavior, pedalName } from './format'
import { LiveMonitor, type FrameScheduler } from './liveMonitor'
import { PedalMeter } from './Meter'
import { MiniKeyboard } from './MiniKeyboard'
import { useFrameRender } from './parts'
import styles from './connection.module.css'

const CONVENTIONAL_THRESHOLD = 64

/** Merge newly seen controllers into the stored list (sorted, unique). */
export function mergeObserved(stored: readonly number[], fresh: readonly number[]): readonly number[] {
  const merged = [...new Set([...stored, ...fresh])].sort((a, b) => a - b)
  return merged.length === stored.length ? stored : merged
}

export function LivePanel({
  snap,
  service,
  scheduleFrame,
}: {
  snap: MidiSnapshot
  service: MidiService
  scheduleFrame?: FrameScheduler
}) {
  const render = useFrameRender()
  const monitor = useMemo(
    () =>
      new LiveMonitor({
        subscribe: (fn) => service.adapter.subscribe(fn),
        onFrame: () => {
          const fresh = monitor.takeNewControllers()
          if (fresh.length > 0) {
            const stored = settings.peek().pedal.observedControllers
            const merged = mergeObserved(stored, fresh)
            if (merged !== stored) updateSettings({ pedal: { observedControllers: merged } })
          }
          render()
        },
        ...(scheduleFrame ? { scheduleFrame } : {}),
      }),
    [service],
  )
  useEffect(() => {
    monitor.start()
    return () => monitor.stop()
  }, [monitor])

  const { naming, pedal } = settings.value
  const physical = service.adapter.physical
  const counts = monitor.counts()
  const events = monitor.events()
  const meters = monitor.controllers()
  const listening = snap.input?.connected === true
  const hint = pedal.hintPedal

  return (
    <aside class={styles.live} aria-labelledby="connection-live-title">
      <header class={styles.liveHead}>
        <h2 id="connection-live-title">Live input</h2>
        <span class={styles.liveStatus} data-on={listening ? '' : undefined}>
          <span class={styles.liveDot} aria-hidden="true" />
          {listening ? `Listening to ${snap.input!.name}` : 'No input selected'}
        </span>
      </header>

      <MiniKeyboard
        isHeld={(m) => physical.isHeld(m)}
        isSustained={(m) => physical.isSustained(m)}
        velocity={monitor.velocity}
        naming={naming}
      />

      <div class={styles.counters}>
        <dl>
          <div>
            <dt>Note on</dt>
            <dd data-testid="count-noteon">{counts.noteOn}</dd>
          </div>
          <div>
            <dt>Note off</dt>
            <dd data-testid="count-noteoff">{counts.noteOff}</dd>
          </div>
          <div>
            <dt>Pedal msgs</dt>
            <dd data-testid="count-cc">{counts.cc}</dd>
          </div>
        </dl>
        <Button
          variant="ghost"
          onClick={() => monitor.reset()}
          disabled={counts.noteOn + counts.noteOff + counts.cc === 0}
        >
          Reset
        </Button>
      </div>

      <section class={styles.liveSection} aria-label="Pedals">
        <h3>Pedals</h3>
        {meters.length === 0 ? (
          <p class={styles.help}>Press each pedal slowly. Every controller the piano sends appears here.</p>
        ) : (
          meters.map((m) => {
            const learned =
              hint !== null && hint.controller === m.controller && (hint.channel === null || hint.channel === m.channel)
            return (
              <PedalMeter
                key={`${m.channel}:${m.controller}`}
                label={`${pedalName(m.controller)} · CC ${m.controller}${m.channel === 0 ? '' : ` · ch ${m.channel + 1}`}`}
                value={m.value}
                threshold={learned ? hint.threshold : CONVENTIONAL_THRESHOLD}
                inverted={learned ? hint.inverted : false}
                thresholdNote={learned ? 'hint pedal' : 'conventional'}
              >
                <span>
                  {meterBehavior(m)} · {m.min}–{m.max}
                </span>
              </PedalMeter>
            )
          })
        )}
      </section>

      <section class={styles.liveSection} aria-label="Last events">
        <h3>Last events</h3>
        {events.length === 0 ? (
          <p class={styles.help}>
            {listening ? 'Play a key to start.' : 'Choose your piano input to see its keys and pedals.'}
          </p>
        ) : (
          <ol class={styles.events}>
            {events.map((ev) => {
              const row = eventRow(ev, naming)
              return (
                <li key={ev.seq} data-kind={ev.kind}>
                  <span class={styles.evKind}>{row.kind}</span>
                  <span class={styles.evWhat}>{row.what}</span>
                  <span class={styles.evValue}>{row.value}</span>
                  <span class={styles.evChannel}>{row.channel}</span>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </aside>
  )
}
