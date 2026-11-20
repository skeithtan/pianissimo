import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ResultDetails } from '../../app/session'
import { excerptMarkup, type ExcerptMarkup } from '../../render/excerpt'
import type { TextMeasurer } from '../../render/labels/metrics'
import { positionToX } from '../../render/strip/scroll'
import type { PreparedLayout } from '../../render/types'
import { timingBarDetail, type TimingBar, type TimingPoint, type TimingReviewData } from './timingReview'
import detailStyles from './resultDetails.module.css'
import styles from './timingReviewStrip.module.css'

const VISIBLE_BARS = 3
const CHART_WIDTH = 1000
const CHART_HEIGHT = 106
const BEAT_Y = 48
const MISS_Y = 98
const AMPLITUDE = 38
const MAX_SCORE_HEIGHT = 190

interface PlacedPoint extends TimingPoint {
  readonly x: number
}

interface PlacedBar {
  readonly bar: TimingBar
  readonly excerpt: ExcerptMarkup | null
  readonly x: number
  readonly width: number
  readonly points: readonly PlacedPoint[]
}

function placeBars(
  bars: readonly TimingBar[],
  layout: PreparedLayout | null,
  marks: ResultDetails['marks'],
  measurer: TextMeasurer,
): readonly PlacedBar[] {
  let x = 0
  return bars.map((bar, index) => {
    const missed = bar.points.flatMap((point) => {
      const mark = marks.get(point.group)
      return mark?.kind === 'missed' ? [{ ...mark, kind: 'missed' as const }] : []
    })
    const excerpt = layout
      ? excerptMarkup(layout, bar.occ, { marks: missed, measurer, includeContext: index === 0 })
      : null
    const width = excerpt?.width ?? 160
    const points = bar.points.map((point) => {
      const relativeX =
        layout && excerpt
          ? positionToX(layout.occurrences, point.position) + excerpt.offsetX
          : 8 + ((width - 16) * (point.position - bar.start)) / (bar.duration || 1)
      return { ...point, x: x + Math.max(3, Math.min(width - 3, relativeX)) }
    })
    const placed = { bar, excerpt, x, width, points }
    x += width
    return placed
  })
}

interface TimingReviewStripProps {
  readonly data: TimingReviewData
  readonly layout: PreparedLayout | null
  readonly marks: ResultDetails['marks']
  readonly measurer: TextMeasurer
}

export function TimingReviewStrip(props: TimingReviewStripProps) {
  const [open, setOpen] = useState(false)
  const [selected, select] = useState(props.data.firstBar)
  const body = <TimingStripBody {...props} selected={selected} select={select} />
  if (props.data.hasTimingDeviation) {
    return (
      <section class={detailStyles.group} aria-labelledby="result-timing-heading" data-testid="timing-review">
        <h3 id="result-timing-heading" class={detailStyles.groupHeading}>
          Timing strip
        </h3>
        {body}
      </section>
    )
  }
  return (
    <details
      class={detailStyles.fold}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-testid="timing-review"
    >
      <summary>Timing strip</summary>
      {open ? body : null}
    </details>
  )
}

