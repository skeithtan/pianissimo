/**
 * Beat-unit note drawn as SVG (spec: the effective BPM is shown with its metronome beat unit).
 * Text glyphs such as ♩ render tiny or misaligned in system fonts, and a dotted unit's dot
 * drifts away from its note, so the note is engraved here instead.
 */
import type { Rational } from '../core/music/rational'
import { beatUnitName } from '../core/music/tempo'

interface NoteShape {
  readonly head: 'whole' | 'open' | 'filled'
  readonly flags: number
  readonly dotted: boolean
}

const BASES: readonly (readonly [number, NoteShape['head'], number])[] = [
  [1, 'whole', 0],
  [1 / 2, 'open', 0],
  [1 / 4, 'filled', 0],
  [1 / 8, 'filled', 1],
  [1 / 16, 'filled', 2],
]

/** Note shape for a beat unit in whole notes (plain or single-dotted), or null when unusual. */
export function beatUnitShape(unit: Rational): NoteShape | null {
  const value = unit.n / unit.d
  for (const [base, head, flags] of BASES) {
    if (Math.abs(value - base) < 1e-9) return { head, flags, dotted: false }
    if (Math.abs(value - base * 1.5) < 1e-9) return { head, flags, dotted: true }
  }
  return null
}

export function BeatUnitIcon({ unit, class: className }: { unit: Rational; class?: string | undefined }) {
  const shape = beatUnitShape(unit)
  if (!shape) return <span class={className}>{`${unit.n}/${unit.d}`}</span>
  const stem = shape.head !== 'whole'
  const width = 10 + (shape.flags > 0 ? 5 : 0) + (shape.dotted ? 5 : 0)
  const dotX = shape.flags > 0 ? 16.5 : 12.5
  return (
    <svg
      class={className}
      viewBox={`0 0 ${width} 24`}
      width={`${(width / 24) * 1.25}em`}
      height="1.25em"
      role="img"
      aria-label={beatUnitName(unit)}
      style={{ verticalAlign: '-0.28em', overflow: 'visible' }}
    >
      <ellipse
        cx="5"
        cy="19"
        rx="4"
        ry="2.9"
        transform="rotate(-22 5 19)"
        fill={shape.head === 'filled' ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width={shape.head === 'filled' ? 0 : 1.6}
      />
      {stem ? <path d="M8.6 18V2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /> : null}
      {Array.from({ length: shape.flags }, (_, i) => (
        <path
          d={`M8.6 ${2 + i * 4.5}c0.4 3 5.4 4.2 4.6 9`}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      ))}
      {shape.dotted ? <circle cx={dotX} cy="18.5" r="1.4" fill="currentColor" /> : null}
    </svg>
  )
}
