/**
 * Scrubbable overview of the whole unfolded piece: measure divisions, section markers, the
 * played portion, the current position and the practice loop. Bar widths are proportional to
 * the time spent in each bar (`OverviewMeasure.seconds`, U12). Position changes move transforms
 * only; ticks and section markers are built once per `measures` and never re-rendered while
 * playing. With `follow`, the overview tracks a live position without re-rendering at all: the
 * played fill and the marker are moved directly (only when they move by a visible step), and the
 * component re-renders only when the bar changes (spoken value, caption, section).
 *
 * With `onLoopChange`, the shown loop gets two edge handles that drag (or arrow-key) its start and
 * end a whole bar at a time; note-level edges stay a stage affair (U21).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { toNumber } from '../core/music/rational'
import { useFadePresence } from './fade'
import { stepLoop, type LoopEdge, type LoopRange } from './loopStep'
import {
  dragLoopEdge,
  fractionAt,
  loopExtent,
  occAtFraction,
  occAtPosition,
  progressAt,
  sectionAt,
  sectionMarkers,
  tickPath,
  TICK_VIEWBOX_WIDTH,
  type OverviewMeasure,
} from './overviewMath'
import styles from './ScoreOverview.module.css'

/** A live position in whole notes (the practice session's progress), followed without re-rendering. */
export interface OverviewPositionSource {
  get(): number
  subscribe(fn: (position: number) => void): () => void
}

/**
 * While following, the fill and the marker move in steps of 1/4096 of the overview: under one
 * device pixel on any screen the app targets, so motion looks continuous, while a long piece
 * writes styles a few times per second instead of every frame.
 */
const FOLLOW_STEPS = 4096
/** The loop's fade in and out (entering and leaving Repeat mode, U14). */
export const LOOP_FADE_MS = 220

export interface ScoreOverviewProps {
  /**
   * One entry per unfolded measure occurrence; positions in whole notes (floats), seconds per bar
   * and section labels (`overviewMeasures(model)` builds them). Keep the array stable: geometry is
   * cached per array.
   */
  readonly measures: readonly OverviewMeasure[]
  /** Current position in whole notes (ignored when `follow` is given). */
  readonly position?: number
  /** Live position to follow (playback, practice); per-frame updates then cost no render. */
  readonly follow?: OverviewPositionSource
  /** Practice loop, inclusive of both boundary bars (or narrowed to its note-level edges). */
  readonly loop: LoopRange | null
  /** The bar (occurrence index) under the pointer; called at most once per animation frame while dragging. */
  readonly onScrub: (occ: number) => void
  /**
   * Given, the shown loop gets draggable start and end handles (whole bars; the dragged edge drops
   * its note-level position). Called with the new loop at most once per animation frame while
   * dragging, whenever the dragged edge's bar changes, and with the final value on release.
   */
  readonly onLoopChange?: (loop: LoopRange) => void
  /** Spoken position, e.g. "Bar 12 of 59". Default counts occurrences. */
  readonly describe?: (occ: number, count: number) => string
  readonly disabled?: boolean
}

const defaultDescribe = (occ: number, count: number): string => `Bar ${occ + 1} of ${count}`

