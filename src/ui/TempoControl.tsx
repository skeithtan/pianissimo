import { msg, percentage } from '../i18n/messages'
/**
 * Practice speed control: [-]  100% / ♩ = 72  [+] (spec "Practice screen": the header shows the
 * speed multiplier and the effective BPM with its beat unit). Press-and-hold repeats. Tapping the
 * value opens presets, a slider, custom multiplier / percent / BPM entry and a reset to the
 * original tempo. Changing the speed during a scored attempt interrupts it; that decision belongs
 * to the Practice view, which receives every change through `onChange`.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Rational } from '../core/music/rational'
import { beatUnitName } from '../core/music/tempo'
import { BeatUnitIcon } from './BeatUnitIcon'
import { Button, Segmented, Slider } from './controls'
import { useFadePresence } from './fade'
import { Icon } from './icons'
import {
  SPEED_PRESETS_PERCENT,
  canStepMultiplier,
  formatBpm,
  formatSpeedPercent,
  parseSpeedInput,
  stepMultiplier,
} from './speed'
import { usePopoverPlacement } from './usePopoverPlacement'
import styles from './TempoControl.module.css'

export interface TempoControlProps {
  /** Speed relative to the source tempo (1 = original). */
  readonly multiplier: number
  /** Source tempo in beats per minute of `beatUnit`, at the start of the selected passage. */
  readonly sourceBeatBpm: number
  /** Displayed beat unit in whole notes (quarter = 1/4, dotted quarter = 3/8). */
  readonly beatUnit: Rational
  readonly onChange: (multiplier: number) => void
  readonly disabled?: boolean
  /** The score has no numerical tempo: relative speed needs a reference tempo first. */
  readonly noTempo?: boolean
  readonly onRequestTempo?: () => void
  /**
   * Preferred side for the popover. Default 'down' (header). It flips, shifts sideways or
   * scrolls when needed so it always stays fully on screen.
   */
  readonly placement?: 'down' | 'up'
  /** On a filled capsule (the score screen's footer, U155). */
  readonly filled?: boolean
}

const HOLD_DELAY_MS = 400

const REPEAT_MS = 90