function TimingStripBody({
  data,
  layout,
  marks,
  measurer,
  selected,
  select,
}: TimingReviewStripProps & { readonly selected: number; readonly select: (index: number) => void }) {
  const first = Math.max(0, Math.min(selected - 1, data.bars.length - VISIBLE_BARS))
  const active = data.bars[selected]!
  const viewport = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const placed = useMemo(
    () => placeBars(data.bars.slice(first, first + VISIBLE_BARS), layout, marks, measurer),
    [data.bars, first, layout, marks, measurer],
  )
  const total = placed.reduce((sum, item) => sum + item.width, 0)
  const top = Math.max(...placed.map(({ excerpt }) => excerpt?.staffTop ?? 0))
  const bottom = Math.max(...placed.map(({ excerpt }) => (excerpt ? excerpt.height - excerpt.staffTop : 0)))
  const height = top + bottom
  const maxWidth = Math.floor(total * Math.min(1.15, height > 0 ? MAX_SCORE_HEIGHT / height : Infinity))
  const activePlacement = placed[selected - first]!
  const earlyOrLate = active.direction === 'rushing' ? 'Rushing' : active.direction === 'dragging' ? 'Dragging' : null
  const label = earlyOrLate ? `${earlyOrLate} in bar ${active.label}` : `Timing in bar ${active.label}`

  useLayoutEffect(() => {
    const view = viewport.current
    const content = rail.current
    if (!view || !content) return
    const scale = content.clientWidth / total
    const center = (activePlacement.x + activePlacement.width / 2) * scale
    view.scrollLeft = center - view.clientWidth / 2
  }, [activePlacement, total])

  return (
    <div class={styles.body}>
      {data.bars.length > VISIBLE_BARS ? (
        <label class={styles.jump}>
          Bar
          <select value={selected} onChange={(event) => select(Number(event.currentTarget.value))}>
            {data.bars.map((bar, index) => (
              <option key={bar.occ} value={index}>
                {bar.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div class={styles.frame} style={{ '--timing-max-width': `${maxWidth}px` }}>
        <div class={styles.axis} aria-hidden="true">
          <span class={styles.early}>Early</span>
          <span class={styles.beat}>On beat</span>
          <span class={styles.late}>Late</span>
          <span class={styles.missed}>Missed</span>
        </div>
        <div class={styles.viewport} ref={viewport}>
          <div class={styles.rail} ref={rail} style={{ '--timing-width': `${total}px` }}>
            <TimingScore bars={placed} width={total} height={height} top={top} />
            <TimingChart bars={placed} width={total} tolerance={data.tolerance} selected={active.occ} />
            <div
              class={styles.barButtons}
              role="group"
              aria-label="Timing bars"
              style={{ gridTemplateColumns: placed.map((item) => `${item.width}fr`).join(' ') }}
            >
              {placed.map(({ bar }, index) => (
                <button
                  key={bar.occ}
                  type="button"
                  aria-pressed={bar.occ === active.occ}
                  onClick={() => select(first + index)}
                >
                  Bar {bar.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div class={styles.summary}>
        <div aria-live="polite" data-testid="timing-review-summary">
          <strong>{label}</strong>
          <span>{timingBarDetail(active)}</span>
        </div>
        <span>On-time window ±{data.tolerance} ms</span>
      </div>
    </div>
  )
}

function TimingScore({
  bars,
  width,
  height,
  top,
}: {
  bars: readonly PlacedBar[]
  width: number
  height: number
  top: number
}) {
  if (height <= 0) return null
  return (
    <div class={`pn-excerpt ${styles.score}`} data-testid="timing-review-score">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
        {bars.map(({ bar, excerpt, x }) => (
          <g key={bar.occ} transform={`translate(${x} 0)`}>
            {excerpt ? (
              // Sanitized notation and numeric geometry from render/excerpt.
              <g
                transform={`translate(0 ${top - excerpt.staffTop})`}
                dangerouslySetInnerHTML={{ __html: excerpt.svg }}
              />
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  )
}

function TimingChart({
  bars,
  width,
  tolerance,
  selected,
}: {
  bars: readonly PlacedBar[]
  width: number
  tolerance: number
  selected: number
}) {
  const points = bars.flatMap(({ points }) => points)
  const maxOffset = points.reduce((max, point) => Math.max(max, Math.abs(point.offset ?? 0)), tolerance)
  const y = (offset: number) => BEAT_Y + (offset * AMPLITUDE) / maxOffset
  const x = (position: number) => (position / width) * CHART_WIDTH
  let last: PlacedPoint | null = null
  const tracks = points.flatMap((point) => {
    const previous = last
    last = point.offset === null ? null : point
    if (point.offset === null || previous?.offset == null) return []
    return [{ point, previous, y0: y(previous.offset), y1: y(point.offset) }]
  })
  return (
    <div
      class={styles.chart}
      role="img"
      aria-label="Timing by attack. Early above the beat line, late below, and missed entries shown as crosses."
    >
      <svg
        width="100%"
        height={CHART_HEIGHT}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect x={0} y={y(-tolerance)} width={CHART_WIDTH} height={y(tolerance) - y(-tolerance)} class={styles.band} />
        {bars.map(({ bar, x: left }) => (
          <line
            key={bar.occ}
            x1={x(left)}
            x2={x(left)}
            y1={0}
            y2={CHART_HEIGHT}
            class={styles.divider}
            vector-effect="non-scaling-stroke"
          />
        ))}
        <line x1={0} x2={CHART_WIDTH} y1={BEAT_Y} y2={BEAT_Y} class={styles.pulse} vector-effect="non-scaling-stroke" />
        {tracks.map(({ point, previous, y0, y1 }) => (
          <line
            key={point.group}
            x1={x(previous.x)}
            x2={x(point.x)}
            y1={y0}
            y2={y1}
            class={styles.track}
            data-offset={offsetSide(point.offset)}
            vector-effect="non-scaling-stroke"
          />
        ))}
      </svg>
      {bars.map(({ bar, points }) =>
        points.map((point) => {
          if (point.offset === null && !point.missed) return null
          const side = offsetSide(point.offset)
          return (
            <span
              key={point.group}
              class={point.missed ? styles.cross : styles.dot}
              data-offset={side}
              data-offset-ms={point.offset ?? undefined}
              data-selected={bar.occ === selected || undefined}
              title={`Bar ${bar.label} · ${point.missed ? 'Missed' : side === 'beat' ? 'On the beat' : `${Math.abs(point.offset ?? 0)} ms ${side}`}`}
              style={{ left: `${(point.x / width) * 100}%`, top: `${point.missed ? MISS_Y : y(point.offset ?? 0)}px` }}
              aria-hidden="true"
            >
              {point.missed ? '×' : null}
            </span>
          )
        }),
      )}
    </div>
  )
}

function offsetSide(offset: number | null): 'early' | 'late' | 'beat' {
  if (offset !== null && offset < 0) return 'early'
  return offset !== null && offset > 0 ? 'late' : 'beat'
}
