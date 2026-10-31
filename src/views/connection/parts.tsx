/** Layout pieces shared by the setup steps: step card, status pill, port list, frame-batched rendering. */
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useId, useRef, useState } from 'preact/hooks'
import type { MidiService, MidiSnapshot } from '../../app/services'
import type { MidiPortInfo } from '../../core/midi/adapter'
import { Icon, type IconName } from '../../ui/icons'
import { animationFrame } from './liveMonitor'
import type { StepId, StepStatus, StepTone } from './status'
import styles from './connection.module.css'

const TONE_ICON: Readonly<Partial<Record<StepTone, IconName>>> = { done: 'check', action: 'alert' }

/** Status text with an icon or ring, so the state never depends on color alone. */
export function StatusPill({ status }: { status: StepStatus }) {
  const icon = TONE_ICON[status.tone]
  return (
    <span class={styles.pill} data-tone={status.tone}>
      {icon ? <Icon name={icon} size={16} /> : <span class={styles.pillRing} aria-hidden="true" />}
      <span>{status.text}</span>
    </span>
  )
}

export function stepAnchor(id: StepId): string {
  return `connection-step-${id}`
}

/** One setup step: numbered badge (a tick once done), title, status and body. */
export function Step({
  id,
  index,
  title,
  status,
  lead,
  children,
}: {
  id: StepId
  index: number
  title: string
  status: StepStatus
  lead?: ComponentChildren
  children: ComponentChildren
}) {
  const headingId = useId()
  return (
    <section class={styles.step} id={stepAnchor(id)} data-step={id} data-tone={status.tone} aria-labelledby={headingId}>
      <header class={styles.stepHead}>
        <span class={styles.badge} data-tone={status.tone} aria-hidden="true">
          {status.tone === 'done' ? <Icon name="check" size={18} /> : index}
        </span>
        <div class={styles.stepTitle}>
          <h2 id={headingId} tabIndex={-1}>
            <span class="visually-hidden">Step {index}: </span>
            {title}
          </h2>
          {lead ? <p class={styles.lead}>{lead}</p> : null}
        </div>
        <StatusPill status={status} />
      </header>
      <div class={styles.stepBody}>{children}</div>
    </section>
  )
}

/** A muted explanatory paragraph. */
export function Help({ children }: { children: ComponentChildren }) {
  return <p class={styles.help}>{children}</p>
}

/** A calm panel for results and guidance; `tone` adds an icon and a token color. */
export function Callout({
  tone = 'info',
  title,
  children,
  live,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  title?: string
  children?: ComponentChildren
  live?: boolean
}) {
  const icon: IconName | null = tone === 'success' ? 'check' : tone === 'warning' || tone === 'danger' ? 'alert' : null
  return (
    <div class={styles.callout} data-tone={tone} role={live ? 'status' : undefined}>
      {icon ? (
        <span class={styles.calloutIcon} aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      ) : null}
      <div class={styles.calloutBody}>
        {title ? <strong class={styles.calloutTitle}>{title}</strong> : null}
        {children}
      </div>
    </div>
  )
}

/**
 * Inputs or outputs as a radio list of large cards. A remembered port is tagged; a selected port
 * that disconnected stays listed so the learner sees what went away.
 */
export function PortList({
  label,
  name,
  ports,
  selected,
  rememberedName,
  onSelect,
  none,
  disabled,
}: {
  label: string
  name: string
  ports: readonly MidiPortInfo[]
  selected: MidiSnapshot['input']
  rememberedName: string | null
  onSelect: (id: string | null) => void
  /** Offer an explicit "none" choice with this label. */
  none?: string
  disabled?: boolean
}) {
  const rows: { id: string | null; title: string; meta: string; connected: boolean }[] = ports.map((p) => ({
    id: p.id,
    title: p.name,
    meta: [p.manufacturer, p.state === 'connected' ? 'Connected' : 'Disconnected'].filter(Boolean).join(' · '),
    connected: p.state === 'connected',
  }))
  if (selected && !ports.some((p) => p.id === selected.id)) {
    rows.unshift({ id: selected.id, title: selected.name, meta: 'Disconnected', connected: false })
  }
  if (none) rows.push({ id: null, title: none, meta: '', connected: true })
  const current = selected?.id ?? null
  return (
    <fieldset class={styles.ports} disabled={disabled}>
      <legend class="visually-hidden">{label}</legend>
      {rows.map((row) => {
        const checked = row.id === current
        return (
          <label
            key={row.id ?? '-'}
            class={styles.port}
            data-checked={checked ? '' : undefined}
            data-connected={row.connected ? '' : undefined}
          >
            <input type="radio" name={name} checked={checked} onChange={() => onSelect(row.id)} />
            <span class={styles.portText}>
              <span class={styles.portName}>{row.title}</span>
              {row.meta ? <span class={styles.portMeta}>{row.meta}</span> : null}
            </span>
            {row.id !== null && row.title === rememberedName ? <span class={styles.tag}>Remembered</span> : null}
          </label>
        )
      })}
    </fieldset>
  )
}

/** The service snapshot as component state. Creating the adapter here never requests access. */
export function useMidiSnapshot(service: MidiService): MidiSnapshot {
  const [snap, setSnap] = useState<MidiSnapshot>(() => {
    void service.adapter
    return service.snapshot
  })
  useEffect(() => {
    setSnap(service.snapshot)
    return service.subscribe(setSnap)
  }, [service])
  return snap
}

/**
 * A function that re-renders the calling component at most once per animation frame, for views
 * driven by MIDI input (spec: batch only visual changes with requestAnimationFrame).
 */
export function useFrameRender(): () => void {
  const [, setTick] = useState(0)
  const cancel = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cancel.current?.()
      cancel.current = null
    },
    [],
  )
  return useCallback(() => {
    cancel.current ??= animationFrame(() => {
      cancel.current = null
      setTick((n) => n + 1)
    })
  }, [])
}
