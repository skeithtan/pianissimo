/**
 * Entry for a threshold pitch: note name, accidental and octave ("C4", "F#3", "Bb5"; spec
 * "Persistent score labels": the octave is required even when labels hide octaves).
 *
 * Two ways in, kept in sync:
 * - Text, parsed by `parseSpelling` from core/naming, so letter names, fixed-do names and
 *   ♯ ♭ 𝄪 𝄫 all work. The field keeps its own text while it is invalid and reports the parse
 *   problem to its parent.
 * - A button picker (note, ♭ ♮ ♯, octave − / +) that needs no keyboard: on an iPad ♯ and the
 *   octave digits sit on other keyboard layers (DECISIONS A3 follow-up). It edits the pitch in
 *   the field, starting from middle C when the field is empty or invalid.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import type { Spelling, Step } from '../../core/music/pitch'
import { spellingToMidi } from '../../core/music/pitch'
import { formatSpelling, parseSpelling } from '../../core/naming'
import { Segmented } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import styles from './settings.module.css'

export interface PitchEdit {
  /** The parsed pitch, or null when the text is empty or invalid. */
  readonly spelling: Spelling | null
  /** Why the text is not a pitch; null when valid or empty. */
  readonly error: string | null
}

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
type AccidentalKey = 'flat' | 'natural' | 'sharp'
const ACCIDENTALS: readonly { value: AccidentalKey; label: string; title: string; alter: number }[] = [
  { value: 'flat', label: '♭', title: 'Flat', alter: -1 },
  { value: 'natural', label: '♮', title: 'Natural', alter: 0 },
  { value: 'sharp', label: '♯', title: 'Sharp', alter: 1 },
]
/** The picker's starting point when the field holds no pitch. */
const MIDDLE_C: Spelling = { step: 'C', alter: 0, octave: 4 }
/** Octaves the picker offers: the piano's range (A0–C8) rounded out to whole octaves. */
export const PICKER_OCTAVE_MIN = 0
export const PICKER_OCTAVE_MAX = 8

function same(a: Spelling | null, b: Spelling | null): boolean {
  return a === b || (a !== null && b !== null && a.step === b.step && a.alter === b.alter && a.octave === b.octave)
}

function read(text: string): PitchEdit {
  if (text.trim() === '') return { spelling: null, error: null }
  const result = parseSpelling(text)
  return result.ok ? { spelling: result.spelling, error: null } : { spelling: null, error: result.error }
}

function accidentalKey(alter: number): AccidentalKey | null {
  return alter === -1 ? 'flat' : alter === 0 ? 'natural' : alter === 1 ? 'sharp' : null
}

/** Pure picker step: the pitch after choosing a note, an accidental or another octave. */
export function pickSpelling(
  from: Spelling | null,
  change: { step: Step } | { alter: number } | { octaveBy: -1 | 1 },
): Spelling {
  const base = from ?? MIDDLE_C
  if ('step' in change) return { ...base, step: change.step }
  if ('alter' in change) return { ...base, alter: change.alter }
  const octave = Math.min(PICKER_OCTAVE_MAX, Math.max(PICKER_OCTAVE_MIN, base.octave + change.octaveBy))
  return { ...base, octave }
}

function PitchPicker({
  id,
  label,
  value,
  onPick,
}: {
  id: string
  label: string
  value: Spelling | null
  onPick: (s: Spelling) => void
}) {
  const shown = value ?? MIDDLE_C
  return (
    <div id={id} class={styles.picker} role="group" aria-label={`${label}: picker`}>
      <div class={styles.pickerRow}>
        <span class={styles.pickerLabel} aria-hidden="true">
          Note
        </span>
        <Segmented<Step>
          label="Note"
          value={value ? value.step : null}
          options={STEPS.map((step) => ({ value: step, label: step }))}
          onChange={(step) => onPick(pickSpelling(value, { step }))}
          compact
        />
      </div>
      <div class={styles.pickerRow}>
        <span class={styles.pickerLabel} aria-hidden="true">
          Accidental
        </span>
        <span class={styles.glyphs}>
          <Segmented<AccidentalKey>
            label="Accidental"
            value={value ? accidentalKey(value.alter) : null}
            options={ACCIDENTALS.map(({ value: v, label: text, title }) => ({ value: v, label: text, title }))}
            onChange={(key) =>
              onPick(pickSpelling(value, { alter: ACCIDENTALS.find((a) => a.value === key)?.alter ?? 0 }))
            }
            compact
          />
        </span>
      </div>
      <div class={styles.pickerRow}>
        <span class={styles.pickerLabel} aria-hidden="true">
          Octave
        </span>
        <div class={styles.octave} role="group" aria-label="Octave">
          <button
            type="button"
            class={styles.octaveStep}
            aria-label="Octave lower"
            disabled={value !== null && shown.octave <= PICKER_OCTAVE_MIN}
            onClick={() => onPick(pickSpelling(value, { octaveBy: -1 }))}
          >
            <Icon name="minus" size={18} />
          </button>
          <span class={styles.octaveValue} aria-live="polite">
            {value ? value.octave : '–'}
          </span>
          <button
            type="button"
            class={styles.octaveStep}
            aria-label="Octave higher"
            disabled={value !== null && shown.octave >= PICKER_OCTAVE_MAX}
            onClick={() => onPick(pickSpelling(value, { octaveBy: 1 }))}
          >
            <Icon name="plus" size={18} />
          </button>
        </div>
        <span class={styles.pickerHint}>Middle C is C4.</span>
      </div>
    </div>
  )
}

export function PitchInput({
  label,
  value,
  disabled,
  error,
  onEdit,
}: {
  label: string
  value: Spelling | null
  disabled?: boolean
  /** Problem to show under the field (the parent merges parse and rule problems). */
  error?: string | null
  onEdit: (edit: PitchEdit) => void
}) {
  const [text, setText] = useState(value ? formatSpelling(value) : '')
  const [picking, setPicking] = useState(false)
  const pickerId = useId()
  const latest = useRef(text)
  latest.current = text

  // Follow outside changes (preset, revert) but never overwrite what is being typed.
  useEffect(() => {
    if (!same(read(latest.current).spelling, value)) {
      setText(value ? formatSpelling(value) : '')
      onEdit({ spelling: value, error: null })
    }
    // Only a new `value` can require syncing; `onEdit` identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => {
    if (disabled) setPicking(false)
  }, [disabled])

  const parsed = read(text).spelling
  const pick = (next: Spelling) => {
    // The picker only offers in-range pitches, but stay with parseSpelling's MIDI bounds anyway.
    const midi = spellingToMidi(next)
    if (midi < 0 || midi > 127) return
    setText(formatSpelling(next))
    onEdit({ spelling: next, error: null })
  }

  return (
    <>
      <span class={styles.pitchField}>
        <input
          class={styles.pitch}
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          placeholder="e.g. C4"
          disabled={disabled}
          value={text}
          onInput={(event) => {
            const next = (event.currentTarget as HTMLInputElement).value
            setText(next)
            onEdit(read(next))
          }}
        />
        <button
          type="button"
          class={styles.pickButton}
          aria-label={`Choose ${label.charAt(0).toLowerCase()}${label.slice(1)} with buttons`}
          aria-expanded={picking}
          aria-controls={picking ? pickerId : undefined}
          disabled={disabled}
          onClick={() => setPicking((p) => !p)}
        >
          <span aria-hidden="true">♭ ♯</span>
        </button>
      </span>
      {picking && !disabled ? <PitchPicker id={pickerId} label={label} value={parsed} onPick={pick} /> : null}
    </>
  )
}