/** Press-and-hold repeat. `step` returns false when it changed nothing, which ends the repeat. */
function useHoldRepeat(step: () => boolean) {
  const latest = useRef(step)
  latest.current = step
  const timers = useRef<{ delay: ReturnType<typeof setTimeout> | null; repeat: ReturnType<typeof setInterval> | null }>(
    {
      delay: null,
      repeat: null,
    },
  )
  const stop = () => {
    if (timers.current.delay !== null) clearTimeout(timers.current.delay)
    if (timers.current.repeat !== null) clearInterval(timers.current.repeat)
    timers.current = { delay: null, repeat: null }
  }
  useEffect(() => stop, [])
  return {
    onPointerDown: (event: PointerEvent) => {
      if (event.button !== 0) return
      stop()
      if (!latest.current()) return
      timers.current.delay = setTimeout(() => {
        timers.current.repeat = setInterval(() => {
          if (!latest.current()) stop()
        }, REPEAT_MS)
      }, HOLD_DELAY_MS)
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // Keyboard and assistive-technology activation arrive as a click with no pointer (detail 0);
    // a pointer press has already stepped on pointerdown.
    onClick: (event: MouseEvent) => {
      if (event.detail === 0) latest.current()
    },
  }
}

function StepButton({ dir, enabled, onStep }: { dir: -1 | 1; enabled: boolean; onStep: () => boolean }) {
  const handlers = useHoldRepeat(onStep)
  return (
    <button
      type="button"
      class={styles.step}
      aria-label={dir < 0 ? msg('Slower by 5 percent') : msg('Faster by 5 percent')}
      disabled={!enabled}
      {...handlers}
    >
      <Icon name={dir < 0 ? 'minus' : 'plus'} />
    </button>
  )
}

function SpeedPopover({
  multiplier,
  sourceBeatBpm,
  unitName,
  onChange,
  onClose,
}: {
  multiplier: number
  sourceBeatBpm: number
  unitName: string
  onChange: (m: number) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<'speed' | 'bpm'>('speed')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const percent = Math.round(multiplier * 100)

  const submit = (event: Event) => {
    event.preventDefault()
    const result = parseSpeedInput(text, sourceBeatBpm, mode === 'bpm' ? 'bpm' : 'multiplier')
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setText('')
    onChange(result.multiplier)
  }

  return (
    <div class={styles.panel}>
      <div class={styles.presets} role="group" aria-label={msg('Speed presets')}>
        {SPEED_PRESETS_PERCENT.map((p) => (
          <button
            key={p}
            type="button"
            class={styles.preset}
            aria-pressed={percent === p}
            onClick={() => onChange(p / 100)}
          >
            {percentage(p / 100)}
          </button>
        ))}
      </div>
      <Slider
        label={msg('Speed')}
        min={25}
        max={200}
        step={5}
        value={Math.min(200, Math.max(25, percent))}
        format={() => formatSpeedPercent(multiplier)}
        onChange={(v) => onChange(v / 100)}
      />
      <form class={styles.custom} onSubmit={submit} noValidate>
        <Segmented
          label={msg('Custom entry')}
          value={mode}
          compact
          options={[
            { value: 'speed', label: msg('Speed') },
            { value: 'bpm', label: 'BPM' },
          ]}
          onChange={(m) => {
            setMode(m)
            setError(null)
          }}
        />
        <div class={styles.entry}>
          <input
            class={styles.input}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellcheck={false}
            aria-label={mode === 'bpm' ? msg('Custom tempo in {0} beats per minute', unitName) : msg('Custom speed')}
            aria-invalid={error ? true : undefined}
            placeholder={mode === 'bpm' ? msg('e.g. {0}', formatBpm(sourceBeatBpm * 0.8)) : msg('e.g. 0.6 or 60%')}
            value={text}
            onInput={(e) => {
              setText((e.currentTarget as HTMLInputElement).value)
              setError(null)
            }}
          />
          <Button type="submit" variant="primary">
            {msg('Set')}
          </Button>
        </div>
        {error ? (
          <p class={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
      <div class={styles.footer}>
        <Button
          icon="restart"
          variant="ghost"
          class={styles.nowrap}
          disabled={multiplier === 1}
          onClick={() => onChange(1)}
        >
          {msg('Reset to original tempo')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {msg('Done')}
        </Button>
      </div>
    </div>
  )
}

export function TempoControl({
  multiplier,
  sourceBeatBpm,
  beatUnit,
  onChange,
  disabled,
  noTempo,
  onRequestTempo,
  placement = 'down',
  filled = false,
}: TempoControlProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const popover = useFadePresence(open && !disabled && !noTempo, 160)
  const fit = usePopoverPlacement(popover.mounted, placement, root, panel)
  const side = fit?.side ?? placement
  const unitName = msg(beatUnitName(beatUnit))
  const locked = disabled === true || noTempo === true

  const step = (dir: -1 | 1) => (): boolean => {
    if (!canStepMultiplier(multiplier, dir)) return false
    onChange(stepMultiplier(multiplier, dir))
    return true
  }

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    // In WebKit clicking a button inside the popover can drop focus to body, missing root's onKeyDown.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close(true)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (locked) setOpen(false)
  }, [locked])

  useEffect(() => {
    if (popover.phase === 'entering') root.current?.querySelector<HTMLElement>('[role="dialog"] button')?.focus()
  }, [popover.phase])

  return (
    <div
      class={filled ? `${styles.control} ${styles.filled}` : styles.control}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          close(true)
        }
      }}
    >
      <StepButton dir={-1} enabled={!locked && canStepMultiplier(multiplier, -1)} onStep={step(-1)} />
      {noTempo ? (
        <button type="button" class={styles.value} onClick={() => onRequestTempo?.()} disabled={disabled}>
          <span class={styles.percent}>{msg('Set tempo…')}</span>
          <span class={styles.bpm}>{msg('needed for speed control')}</span>
        </button>
      ) : (
        <button
          ref={trigger}
          type="button"
          class={styles.value}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={msg(
            'Speed {0}, {1} = {2}. Open speed options',
            formatSpeedPercent(multiplier),
            unitName,
            formatBpm(sourceBeatBpm * multiplier),
          )}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <span class={styles.percent}>{formatSpeedPercent(multiplier)}</span>
          <span class={styles.bpm}>
            <BeatUnitIcon unit={beatUnit} class={styles.glyph} /> = {formatBpm(sourceBeatBpm * multiplier)}
          </span>
        </button>
      )}
      <StepButton dir={1} enabled={!locked && canStepMultiplier(multiplier, 1)} onStep={step(1)} />
      {popover.mounted ? (
        <div
          ref={panel}
          class={`${styles.popover} ${side === 'up' ? styles.up : ''}`}
          role="dialog"
          tabIndex={-1}
          aria-label={msg('Playback speed')}
          data-side={side}
          style={{
            ...popover.style,
            ...(fit ? { left: `${fit.left}px`, translate: 'none' } : {}),
            ...(fit?.maxHeight != null ? { maxHeight: `${fit.maxHeight}px` } : {}),
          }}
        >
          <SpeedPopover
            multiplier={multiplier}
            sourceBeatBpm={sourceBeatBpm}
            unitName={unitName}
            onChange={onChange}
            onClose={() => close(true)}
          />
        </div>
      ) : null}
    </div>
  )
}
