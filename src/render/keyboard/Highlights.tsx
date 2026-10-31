import type { KeyboardLayout } from './layout'
import { ICON_WIDTH, hasIcon, type PlacedLabel } from './labels'
import { BLACK_KEY_RATIO, CHIP_HEIGHT, KEYS_TOP, ROLL_GAP, checkPath, chipTop, crossPath, handAttr } from './metrics'
import type { GuideKey } from './types'
import styles from './KeyboardGuide.module.css'

/**
 * The translucent bar over each highlighted key of one color (DECISIONS U15). The state is
 * never color-only: a target has a solid outline, a played target a dashed one and a tick on
 * its label, a wrong key a cross on its label, a held key a dot near its bottom edge.
 */
export function KeyBars({
  layout,
  keys,
  height,
  black,
}: {
  layout: KeyboardLayout
  keys: readonly GuideKey[]
  height: number
  black: boolean
}) {
  const h = black ? Math.round(height * BLACK_KEY_RATIO) : height
  return (
    <g data-part={black ? 'black-bars' : 'white-bars'}>
      {keys.map((key) => {
        const g = layout.keyAt(key.midi)
        if (!g || g.black !== black) return null
        const inset = Math.max(0.75, Math.min(2, g.width * 0.1))
        const dotR = Math.min(3.5, Math.max(1.5, g.width * 0.18))
        return (
          <g key={key.midi}>
            <rect
              class={styles.bar}
              data-part="bar"
              data-midi={key.midi}
              data-state={key.state}
              data-hand={handAttr(key.hand)}
              data-black={black ? 'true' : undefined}
              x={g.x + inset}
              y={KEYS_TOP + inset}
              width={Math.max(1, g.width - 2 * inset)}
              height={h - 2 * inset}
              rx={Math.min(3, g.width / 4)}
            />
            {key.held ? (
              <circle
                class={black ? `${styles.heldDot} ${styles.onBlack}` : styles.heldDot}
                data-marker="held"
                data-midi={key.midi}
                cx={g.cx}
                cy={KEYS_TOP + h - Math.max(5, dotR + 3)}
                r={dotR}
              />
            ) : null}
          </g>
        )
      })}
    </g>
  )
}

/** Note names above the highlighted keys, with a thin leader down to each key. */
export function KeyLabels({ labels }: { labels: readonly PlacedLabel[] }) {
  return (
    <g data-part="labels">
      {labels.map(({ key, anchor, left, width, lane, edge }) => {
        const top = chipTop(lane)
        const icon = hasIcon(key)
        const lead = Math.min(Math.max(anchor, left + 3), left + width - 3)
        return (
          <g
            key={key.midi}
            class={styles.label}
            data-part="label"
            data-midi={key.midi}
            data-state={key.state}
            data-hand={handAttr(key.hand)}
            data-edge={edge ?? undefined}
          >
            <path class={styles.leader} d={`M${lead} ${top + CHIP_HEIGHT}L${anchor} ${KEYS_TOP}`} />
            <rect class={styles.chip} x={left} y={top} width={width} height={CHIP_HEIGHT} rx={CHIP_HEIGHT / 2} />
            {icon ? (
              <path
                class={key.state === 'wrong' ? styles.crossMark : styles.tickMark}
                d={key.state === 'wrong' ? crossPath(4.5) : checkPath(4.5)}
                transform={`translate(${left + 4 + ICON_WIDTH / 2 - 1} ${top + CHIP_HEIGHT / 2})`}
              />
            ) : null}
            <text
              class={styles.chipText}
              x={left + (icon ? ICON_WIDTH + 2 : 0) + (width - (icon ? ICON_WIDTH + 2 : 0)) / 2}
              y={top + CHIP_HEIGHT / 2 + 4}
            >
              {key.label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** A marked roll: an arrow just above the keys from the lowest to the highest target. */
export function RollArrow({ xs, direction }: { xs: readonly number[]; direction: 'up' | 'down' }) {
  if (xs.length < 2) return null
  const low = Math.min(...xs)
  const high = Math.max(...xs)
  if (high - low < 6) return null
  const y = KEYS_TOP - ROLL_GAP / 2
  const tip = direction === 'up' ? high : low
  const back = direction === 'up' ? -1 : 1
  return (
    <g class={styles.roll} data-part="roll" data-direction={direction}>
      <title>{direction === 'up' ? 'Roll upward' : 'Roll downward'}</title>
      <path d={`M${low} ${y}H${high}`} />
      <path d={`M${tip + back * 5} ${y - 3.5}L${tip} ${y}L${tip + back * 5} ${y + 3.5}`} />
    </g>
  )
}
