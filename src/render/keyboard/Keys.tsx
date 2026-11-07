import type { NamingSettings } from '../../core/model/settings'
import type { KeyboardLayout } from './layout'
import { keyName, MIDDLE_C } from './landmarks'
import { ALL_LANDMARKS_MIN_WHITE, BLACK_KEY_RATIO } from './metrics'
import styles from './KeyboardGuide.module.css'

export interface KeyLayerProps {
  readonly layout: KeyboardLayout
  /** White-key height in px. */
  readonly height: number
  /** Top edge of the keys in px (`keysTop`). */
  readonly top: number
  readonly black: boolean
}

/**
 * The plain keys of one color, drawn once per width: they never change while playing (the
 * guide passes the same element on every update, so Preact skips it). White keys go under the
 * white-key highlights, black keys over them, so a white key's bar never tints a black key.
 */
export function KeyLayer({ layout, height, top, black }: KeyLayerProps) {
  const h = black ? Math.round(height * BLACK_KEY_RATIO) : height
  return (
    <g data-part={black ? 'black-keys' : 'white-keys'}>
      {layout.keys
        .filter((key) => key.black === black)
        .map((key) => (
          <rect
            key={key.midi}
            class={black ? styles.black : styles.white}
            data-midi={key.midi}
            x={key.x}
            y={top}
            width={key.width}
            height={h}
            rx={Math.min(2, key.width / 4)}
          />
        ))}
    </g>
  )
}

/**
 * Octave landmarks on the C keys, always with their octave (DECISIONS K1). When the keys are
 * too narrow for every C, only middle C is named.
 */
export function Landmarks({
  layout,
  height,
  top,
  naming,
}: {
  layout: KeyboardLayout
  height: number
  top: number
  naming: NamingSettings
}) {
  const all = layout.whiteWidth >= ALL_LANDMARKS_MIN_WHITE
  const size = Math.max(7, Math.min(10, layout.whiteWidth * 0.45))
  return (
    <g data-part="landmarks" aria-hidden="true">
      {layout.keys
        .filter((key) => key.isC && (all || key.midi === MIDDLE_C))
        .map((key) => (
          <text
            key={key.midi}
            class={key.midi === MIDDLE_C ? `${styles.landmark} ${styles.middleC}` : styles.landmark}
            data-part="landmark"
            data-midi={key.midi}
            x={Math.min(Math.max(key.cx, 8), layout.width - 8)}
            y={top + height - 4}
            style={{ fontSize: `${size}px` }}
          >
            {keyName(key.midi, naming)}
          </text>
        ))}
    </g>
  )
}