export function ScoreOverview({
  measures,
  position = 0,
  follow,
  loop,
  onScrub,
  onLoopChange,
  describe = defaultDescribe,
  disabled,
}: ScoreOverviewProps) {
  const ticks = useMemo(() => tickPath(measures), [measures])
  const tickLayer = useMemo(
    () => (
      <svg class={styles.ticks} viewBox={`0 0 ${TICK_VIEWBOX_WIDTH} 1`} preserveAspectRatio="none" aria-hidden="true">
        <path d={ticks} />
      </svg>
    ),
    [ticks],
  )
  const sectionLayer = useMemo(() => {
    const markers = sectionMarkers(measures)
    if (markers.length === 0) return null
    return (
      <div class={styles.sections} aria-hidden="true">
        {markers.map((m) => (
          <span
            key={m.occ}
            class={styles.section}
            data-testid="overview-section"
            title={m.label}
            style={{ left: `${m.left * 100}%`, maxWidth: `${m.room * 100}%` }}
          >
            <span class={styles.sectionLabel}>{m.label}</span>
          </span>
        ))}
      </div>
    )
  }, [measures])
  const root = useRef<HTMLDivElement>(null)
  const played = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const placed = useRef(Number.NaN)
  /** Played fill and marker at a fraction of the overview: two transforms, written only on change. */
  const place = (fraction: number): void => {
    if (fraction === placed.current) return
    placed.current = fraction
    if (played.current) played.current.style.transform = `scaleX(${fraction})`
    if (track.current) track.current.style.transform = `translateX(${fraction * 100}%)`
  }
  const followFraction = (p: number): number => Math.round(progressAt(measures, p) * FOLLOW_STEPS) / FOLLOW_STEPS
  // After every render (a prop change, or a re-render while following: then the live value).
  useLayoutEffect(() => place(follow ? followFraction(follow.get()) : progressAt(measures, position)))
  useEffect(() => {
    if (!follow) return undefined
    const sync = (p: number): void => {
      place(followFraction(p))
      if (occAtPosition(measures, p) !== currentRef.current) setFollowed(p)
    }
    sync(follow.get())
    return follow.subscribe(sync)
  }, [follow, measures])
  const scrub = useRef({ onScrub, onLoopChange, measures })
  scrub.current = { onScrub, onLoopChange, measures }
  /**
   * The pointer drag in progress: a scrub, or a loop edge drag (`base` is the loop when it began;
   * the edge that is not dragged keeps its value from it).
   */
  const drag = useRef<{
    pointer: number
    edge: LoopEdge | null
    base: LoopRange | null
    pending: number | null
    emitted: number | null
    moved: boolean
    frame: number
  } | null>(null)

  useEffect(
    () => () => {
      const d = drag.current
      if (d && d.frame !== 0) cancelAnimationFrame(d.frame)
    },
    [],
  )

  // Following: re-render only when the bar under the position changes.
  const [followed, setFollowed] = useState(() => follow?.get() ?? 0)
  const shownPosition = follow ? followed : position
  const count = measures.length
  const current = occAtPosition(measures, shownPosition)
  const currentRef = useRef(current)
  currentRef.current = current
  const section = count > 0 ? sectionAt(measures, current) : undefined
  const extent = loop
    ? loopExtent(
        measures,
        loop.fromOcc,
        loop.toOcc,
        loop.start ? toNumber(loop.start) : undefined,
        loop.end ? toNumber(loop.end) : undefined,
      )
    : null
  const inactive = disabled || count === 0
  // Entering and leaving Repeat mode (U14): the loop fades and scales in, and out again over the
  // last extent it had.
  const loopPresence = useFadePresence(extent !== null, LOOP_FADE_MS)
  const lastExtent = useRef(extent)
  if (extent) lastExtent.current = extent
  const shownExtent = extent ?? lastExtent.current
  const showHandles =
    onLoopChange !== undefined && !inactive && (loopPresence.phase === 'visible' || loopPresence.phase === 'entering')

  const occAt = (event: PointerEvent): number => {
    const rect = (root.current as HTMLDivElement).getBoundingClientRect()
    return occAtFraction(scrub.current.measures, fractionAt(event.clientX, rect.left, rect.width))
  }

  /** Emits the bar under the pointer: a seek, or the loop with the dragged edge on that bar (once per edge bar). */
  const emit = (occ: number): void => {
    const d = drag.current
    if (!d) return
    if (d.edge && d.base) {
      const next = dragLoopEdge(d.base, d.edge, occ, scrub.current.measures.length - 1)
      const at = d.edge === 'start' ? next.fromOcc : next.toOcc
      if (d.emitted === at) return
      d.emitted = at
      scrub.current.onLoopChange?.(next)
      return
    }
    if (d.emitted === occ) return
    d.emitted = occ
    scrub.current.onScrub(occ)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (inactive || event.button !== 0 || !root.current) return
    root.current.setPointerCapture?.(event.pointerId)
    drag.current = {
      pointer: event.pointerId,
      edge: null,
      base: null,
      pending: null,
      emitted: null,
      moved: false,
      frame: 0,
    }
    emit(occAt(event)) // a tap seeks at once; the drag is throttled below
  }

  /** A pointer down on a loop handle starts an edge drag instead of a scrub (and never seeks). */
  const onHandleDown = (edge: LoopEdge, event: PointerEvent): void => {
    event.stopPropagation()
    if (inactive || event.button !== 0 || !root.current || !loop) return
    root.current.setPointerCapture?.(event.pointerId)
    // A whole-bar edge already sits on its bar: dragging within it emits nothing. A note-level
    // edge snaps to its bar's barline as soon as the drag moves.
    const at = edge === 'start' ? (loop.start ? null : loop.fromOcc) : loop.end ? null : loop.toOcc
    drag.current = { pointer: event.pointerId, edge, base: loop, pending: null, emitted: at, moved: false, frame: 0 }
  }

  const onHandleKey = (edge: LoopEdge, event: KeyboardEvent): void => {
    // The overview's own keys would seek: a focused handle keeps them.
    if (/^(Arrow(Left|Right|Up|Down)|Home|End)$/u.test(event.key)) event.stopPropagation()
    const dir = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (dir === 0 || inactive || !loop) return
    event.preventDefault()
    const next = stepLoop(loop, edge, dir, current, count - 1)
    if (next) onLoopChange?.(next)
  }

  const onPointerMove = (event: PointerEvent): void => {
    const d = drag.current
    if (!d || d.pointer !== event.pointerId) return
    d.pending = occAt(event)
    d.moved = true
    if (d.frame === 0) {
      d.frame = requestAnimationFrame(() => {
        d.frame = 0
        if (d.pending !== null) emit(d.pending)
        d.pending = null
      })
    }
  }

  const endDrag = (event: PointerEvent): void => {
    const d = drag.current
    if (!d || d.pointer !== event.pointerId) return
    if (d.frame !== 0) cancelAnimationFrame(d.frame)
    if (event.type === 'pointerup' && (!d.edge || d.moved)) emit(occAt(event))
    drag.current = null
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (inactive) return
    const last = count - 1
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? Math.min(last, current + 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? Math.max(0, current - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (target === null) return
    event.preventDefault()
    if (target !== current) onScrub(target)
  }

  return (
    <div
      ref={root}
      class={styles.overview}
      role="slider"
      tabIndex={inactive ? -1 : 0}
      aria-label="Piece overview"
      aria-orientation="horizontal"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, count)}
      aria-valuenow={count === 0 ? 0 : current + 1}
      aria-valuetext={
        count === 0 ? 'No score' : section ? `${describe(current, count)}, ${section}` : describe(current, count)
      }
      aria-disabled={inactive || undefined}
      data-disabled={inactive || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      {tickLayer}
      <div ref={played} class={styles.played} />
      {sectionLayer}
      {loopPresence.mounted && shownExtent ? (
        <div
          class={styles.loop}
          data-testid="overview-loop"
          data-phase={loopPresence.phase}
          style={{ left: `${shownExtent.left * 100}%`, width: `${shownExtent.width * 100}%` }}
        />
      ) : null}
      {showHandles && extent && loop
        ? (['start', 'end'] as const).map((edge) => {
            const occ = edge === 'start' ? loop.fromOcc : loop.toOcc
            const exact = edge === 'start' ? loop.start : loop.end
            const x = edge === 'start' ? extent.left : extent.left + extent.width
            return (
              <div
                key={edge}
                class={styles.handle}
                data-edge={edge}
                data-testid={`overview-loop-${edge}`}
                data-phase={loopPresence.phase}
                role="slider"
                tabIndex={0}
                aria-label={edge === 'start' ? 'Overview loop start' : 'Overview loop end'}
                aria-orientation="horizontal"
                aria-valuemin={1}
                aria-valuemax={count}
                aria-valuenow={occ + 1}
                aria-valuetext={exact ? `${describe(occ, count)}, inside the bar` : describe(occ, count)}
                style={{ left: `${x * 100}%` }}
                onPointerDown={(event) => onHandleDown(edge, event)}
                onKeyDown={(event) => onHandleKey(edge, event)}
              />
            )
          })
        : null}
      <div ref={track} class={styles.markerTrack}>
        <div class={styles.marker} data-testid="overview-marker" />
      </div>
      {count > 0 ? (
        <span class={styles.caption} aria-hidden="true">
          {current + 1} / {count}
        </span>
      ) : null}
    </div>
  )
}
