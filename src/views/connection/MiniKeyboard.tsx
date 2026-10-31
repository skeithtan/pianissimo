/**
 * Compact 88-key strip (A0–C8) for the live key test: held keys light up with their velocity
 * (stronger fill = harder press) and carry a dot; keys still sounding only through the sustain
 * pedal get a dashed outline (spec: physically held keys separate from sustained sound).
 * Display-only; the parent re-renders it at most once per animation frame.
 */
import { keyName } from '../../render/keyboard/landmarks'
import type { NamingSettings } from '../../core/model/settings'
import styles from './connection.module.css'

export const LOWEST = 21
export const HIGHEST = 108
const WHITE_W = 10
const BLACK_W = 6
const HEIGHT = 60
const BLACK_H = 38

interface KeyGeom {
  readonly midi: number
  readonly black: boolean
  readonly x: number
}

const BLACK_PCS = new Set([1, 3, 6, 8, 10])

function buildKeys(): { keys: KeyGeom[]; whites: number } {
  const keys: KeyGeom[] = []
  let white = 0
  for (let midi = LOWEST; midi <= HIGHEST; midi++) {
    if (BLACK_PCS.has(midi % 12)) {
      keys.push({ midi, black: true, x: white * WHITE_W - BLACK_W / 2 })
    } else {
      keys.push({ midi, black: false, x: white * WHITE_W })
      white++
    }
  }
  return { keys, whites: white }
}

const { keys: KEYS, whites: WHITES } = buildKeys()
const WIDTH = WHITES * WHITE_W
const LANDMARKS = [24, 36, 48, 60, 72, 84, 96]

/** Fill opacity for a velocity: soft presses stay visible, loud ones are solid. */
export function velocityOpacity(velocity: number): number {
  return 0.35 + (0.65 * Math.max(0, Math.min(127, velocity))) / 127
}

export function MiniKeyboard({
  isHeld,
  isSustained,
  velocity,
  naming,
}: {
  isHeld: (midi: number) => boolean
  isSustained: (midi: number) => boolean
  velocity: Uint8Array
  naming: NamingSettings
}) {
  const held: number[] = []
  const render = (k: KeyGeom) => {
    const down = isHeld(k.midi)
    if (down) held.push(k.midi)
    const ringing = !down && isSustained(k.midi)
    const w = k.black ? BLACK_W : WHITE_W
    const h = k.black ? BLACK_H : HEIGHT
    return (
      <g
        key={k.midi}
        class={k.black ? styles.kbBlack : styles.kbWhite}
        data-midi={k.midi}
        data-held={down ? '' : undefined}
        data-sustained={ringing ? '' : undefined}
      >
        <rect x={k.x} y={0} width={w} height={h} rx={k.black ? 1 : 1.5} class={styles.kbKey} />
        {down ? (
          <rect
            x={k.x}
            y={0}
            width={w}
            height={h}
            rx={1}
            class={styles.kbPress}
            fill-opacity={velocityOpacity(velocity[k.midi] ?? 0)}
          />
        ) : null}
        {ringing ? <rect x={k.x + 1} y={1} width={w - 2} height={h - 2} rx={1} class={styles.kbRing} /> : null}
        {down ? <circle cx={k.x + w / 2} cy={h - 6} r={k.black ? 1.8 : 2.2} class={styles.kbDot} /> : null}
      </g>
    )
  }
  const whites = KEYS.filter((k) => !k.black).map(render)
  const blacks = KEYS.filter((k) => k.black).map(render)
  const label = held.length === 0 ? 'No keys held' : `Held keys: ${held.map((m) => keyName(m, naming)).join(', ')}`
  return (
    <div class={styles.keyboard}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {whites}
        {blacks}
      </svg>
      <div class={styles.kbLandmarks} aria-hidden="true">
        {LANDMARKS.map((midi) => {
          const k = KEYS.find((g) => g.midi === midi)!
          return (
            <span
              key={midi}
              style={{ left: `${((k.x + WHITE_W / 2) / WIDTH) * 100}%` }}
              data-middle={midi === 60 ? '' : undefined}
            >
              {keyName(midi, naming)}
            </span>
          )
        })}
      </div>
    </div>
  )
}
