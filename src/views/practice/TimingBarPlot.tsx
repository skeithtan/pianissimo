import type { ExcerptMarkup } from '../../render/excerpt'
import { positionToX } from '../../render/strip/scroll'
import type { PreparedLayout } from '../../render/types'
import type { TimingBar } from './timingReview'
import styles from './timingBarPlot.module.css'

const WIDTH = 1000
const BEAT_Y = 39
const MISS_Y = 89
const AMPLITUDE = 29

export function TimingBarPlot({
  bar,
  layout,
  markup,
  tolerance,
  nearBeat,
}: {
  readonly bar: TimingBar
  readonly layout: PreparedLayout | null
  readonly markup: ExcerptMarkup | null
  readonly tolerance: number
  readonly nearBeat: number
}) {
  const points = bar.points.map((point) => {
    const fraction =
      layout && markup
        ? (positionToX(layout.occurrences, point.position) + markup.offsetX) / markup.width
        : (point.position - bar.start) / (bar.duration || 1)
    return { ...point, x: Math.max(0.01, Math.min(0.99, fraction)) * WIDTH }
  })
  const hasMiss = points.some((point) => point.missed)
  const height = hasMiss ? 98 : 78
  const maxOffset = points.reduce((max, point) => Math.max(max, Math.abs(point.offset ?? 0)), tolerance)
  const y = (offset: number) => BEAT_Y + (offset * AMPLITUDE) / maxOffset
  return (
    <>
      <div class={styles.axis} aria-hidden="true">
        <span class={styles.early}>Early</span>
        <span class={styles.beat}>On beat</span>
        <span class={styles.late}>Late</span>
        {hasMiss ? <span class={styles.missed}>Missed</span> : null}
      </div>
      <div
        class={styles.chart}
        role="img"
        aria-label="Timing by attack. Early above the beat line, late below, and missed entries shown as crosses."
        data-testid="timing-review"
      >
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${WIDTH} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect x={0} y={y(-tolerance)} width={WIDTH} height={y(tolerance) - y(-tolerance)} class={styles.band} />
          <line x1={0} x2={WIDTH} y1={BEAT_Y} y2={BEAT_Y} class={styles.pulse} vector-effect="non-scaling-stroke" />
          {points.map((point, i) => {
            const previous = points[i - 1]
            if (point.offset === null || previous?.offset == null) return null
            return (
              <line
                key={point.group}
                x1={previous.x}
                y1={y(previous.offset)}
                x2={point.x}
                y2={y(point.offset)}
                class={styles.track}
                data-offset={offsetSide(point.offset, nearBeat)}
                vector-effect="non-scaling-stroke"
              />
            )
          })}
        </svg>
        {points.map((point) => {
          if (point.offset === null && !point.missed) return null
          const offset = point.offset ?? 0
          return (
            <span
              key={point.group}
              class={point.missed ? styles.cross : styles.dot}
              data-offset={offsetSide(offset, nearBeat)}
              data-offset-ms={point.offset ?? undefined}
              title={
                point.missed
                  ? 'Missed'
                  : offset === 0
                    ? 'On the beat'
                    : `${Math.abs(offset)} ms ${offset < 0 ? 'early' : 'late'}`
              }
              style={{ left: `${(100 * point.x) / WIDTH}%`, top: `${point.missed ? MISS_Y : y(offset)}px` }}
              aria-hidden="true"
            >
              {point.missed ? '×' : null}
            </span>
          )
        })}
      </div>
    </>
  )
}

function offsetSide(offset: number, nearBeat: number): 'early' | 'late' | 'beat' {
  if (offset < -nearBeat) return 'early'
  return offset > nearBeat ? 'late' : 'beat'
}
