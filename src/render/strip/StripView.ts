import { bindScoreLanguage } from '../shared/scoreLanguage'
/**
 * The practice strip (spec "Practice screen", "Persistent score labels" layout, ottava paragraphs
 * of "Mistake feedback and hints", "Execution and rendering architecture"). Framework-free DOM:
 * the score's graphics stay outside Preact reconciliation.
 *
 * - Shows a `PreparedLayout` as mounted segments (viewport ± one viewport, bounded LRU).
 * - Cursor rests ~1/3 across the viewport; the music scrolls beneath it with transform-only
 *   updates, including at the first and final notes. The translucent cursor is above the music
 *   (its own layer: while the music scrolls it does not move at all), as tall as the staves plus a
 *   margin that fades out; position → x glides across barlines and is smoothed while following a
 *   continuously moving transport (R12). A loop wrap pans back quickly (`wrapTo`).
 * - Live updates to learner notes, ottava emphasis and label opacity write to mounted nodes,
 *   batched in one requestAnimationFrame and O(changed notes). Nothing is re-engraved.
 * - Pinch/ctrl-wheel zoom is a CSS scale (R2); a pinch coasts on release and gives a little past its limits; while
 *   browsing is enabled a finger swipes natively (`SwipeScroller`), a mouse drags;
 *   passage selection with handles (snapping to note onsets, U21), tap selection and a clear
 *   button; the playhead itself can be dragged onto a note while nothing plays (U23).
 * - A new engraving of the same score with other spacing (Labels Off ↔ on) glides in from the
 *   previous view's columns, the cursor note staying under the fixed line (`respaceFrom`).
 */
import type { TimingDirection } from '../../core/model/practice'
import type { Rational } from '../../core/music/rational'
import { canvasMeasurer, estimateMeasurer, loadLabelFont, type TextMeasurer } from '../labels/metrics'
import {
  CORRECTION_LEAVE_MS,
  CORRECTION_STAGGER_MS,
  buildCorrection,
  correctionsKey,
  layoutCorrections,
  type CorrectionMark,
} from '../shared/corrections'
import { REMINDER_LEAVE_MS, buildReminder, layoutReminders, remindersKey, type ReminderMark } from '../shared/reminders'
import { ACTION_RADIUS, staffGap } from '../shared/cursorAction'
import { TimingCue } from '../shared/timingCue'
import {
  collectPieces,
  standardEasing,
  startRespace,
  wider,
  type RespaceRun,
  type RespaceSnapshot,
  type ScreenFrame,
} from '../shared/respace'
import type { LabelBox, PreparedLayout } from '../types'
import { clampRange, sameRange, tapSelect, type LoopRange } from './loop'
import { CursorPath } from './cursorPath'
import { cubicBezier, parseEasing, type Easing } from './glide'
import {
  clampTranslate,
  occAtPosition,
  occAtX,
  scrollTranslate,
  verticalTranslate,
  visibleRange,
  zoomAround,
} from './scroll'
import { clampReviewTranslate, reviewEase, reviewFrame } from './review'
import { PinchSpeed, stepZoom, stretchFor, stretchSlope, stretchSource, type ZoomMotion } from './stretch'
import { SwipeScroller } from './swipe'
import { SegmentStore, type MountedSegment } from './segments'
import {
  buildCursorKnots,
  buildLoopKnots,
  edgeLimits,
  firstKnotAtOrAfter,
  knotAtPosition,
  loopEdgeX,
  nearestKnot,
  passageFromKnots,
  passagePositions,
  type CursorKnots,
  type LoopKnots,
} from './snap'
import './strip.css'

export type { LoopRange } from './loop'

export type { CorrectionMark } from '../shared/corrections'
export type { ReminderMark } from '../shared/reminders'

export interface StripOptions {
  /** Fraction of the viewport where the cursor rests (default 1/3). */
  readonly cursorAnchor?: number
  readonly initialZoom?: number
  readonly minZoom?: number
  readonly maxZoom?: number
  /** Notation kept mounted beyond each side of the viewport, in viewports (default 1). */
  readonly overscan?: number
  /** New segment parses per frame outside the visible range (default 1). */
  readonly mountBudget?: number
  /** Detached segments kept for quick re-attachment (default 12: about three viewports of measure-sized segments). */
  readonly cacheSegments?: number
  /** Built-in "Return to current position" button while browsing (default true). */
  readonly returnButton?: boolean
  readonly returnLabel?: string
  /**
   * The circular button on the cursor bar was pressed (shown with `setCursorAction(true)`).
   * Accessible name `cursorActionLabel` (default "Repeat from here"). The cursor line is fixed on
   * screen, so while browsing the button sits over another bar than the position last set with
   * `setCursor`: `occ` is then the bar under the line (browsing ends with the press); otherwise
   * it is undefined and the action belongs to the cursor's own position.
   */
  readonly onCursorAction?: (occ?: number) => void
  readonly cursorActionLabel?: string
  /**
   * The playhead was dragged onto a note and released (U23; only while `setCursorDraggable(true)`).
   * Return `false` when the position cannot be taken: the score returns to its prior position.
   */
  readonly onCursorSeek?: (position: Rational) => boolean | void
  /** Readout shown above the dragged playhead, e.g. "Bar 12, beat 3" (called when the note changes). */
  readonly cursorDragLabel?: (position: Rational) => string
  /** Accessible name of the keyboard-focusable playhead grip (default "Playhead: drag or use arrow keys"). */
  readonly cursorLabel?: string
  readonly onBrowse?: (browsing: boolean) => void
  /**
   * The browse gesture was released (U95): the last finger of a drag that browsed lifted or was
   * canceled, a wheel / trackpad browse went idle for `WHEEL_RELEASE_MS`, or a loop handle drag
   * that scrolled the music (and so started browsing) ended. Browsing itself goes on until the
   * owner returns to the cursor. Called after `onLoopChange` for a handle drag.
   */
  readonly onBrowseRelease?: () => void
  /** Tap on a measure outside selection mode. */
  readonly onSeekRequest?: (occ: number) => void
  /** Handle drag end, tap selection, keyboard nudge, or the clear button (null). */
  readonly onLoopChange?: (range: LoopRange | null) => void
  readonly onLoopSelectModeChange?: (mode: LoopSelectMode) => void
  /** Note indices whose labels became visible in the viewport (assistance tracking). */
  readonly onVisibleLabels?: (added: readonly number[]) => void
  readonly onZoomChange?: (scale: number) => void
  /**
   * The lowest zoom the review after a completed pass zooms out to (`setReview`, U97; default
   * `REVIEW_MIN_ZOOM`, never below `minZoom`): the notation and the teacher's marks stay legible.
   */
  readonly reviewMinZoom?: number
}

export type LoopSelectMode = 'off' | 'tap'

export interface StripStats {
  readonly segments: number
  readonly mountedSegments: number
  readonly mountedNodes: number
  readonly cachedSegments: number
  readonly cachedBytes: number
  readonly labelNodes: number
  readonly parsedSegments: number
  /** Elements in the strip root (everything this view put in the document). */
  readonly domNodes: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const TARGET = 1
const ACCEPTED = 2
const FLAG_CLASSES: readonly [number, string][] = [
  [TARGET, 'pn-target'],
  [ACCEPTED, 'pn-acc'],
]
const TAP_SLOP = 8
/** A touch that has gone this far sideways, this long after it landed, without a native pan drags by itself. */
const TOUCH_DRAG_PX = 24
const TOUCH_DRAG_MS = 180
/** Wheel / trackpad browsing has no finger to lift: this long without a wheel event is the release (U95). */
export const WHEEL_RELEASE_MS = 250
/** Pointer distance from a strip edge where a drag scrolls the music (px). */
const EDGE_ZONE = 40
/** Fastest edge scroll while dragging the playhead or a loop handle (px per frame). */
const EDGE_SPEED = 18
/** Scroll jumps longer than this many viewports are applied without animation. */
const FAR_JUMP_VIEWPORTS = 1.5
/** A loop wrap (`wrapTo`) at most this many viewports long pans all the way; longer ones jump. */
const WRAP_PAN_VIEWPORTS = 2.5
/** A long wrap first lands this many viewports short of its target, then pans the rest. */
const WRAP_LEAD_VIEWPORTS = 1.5
/** The wrap pan's duration (strip.css `--pn-wrap-ms`); the wrap state ends a little after it. */
const WRAP_MS = 320
/** The wrap pan's easing (strip.css `.pn-wrap`). */
const WRAP_EASE = cubicBezier(0.22, 1, 0.36, 1)
/** The spring that brings the music back to the cursor after browsing, per second (critically damped). */
const RETURN_RATE = 15
/** The cursor moved by more than this in a frame (px): a seek, taken into the return, not followed. */
const RETURN_SEEK_PX = 48
/** A seek's glide (strip.css `--pn-scroll-ms`). */
const SCROLL_MS = 180
/** Below this band width on screen (px) the loop's ✕ is drawn small (U14). */
const CLEAR_SMALL_PX = 150
/** Cursor bar margin beyond the top and bottom staves, faded by its mask (screen px). */
const CURSOR_MARGIN = 96
/** Space kept above the top staff and below the bottom staff when fitting zoom (layout px). */
const STAFF_MARGIN = 28
/** Fade distance to the right of the fixed clef/key/meter, in layout px. */
const CONTEXT_FADE = 32
/** The review's lowest zoom by default (U97): 13 px correction labels stay about 8 px on screen. */
export const REVIEW_MIN_ZOOM = 0.6
/** Zooming out to the review, and back in when the next pass begins (ms). */
export const REVIEW_OUT_MS = 650
export const REVIEW_IN_MS = 420
/**
 * Continuous following (R12): consecutive `smooth: false` calls advancing by at most this many
 * whole notes are one motion (a transport sampled per frame), not seeks.
 */
const FOLLOW_MAX_STEP = 0.25

interface LabelNode {
  readonly text: SVGTextElement
  readonly leader: SVGLineElement | null
  str: string
  opacity: number
}

interface Pointer {
  x: number
  y: number
}

const icon = {
  left: '<svg viewBox="0 0 18 30" aria-hidden="true"><path d="M13 4L4 15l9 11" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right:
    '<svg viewBox="0 0 18 30" aria-hidden="true"><path d="M5 4l9 11-9 11" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clear:
    '<svg viewBox="0 0 34 34" aria-hidden="true"><path d="M8 8l18 18M26 8L8 26" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l-6 6 6 6M4 12h16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  repeat:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2.5l3 3-3 3M4 11.5v-1a5 5 0 0 1 5-5h11M7 21.5l-3-3 3-3M20 12.5v1a5 5 0 0 1-5 5H4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

export class StripView {
  private readonly layout: PreparedLayout
  private readonly opts: StripOptions
  private readonly root: HTMLDivElement
  private readonly stage: HTMLDivElement
  private readonly content: HTMLDivElement
  private readonly swipe: SwipeScroller
  private readonly segLayer: HTMLDivElement
  private readonly cursorEl: HTMLDivElement
  private readonly timingCue: TimingCue
  private readonly cursorBar: HTMLDivElement
  private readonly cursorBtn: HTMLButtonElement
  private readonly cursorGrip: HTMLDivElement
  private readonly readoutEl: HTMLDivElement
  private readonly contextWidth: number
  private readonly path: CursorPath
  private readonly stickyEl: HTMLDivElement
  private readonly stickyInner: HTMLDivElement
  private readonly stickyStaff: HTMLDivElement
  private readonly loopEl: HTMLDivElement
  /** Quiet pencil reminders (`setReminders`): layout px inside the content, below corrections. */
  private readonly reminderLayer: HTMLDivElement
  /** Teacher's corrections (`setCorrections`): layout px inside the content, above the notation. */
  private readonly corrLayer: HTMLDivElement
  private readonly startHandle: HTMLButtonElement
  private readonly endHandle: HTMLButtonElement
  private readonly clearBtn: HTMLButtonElement
  private readonly store: SegmentStore

  private readonly flags: Uint8Array
  private readonly dirtyNotes = new Set<number>()
  private readonly lists = new Map<number, ReadonlySet<number>>()
  private readonly marks = new Map<number, SVGEllipseElement>()

  private readonly noteText = new Map<number, string>()
  private readonly noteOpacity: Float32Array
  private readonly visibleOpacityNotes = new Set<number>()
  private readonly dirtyLabels = new Set<number>()
  private readonly labelNodes = new Map<number, LabelNode>()
  private visibleLabelIds = new Set<number>()
  private labelsChanged = true

  private cursorX: number
  /** The first cursor stop: the farthest back the browsed score can go (U96). */
  private readonly firstCursorX: number
  /** Last `smooth: false` position (follow detection) and where the current follow began. */
  private followPos: number | null = null
  /** `pn-follow` on the root while following a transport (no note fill transitions). */
  private following = false
  private cursorAction = false
  /**
   * A loop wrap in progress (`wrapTo`): 'lead' places a long wrap short of its target without a
   * transition, 'pan' animates the content to the target under `pn-wrap`. `from` and `to` are the
   * translates the pan sweeps between (kept mounted).
   */
  private wrap: { phase: 'lead' | 'pan'; from: number; to: number } | null = null
  private wrapTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * A glide drawn frame by frame (`glideTx`) from the translate `from`, starting at `t0`, toward
   * the live target (`tx`). `wrap`: a wrap's pan, which keeps its timing while the transport moves on.
   */
  private glide: { from: number; t0: number; dur: number; ease: Easing; wrap: boolean } | null = null
  /** The last glide left to a CSS transition: where it is on screen is estimated from it. */
  private cssGlide: { from: number; to: number; t0: number; dur: number; ease: Easing } | null = null
  /** The translate the last frame aimed at. */
  private glideTarget = NaN
  /** A seek's easing (strip.css `--pn-ease`, read once). */
  private readonly scrollEase: Easing
  /** Loop controls fading out (U14): hidden on `animationend`, or by this fallback timer. */
  private ctlLeaveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  /** Effective zoom: `requestedZoom` clamped to fit the strip (`clampZoom`). */
  private scale: number
  /** The zoom last asked for (option, `setZoom`, pinch, ctrl-wheel); resizes re-fit from it. */
  private requestedZoom: number
  private tx = 0
  private ty = 0
  private applied = {
    tx: NaN,
    ty: NaN,
    scale: NaN,
    cursorSx: NaN,
    barTop: NaN,
    barH: NaN,
    actionTop: NaN,
    cursorOpacity: 1,
  }
  private hostW = 0
  private hostH = 0
  private instant = true
  private browsing = false
  private browseTx = 0
  private browseEnabled = false
  /** The way back from browsing: how far the music still is from the cursor's frame (px), springing to 0. */
  private back: { x: number; v: number; t: number; target: number } | null = null

  private ottavaSpans: number[] = []
  private readonly ottavaBoxes = new Map<number, HTMLDivElement>()
  private readonly reminders = new Map<number, HTMLDivElement>()

  /** Identity of the corrections last asked for; `pendingCorrections` waits for the next frame. */
  private corrKey = ''
  private pendingCorrections: readonly CorrectionMark[] | null = null
  private corrLeaveTimer: ReturnType<typeof setTimeout> | null = null
  private corrMeasurer: TextMeasurer | null = null
  /** Identity of the reminders last asked for; `pendingReminders` waits for the next frame. */
  private reminderKey = ''
  private pendingReminders: readonly ReminderMark[] | null = null
  private reminderLeaveTimer: ReturnType<typeof setTimeout> | null = null

  private loop: LoopRange | null = null
  /**
   * Last applied loop band: range object, controls shown, zoom, band width and center (layout px;
   * the leaving band shrinks into the cursor from them).
   */
  private loopShown: { r: LoopRange | null; show: boolean; scale: number; width: number; mid: number } = {
    r: null,
    show: false,
    scale: NaN,
    width: 0,
    mid: 0,
  }
  /** Note onsets of the hands (exact) the playhead and loop edges snap to; null until set. */
  private snapSource: readonly Rational[] | null = null
  private cursorKnots: CursorKnots
  private loopKnots: LoopKnots
  private cursorDraggable = false
  private loopEditable = true
  private selectMode: LoopSelectMode = 'off'
  private tapAnchor: number | null = null
  private stickyMask = ''
  private stickyShift = NaN
  private stickyTransform = ''
  private stickyContext = -1

  private readonly pointers = new Map<number, Pointer>()
  private gesture: {
    startX: number
    startY: number
    startTx: number
    t: number
    moved: boolean
    /** A finger or pen: its swipe is native (`swipe`), only its tap is handled here. */
    touch: boolean
  } | null = null
  private pinch: { dist: number; scale: number; speed: PinchSpeed } | null = null
  /**
   * What is drawn on top of the zoom, around screen x `stretchX` (1 at rest): a pinch past the
   * limits, and a released zoom while it coasts or bounces (`zoomMotion`). Display only: the zoom
   * is set (and reported) once the motion lands.
   */
  private stretch = 1
  private stretchX = 0
  private zoomMotion: (ZoomMotion & { t: number }) | null = null
  private zoomLanded = false
  private handleDrag: {
    pointerId: number
    which: 'start' | 'end'
    range: LoopRange
    knot: number
    lo: number
    hi: number
    rootLeft: number
    rootW: number
    clientX: number
  } | null = null
  /** Playhead drag (U23): starts on the cursor's grip, becomes a drag past the tap slop. */
  private cursorDrag: {
    pointerId: number
    startX: number
    startY: number
    rootLeft: number
    rootW: number
    clientX: number
    moved: boolean
    /** Begun while browsing: the cursor moves over the still music instead of the music under it. */
    free: boolean
    knot: number
    /** Where the cursor really is (restored on cancel or refusal; follows `setCursor` meanwhile). */
    restoreX: number
  } | null = null
  /** Content translate while a drag holds (and edge-scrolls) the music; null otherwise. */
  private dragTx: number | null = null
  private dragScrolled = false
  private edgeSpeed = 0
  private edgeFrame = 0
  /** A pointer drag browsed during the current touch: its last pointer up is the release (U95). */
  private browseDragged = false
  /** Pending wheel-idle release (`WHEEL_RELEASE_MS` after the last wheel browse); 0 when none. */
  private wheelRelease: ReturnType<typeof setTimeout> | 0 = 0

  private respace: RespaceRun | null = null

  /**
   * The review after a completed pass (`setReview`, U97): `reviewOn` is what the owner asked for;
   * `reviewP` blends the playing frame (0) into the review frame (1), animated by `reviewAnim`
   * (`t0` is taken at its first frame). `reviewManual` is a review frame the learner panned or
   * pinched; `reviewFrozen` holds the frame a zoom back in leaves from. `reviewInset` is the
   * screen height kept free at the bottom (the result card), `reviewTop` at the top (overlays).
   */
  private reviewOn = false
  private reviewP = 0
  private reviewAnim: { from: number; to: number; t0: number; dur: number } | null = null
  private reviewManual: { tx: number; scale: number } | null = null
  private reviewFrozen: { tx: number; ty: number; scale: number } | null = null
  private reviewInset = 0
  private reviewTop = 0
  /** The scale on screen (the zoom, or a blend toward the review's); `--pn-zoom` as last written. */
  private shown = 1
  private zoomProp = NaN

  private frame = 0
  private destroyed = false
  private readonly resize: ResizeObserver | undefined
  private readonly cleanup: (() => void)[] = []

  constructor(host: HTMLElement, layout: PreparedLayout, opts: StripOptions = {}) {
    this.layout = layout
    this.opts = opts
    this.flags = new Uint8Array(layout.notes.length)
    this.noteOpacity = new Float32Array(layout.notes.length)
    this.contextWidth = layout.contexts.reduce((width, ctx) => Math.max(width, ctx.width), 0)
    this.scale = this.clampZoom(opts.initialZoom ?? 1)
    this.requestedZoom = this.scale
    this.shown = this.scale
    this.path = new CursorPath(layout.occurrences)
    this.cursorX = this.path.at(layout.occurrences[0]?.start ?? 0)
    this.firstCursorX = this.cursorX
    this.cursorKnots = buildCursorKnots(this.path, [])
    this.loopKnots = buildLoopKnots(layout.occurrences, null)
    const doc = host.ownerDocument
    const div = (cls: string): HTMLDivElement => {
      const d = doc.createElement('div')
      d.className = cls
      return d
    }

    this.root = div('pn-strip pn-instant')
    // A group, not an img: an img's children are presentational, hiding the strip's buttons.
    this.root.setAttribute('role', 'group')
    this.stage = div('pn-stage')
    this.content = div('pn-content')
    this.content.style.width = `${layout.width}px`
    this.content.style.height = `${layout.height}px`

    this.loopEl = div('pn-loop')
    this.loopEl.style.height = `${layout.height}px`
    this.segLayer = div('pn-segs')
    this.reminderLayer = div('pn-reminders')
    this.reminderLayer.setAttribute('aria-hidden', 'true')
    this.corrLayer = div('pn-corrs')
    this.corrLayer.setAttribute('aria-hidden', 'true')
    // Screen-space cursor, outside the scrolled content; its bar spans the staves (applyCursorBar).
    this.cursorEl = div('pn-cursor')
    const bar = div('pn-cursor-bar')
    this.cursorBar = bar
    // A 44 px transparent grip over the bar, live only while the playhead can be dragged (U23).
    const grip = div('pn-cursor-grip')
    grip.setAttribute('data-testid', 'cursor-grip')
    // Keyboard: a slider over the snap onsets (arrow keys step notes, Shift bars, Home / End).
    grip.setAttribute('role', 'slider')
    grip.setAttribute('aria-orientation', 'horizontal')
    grip.tabIndex = 0
    grip.toggleAttribute('inert', true)
    this.cursorGrip = grip
    this.readoutEl = div('pn-cursor-readout')
    this.readoutEl.setAttribute('aria-hidden', 'true')
    this.cursorBtn = this.button('pn-cursor-action', icon.repeat, '')
    this.cursorBtn.toggleAttribute('inert', true)
    // Without a handler the button is never shown, so it is not in the DOM.
    this.cursorEl.append(bar, grip, this.readoutEl)
    if (opts.onCursorAction) this.cursorEl.append(this.cursorBtn)

    this.startHandle = this.button('pn-loop-ctl pn-handle pn-handle-start', icon.left, '')
    this.endHandle = this.button('pn-loop-ctl pn-handle pn-handle-end', icon.right, '')
    this.clearBtn = this.button('pn-loop-ctl pn-loop-clear', icon.clear, '')

    this.content.append(
      this.loopEl,
      this.segLayer,
      this.reminderLayer,
      this.corrLayer,
      this.startHandle,
      this.endHandle,
      this.clearBtn,
    )
    this.stickyEl = div('pn-sticky')
    this.stickyEl.setAttribute('aria-hidden', 'true')
    this.stickyInner = div('pn-sticky-inner')
    this.stickyStaff = div('pn-sticky-staff')
    this.stickyEl.append(this.stickyStaff, this.stickyInner)
    this.root.classList.toggle('pn-pin-opening', layout.contextChanges[0]?.openingX !== undefined)
    this.stage.append(this.content)
    this.swipe = new SwipeScroller(doc, {
      width: () => this.hostW,
      tx: () => (Number.isNaN(this.applied.tx) ? this.tx : this.applied.tx),
      range: () => this.browseRange(),
      begin: () => this.swipeBegan(),
      move: () => this.schedule(),
      settle: (tx) => this.swipeSettled(tx),
    })
    // Under the stage: the music lets touches through to it, its loop controls do not.
    this.root.append(this.swipe.el, this.stage, this.stickyEl, this.cursorEl)
    if (opts.returnButton !== false) {
      const ret = this.button('pn-score-action pn-return', `${icon.back}<span></span>`, '')
      ret.addEventListener('click', () => this.returnToCurrent())
      this.root.append(ret)
    }
    this.cleanup.push(bindScoreLanguage(this.root, opts))
    this.timingCue = new TimingCue(host, this.root, bar)
    let ease = ''
    try {
      ease = getComputedStyle(this.root).getPropertyValue('--pn-ease')
    } catch {
      // No computed style (tests): the fallback below.
    }
    this.scrollEase = parseEasing(ease, [0.2, 0.8, 0.2, 1])

    this.store = new SegmentStore(
      layout,
      this.segLayer,
      {
        attached: (seg) => this.onAttached(seg),
        detaching: (seg) => this.onDetaching(seg),
      },
      opts.cacheSegments ?? 12,
    )

    this.bindEvents()
    this.measureHost()
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => {
        this.settleZoom()
        const width = this.hostW
        this.measureHost()
        if (this.hostW !== width && this.swipe.active) {
          this.swipe.stop()
          this.swipeSettled(this.tx)
        }
        this.instant = true
        this.schedule()
      })
      this.resize.observe(this.root)
    }
    this.root.style.setProperty('--pn-label-px', `${layout.params.labelFontPx}px`)
    // A cached layout skips preparation: fetch the label font now, before labels are shown.
    void loadLabelFont(doc, layout.params.labelFontPx)
    this.setZoomProperties()
    this.schedule()
  }

  // ---------------------------------------------------------------- public API

  /**
   * Moves the cursor to a performance position (whole notes). `smooth` animates the scroll
   * (default true). Calls with `smooth: false` that keep advancing by small steps (a transport
   * sampled every frame) are one continuous motion: x is smoothed so the score glides at a steady
   * speed instead of changing speed at every onset; any other call lands exactly on its onset.
   */
  setCursor(position: number, opts: { smooth?: boolean } = {}): void {
    const instant = opts.smooth === false
    const prev = this.followPos
    const follow = instant && prev !== null && position >= prev - 1e-9 && position - prev <= FOLLOW_MAX_STEP
    this.followPos = instant ? position : null
    if (this.cursorDrag?.moved) {
      // The gesture owns the displayed position; remember the real position for cancellation.
      this.cursorDrag.restoreX = this.path.at(position)
      return
    }
    // While following playback, highlights switch at their onsets without the 120 ms fill fade:
    // many notes change per second, and each fade repaints the notation every frame (PF3).
    if (follow !== this.following) {
      this.following = follow
      this.root.classList.toggle('pn-follow', follow)
    }
    // The same smooth path serves playback and seeks. It is exact at every onset, so entering
    // continuous following needs no blend with a linear path (which would retain speed jumps).
    const x = this.path.smoothAt(position)
    if (x === this.cursorX) return
    // A seek elsewhere ends a wrap; a transport moving on from the wrap's target keeps it going.
    if (this.wrap && !follow) this.endWrap()
    this.cursorX = x
    if (instant) this.instant = true
    this.schedule()
  }

  /**
   * The transport returned to the start of a loop or piece (`position`, whole notes): the music
   * pans back quickly (320 ms ease-out, `pn-wrap`) to put that position under the fixed cursor. A wrap
   * longer than 2.5 viewports does not sweep every bar: the content lands 1.5 viewports short of
   * the target (on the side it came from, no transition), then pans the rest on the next frame.
   * Later `setCursor(position, { smooth: false })` calls at the same position are no-ops, and a
   * transport moving on from there keeps the pan going; any other seek ends it.
   */
  wrapTo(position: number): void {
    this.followPos = position
    if (this.cursorDrag?.moved) {
      this.cursorDrag.restoreX = this.path.at(position)
      return
    }
    this.endWrap()
    this.back = null
    this.cursorX = this.path.smoothAt(position)
    if (this.reviewOn || this.reviewP > 0) {
      // Reviewing: the music stays put and the cursor glides back to the loop start over it.
      this.schedule()
      return
    }
    const to = this.cursorTranslate()
    const from = this.applied.tx
    const dist = to - from
    if (this.browsing || this.dragTx !== null || this.reducedMotion || Number.isNaN(from) || !(this.hostW > 0)) {
      this.instant = true
    } else if (dist !== 0) {
      const near = Math.abs(dist) <= this.hostW * WRAP_PAN_VIEWPORTS
      const lead = near ? from : to - Math.sign(dist) * this.hostW * WRAP_LEAD_VIEWPORTS
      this.wrap = { phase: near ? 'pan' : 'lead', from: lead, to }
    }
    this.schedule()
  }

  /**
   * Shows (fading in) or hides the circular action button centered on the cursor bar; pressing it
   * calls `StripOptions.onCursorAction`. Hidden, it is inert (no focus, no accessibility node).
   */
  setCursorAction(visible: boolean): void {
    if (visible === this.cursorAction) return
    this.cursorAction = visible
    this.cursorEl.classList.toggle('pn-action-on', visible)
    this.cursorBtn.toggleAttribute('inert', !visible)
    if (visible) this.schedule()
  }

  /** Currently required notes: colored noteheads with a soft halo. */
  setTargets(notes: readonly number[]): void {
    this.setFlag(TARGET, notes)
  }

  /** Notes already played correctly in the current group (kept until the group advances). */
  setAccepted(notes: readonly number[]): void {
    this.setFlag(ACCEPTED, notes)
  }

  setTimingCue(direction: TimingDirection | null, enabled = direction !== null): void {
    if (this.timingCue.set(direction, enabled)) this.schedule()
  }

  /**
   * A teacher's corrections after an attempt: a red-pen ring around each mark's notes with its
   * text above-right, on a layer that scrolls and zooms with the notation. Built once, in the next
   * frame, fading in left to right; the previous marks fade out. `[]` clears them. The same marks
   * again are a no-op. Never takes pointer events.
   */
  setCorrections(marks: readonly CorrectionMark[]): void {
    const key = correctionsKey(marks)
    if (key === this.corrKey) return
    this.corrKey = key
    this.pendingCorrections = marks
    this.schedule()
  }

  /**
   * Quiet pencil reminders at recent trouble spots: small ticks in the margin band beyond the
   * staves, on a layer below corrections that scrolls and zooms with the notation. Built once in
   * the next frame; `[]` clears them. The same marks again are a no-op. Never takes pointer events.
   */
  setReminders(marks: readonly ReminderMark[]): void {
    const key = remindersKey(marks)
    if (key === this.reminderKey) return
    this.reminderKey = key
    this.pendingReminders = marks
    this.schedule()
  }

  /** Ottava spans to emphasize (red, bold outline); an offscreen label gets a reminder at the cursor. */
  setOttavaEmphasis(spans: readonly number[]): void {
    const next = [...new Set(spans)].filter((s) => this.layout.ottavas[s]).sort((a, b) => a - b)
    if (next.length === this.ottavaSpans.length && next.every((s, i) => s === this.ottavaSpans[i])) return
    const prev = this.ottavaSpans
    this.ottavaSpans = next
    for (const seg of this.store.mounted.values()) {
      for (const s of prev) if (!next.includes(s)) seg.ottava.get(s)?.forEach((el) => el.classList.remove('pn-ott-on'))
      for (const s of next) seg.ottava.get(s)?.forEach((el) => el.classList.add('pn-ott-on'))
    }
    this.schedule()
  }

  /** Label text per note index (from core/naming). Notes missing from the map have no text. */
  setLabels(texts: ReadonlyMap<number, string>): void {
    for (const n of this.noteText.keys()) if (!texts.has(n)) this.touchNoteLabel(n)
    for (const [n, t] of texts) if (this.noteText.get(n) !== t) this.touchNoteLabel(n)
    this.noteText.clear()
    for (const [n, t] of texts) if (t) this.noteText.set(n, t)
    this.schedule()
  }

  /**
   * Label opacity per note (0..1, already eased by the caller; missing = 0). Callable every frame:
   * style writes only, nodes stay mounted (keeping their reserved space) until opacity reaches 0.
   */
  setLabelOpacity(opacity: ReadonlyMap<number, number>): void {
    for (const n of this.visibleOpacityNotes) {
      if (!opacity.has(n)) {
        this.noteOpacity[n] = 0
        this.touchNoteLabel(n)
      }
    }
    this.visibleOpacityNotes.clear()
    for (const [n, v] of opacity) {
      if (n < 0 || n >= this.noteOpacity.length) continue
      const o = v > 0 ? Math.min(1, v) : 0
      if (this.noteOpacity[n] !== Math.fround(o)) {
        this.noteOpacity[n] = o
        this.touchNoteLabel(n)
      }
      if (o > 0) this.visibleOpacityNotes.add(n)
    }
    if (this.dirtyLabels.size) this.schedule()
  }

  /** Shows a passage (whole boundary bars, or note-level edges inside them) or clears it. */
  setLoop(range: LoopRange | null): void {
    const r = range ? clampRange(range, this.layout.occurrences.length) : null
    if (sameRange(r, this.loop)) return
    // A handle held meanwhile was editing the old loop: its drag ends without committing.
    this.endHandleDrag()
    this.loop = r
    this.schedule()
  }

  /**
   * Note onsets (exact, ascending) of the current hands — all onsets in Listen — that the dragged
   * playhead and the loop edges snap to (U19, U21). Built once per call (O(bars + onsets)); the
   * same array again is a no-op.
   */
  setSnapPositions(onsets: readonly Rational[]): void {
    if (onsets === this.snapSource) return
    this.snapSource = onsets
    this.cursorKnots = buildCursorKnots(this.path, onsets)
    this.loopKnots = buildLoopKnots(this.layout.occurrences, onsets)
    if (this.cursorDrag?.moved) this.cancelCursorDrag()
  }

  /**
   * Lets the playhead be dragged onto a note (U23): a drag that starts on the cursor bar (not on
   * its action button) moves it, snapping to the snap onsets, scrolling near the strip's edges,
   * with a bar/beat readout; release calls `onCursorSeek`. Off while something plays.
   */
  setCursorDraggable(enabled: boolean): void {
    if (enabled === this.cursorDraggable) return
    this.cursorDraggable = enabled
    this.cursorEl.classList.toggle('pn-cursor-draggable', enabled)
    // Inert while off: no focus stop, no accessibility node (losing focus here is intended).
    this.cursorGrip.toggleAttribute('inert', !enabled)
    if (!enabled && this.cursorDrag) this.cancelCursorDrag()
  }

  /** Locks the handles and clear button (e.g. during a scored attempt). */
  setLoopEditable(editable: boolean): void {
    this.loopEditable = editable
    this.root.classList.toggle('pn-loop-locked', !editable)
    // A drag ended by the lock is over too: a browse it started is released (U95).
    if (!editable && this.endHandleDrag()) this.opts.onBrowseRelease?.()
    this.schedule()
  }

  /** 'tap': the next tap picks the first measure, the following tap the last. */
  setLoopSelectMode(mode: LoopSelectMode): void {
    if (mode === this.selectMode) return
    this.selectMode = mode
    this.tapAnchor = null
    this.opts.onLoopSelectModeChange?.(mode)
  }

  /** Allows drag/wheel inspection (spec: while paused). Disabling returns to the cursor. */
  setBrowseEnabled(enabled: boolean): void {
    this.browseEnabled = enabled
    this.root.classList.toggle('pn-browse-enabled', enabled)
    if (!enabled && this.browsing) this.returnToCurrent()
  }

  /** Notation scale (CSS transform, R2), anchored so the current event stays put. */
  setZoom(scale: number): void {
    this.settleZoom()
    this.userZoom(scale)
  }

  zoom(): number {
    return this.scale
  }

  /**
   * The review after a completed Repeat pass (U97): on, the strip zooms out (eased, `REVIEW_OUT_MS`)
   * to the largest zoom, at most the playing one, at which the whole loop fits beside the fixed
   * signatures and above `setReviewInset`, never below `reviewMinZoom` (then from the loop start),
   * and holds the music still while the cursor moves over it. Off, it zooms back in
   * (`REVIEW_IN_MS`) to the playing frame: the same zoom, the cursor note under the fixed line.
   * `returnBy` caps the zoom-in duration at the time left before the Keep time downbeat.
   * Reduced motion, or a strip not yet shown, switches at once. While on, a drag pans and a pinch
   * or ctrl-wheel zooms the review itself (never saved, nothing browsed), the loop controls hide
   * and the playhead cannot be dragged. Never re-engraves: the transform and the cursor's x only.
   */
  setReview(on: boolean, returnBy?: number): void {
    if (on === this.reviewOn) return
    this.endSwipe()
    this.settleZoom()
    if (!on) this.reviewFrozen = this.reviewTarget()
    this.reviewOn = on
    if (on) {
      this.reviewManual = null
      this.reviewFrozen = null
      this.endWrap()
      if (this.cursorDrag) this.cancelCursorDrag()
      if (this.browsing) this.returnToCurrent()
    }
    this.root.classList.toggle('pn-review', on)
    const to = on ? 1 : 0
    if (this.reducedMotion || !(this.hostW > 0) || Number.isNaN(this.applied.tx) || this.reviewP === to) {
      this.reviewP = to
      this.reviewAnim = null
      if (!on) this.reviewFrozen = null
    } else {
      const timed = !on && returnBy !== undefined
      const t0 = timed ? performance.now() : NaN
      const dur = on ? REVIEW_OUT_MS : REVIEW_IN_MS
      this.reviewAnim = { from: this.reviewP, to, t0, dur: timed ? Math.max(0, Math.min(dur, returnBy - t0)) : dur }
    }
    this.instant = true
    this.schedule()
  }

  /**
   * Screen px at the bottom (the result card over it) and at the top (the Repeat panel and banners
   * floating over the score) of the strip that the review keeps free (U97).
   */
  setReviewInset(bottom: number, top = 0): void {
    const b = Math.max(0, Math.round(bottom))
    const t = Math.max(0, Math.round(top))
    if (b === this.reviewInset && t === this.reviewTop) return
    this.reviewInset = b
    this.reviewTop = t
    if (this.reviewOn || this.reviewP > 0) {
      this.instant = true
      this.schedule()
    }
  }

  /** Whether the review is on (`setReview`), animating or not. */
  isReviewing(): boolean {
    return this.reviewOn
  }

  isBrowsing(): boolean {
    return this.browsing
  }

  /** Browsing only looks elsewhere: the cursor stays on its note (U151), so no other position is under it. */
  browsedPosition(): Rational | null {
    return null
  }

  returnToCurrent(): void {
    if (!this.browsing) return
    this.endSwipe()
    this.browsing = false
    this.root.classList.remove('pn-browsing')
    this.springBack()
    this.opts.onBrowse?.(false)
    this.schedule()
  }

  /** Measure index under a client x coordinate. */
  occAt(clientX: number): number {
    const rect = this.root.getBoundingClientRect()
    return occAtX(this.layout.occurrences, (clientX - rect.left - this.tx) / this.shown)
  }

  /** Notes whose labels are currently visible in the viewport. */
  visibleLabels(): number[] {
    const out: number[] = []
    for (const id of this.visibleLabelIds) out.push(...this.layout.labels[id]!.notes)
    return out.sort((a, b) => a - b)
  }

  stats(): StripStats {
    return {
      segments: this.layout.segments.length,
      mountedSegments: this.store.mounted.size,
      mountedNodes: this.store.mountedNodes(),
      cachedSegments: this.store.cachedCount(),
      cachedBytes: this.store.cachedBytes(),
      labelNodes: this.labelNodes.size,
      parsedSegments: this.store.parsed,
      domNodes: this.root.getElementsByTagName('*').length,
    }
  }

  /**
   * Applies pending changes now, from inside the caller's own animation frame (the practice
   * session's frame): a change made in a rAF callback would otherwise wait for the strip's rAF in
   * the next frame, one frame (~17 ms) late. No forced style read; nothing to do when idle.
   */
  flushFrame(): void {
    if (!this.frame || this.destroyed) return
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.flush()
  }

  /** Runs any pending frame work now (tests and measurements). */
  flushNow(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.flush()
    // Commit styles while the no-transition class is set, so a later frame removing it cannot
    // animate this synchronous jump.
    if (this.root.classList.contains('pn-instant')) void getComputedStyle(this.content).transform
  }

  // ---------------------------------------------------------------- respacing (R3 revised)

  /** A replacement waits for an active glide instead of snapping its slices to their end. */
  whenRespaced(): Promise<void> {
    return this.respace?.finished ?? Promise.resolve()
  }

  /**
   * Before this view gives way to `next` (the same score engraved with other spacing): where it
   * draws the music and, when its engraving is the wider one, its notation. Null while browsing,
   * dragging or wrapping, with reduced motion or before the strip has a size: the next view then
   * simply appears.
   */
  respaceSnapshot(next: PreparedLayout): RespaceSnapshot | null {
    if (this.destroyed || this.browsing || this.dragTx !== null || this.cursorDrag || this.wrap) return null
    if (this.reviewOn || this.reviewP > 0 || this.back) return null
    if (this.reducedMotion || !(this.hostW > 0) || !(this.hostH > 0)) return null
    this.respace?.cancel()
    return {
      layout: this.layout,
      frame: this.screenFrame(),
      pieces: wider(this.layout, next) === 'prev' ? collectPieces(this.store.mounted.values()) : null,
    }
  }

  /**
   * Glides the notes from where `prev` drew them to their places here; the cursor line is fixed,
   * so the cursor note stays put and everything else moves from there. Labels fade in after.
   */
  respaceFrom(prev: RespaceSnapshot | null): void {
    if (!prev || this.destroyed || this.reducedMotion || !(this.hostW > 0)) return
    this.flushNow()
    // Everything the glide may show is cut now: mount the strip ± one viewport at once.
    const view = visibleRange(this.tx, this.scale, this.hostW)
    const over = this.hostW / this.scale
    const wanted = this.store.wanted(view.x0 - over, view.x1 + over, this.cursorX)
    this.store.sync(wanted, new Set(wanted), 0)
    this.applyNotes()
    this.root.classList.add('pn-respacing')
    const prevSegments = new Map<number, number>()
    for (const s of prev.layout.segments) for (let o = s.occStart; o < s.occEnd; o++) prevSegments.set(o, s.index)
    this.respace = startRespace({
      prev,
      next: { layout: this.layout, frame: this.screenFrame() },
      nextPieces: () => collectPieces(this.store.mounted.values()),
      segmentOf: { prev: (occ) => prevSegments.get(occ) ?? -1, next: (occ) => this.store.segmentOfOcc(occ) },
      parent: this.stage,
      width: this.hostW,
      height: this.hostH,
      easing: standardEasing(this.root),
      onDone: () => {
        this.respace = null
        if (!this.destroyed) this.root.classList.remove('pn-respacing')
      },
    })
    if (!this.respace) this.root.classList.remove('pn-respacing')
  }

  /** Hides the labels (they fade) while a respaced engraving is being prepared to show them. */
  holdLabels(on: boolean): void {
    this.root.classList.toggle('pn-labels-held', on)
  }

  /** Layout px → root px as last applied. */
  private screenFrame(): ScreenFrame {
    const s = this.applied.scale
    return { scale: s, dx: this.applied.tx, dy: this.applied.ty - this.layout.top * s }
  }

  destroy(): void {
    this.destroyed = true
    this.respace?.cancel()
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.edgeFrame) cancelAnimationFrame(this.edgeFrame)
    if (this.ctlLeaveTimer) clearTimeout(this.ctlLeaveTimer)
    if (this.wrapTimer) clearTimeout(this.wrapTimer)
    if (this.corrLeaveTimer) clearTimeout(this.corrLeaveTimer)
    if (this.reminderLeaveTimer) clearTimeout(this.reminderLeaveTimer)
    if (this.wheelRelease) clearTimeout(this.wheelRelease)
    this.resize?.disconnect()
    this.swipe.destroy()
    for (const off of this.cleanup) off()
    this.store.destroy()
    this.timingCue.destroy()
  }

  // ---------------------------------------------------------------- state helpers

  private setFlag(flag: number, notes: readonly number[]): void {
    const next = new Set(notes.filter((n) => n >= 0 && n < this.flags.length))
    const prev = this.lists.get(flag) ?? new Set<number>()
    for (const n of prev) {
      if (!next.has(n)) {
        this.flags[n]! &= ~flag
        this.dirtyNotes.add(n)
      }
    }
    for (const n of next) {
      if (!prev.has(n)) {
        this.flags[n]! |= flag
        this.dirtyNotes.add(n)
      }
    }
    this.lists.set(flag, next)
    if (this.dirtyNotes.size) this.schedule()
  }

  private touchNoteLabel(n: number): void {
    const label = this.layout.notes[n]?.label
    if (label !== undefined && label >= 0) this.dirtyLabels.add(label)
  }

  /** Zoom limits keep both staves visible and fixed signatures clear of the stationary cursor. */
  private clampZoom(s: number): number {
    const L = this.layout
    const span = (L.staves[L.staves.length - 1]?.bottom ?? 0) - (L.staves[0]?.top ?? 0) + 2 * STAFF_MARGIN
    const verticalFit = this.hostH > 0 && span > 0 ? this.hostH / span : Infinity
    const contextFit =
      this.hostW > 0 && this.contextWidth > 0
        ? Math.max(1, this.hostW * (this.opts.cursorAnchor ?? 1 / 3) - 12) / (this.contextWidth + CONTEXT_FADE)
        : Infinity
    const fit = Math.min(verticalFit, contextFit)
    const min = this.opts.minZoom ?? 0.5
    return Math.max(Math.min(min, fit), Math.min(this.opts.maxZoom ?? 2.5, fit, Math.max(min, s)))
  }

  /** Clamps a content y (layout px from `top`) into the visible strip with a screen margin. */
  private clampVisibleY(y: number, h: number): number {
    const margin = 6 / this.shown
    const top = -this.ty / this.shown + margin
    const bottom = (this.hostH - this.ty) / this.shown - margin - h / this.shown
    return bottom < top ? y : Math.min(bottom, Math.max(top, y))
  }

  private applyZoom(scale: number, notify: boolean): void {
    if (scale === this.scale) return
    if (this.browsing) {
      const center = (this.hostW / 2 - this.browseTx) / this.scale
      this.browseTx = this.clampTx(zoomAround(this.browseTx, this.scale, scale, center), scale)
      this.swipe.rebase(this.browseTx)
    }
    this.scale = scale
    this.instant = true
    // Mid-review the review's own scale is on screen: written when the review lets go.
    if (!this.reviewOn && this.reviewP === 0) this.setZoomProperties()
    if (notify) this.opts.onZoomChange?.(scale)
    this.schedule()
  }

  /** A zoom the user (or the owner) asked for: remembered, applied fitted, reported. */
  private userZoom(scale: number): void {
    const z = this.clampZoom(scale)
    this.requestedZoom = z
    this.applyZoom(z, true)
  }

  /** Where the zoom, or the review's, may rest. */
  private zoomLimits(): { min: number; max: number } {
    if (!this.reviewOn) return { min: this.clampZoom(-Infinity), max: this.clampZoom(Infinity) }
    const span = this.staffSpan()
    const h = Math.max(1, this.hostH - this.reviewInset - this.reviewTop)
    const max = Math.min(this.opts.maxZoom ?? 2.5, span > 0 ? h / span : Infinity)
    return { min: Math.min(this.opts.minZoom ?? 0.5, max), max }
  }

  /** The zoom a pinch works on: the score's, or the review's. */
  private zoomBase(): number {
    return (this.reviewOn ? this.reviewBase()?.scale : undefined) ?? this.scale
  }

  /** A pinch asks for `raw`: past the limits the score stretches and the zoom stays. */
  private pinchTo(raw: number, x: number): void {
    const zoom = this.reviewOn ? this.zoomReview(raw, x) : this.clampZoom(raw)
    if (!this.reviewOn) this.userZoom(raw)
    if (zoom === null || this.reducedMotion) return
    // What stays put: the cursor's note, what a browsed view is centered on, the fingers in the review.
    this.stretchX = this.reviewOn ? x : this.browsing ? this.hostW / 2 : this.hostW * (this.opts.cursorAnchor ?? 1 / 3)
    this.stretch = stretchFor(raw, zoom)
    this.instant = true
    this.schedule()
  }

  /** The fingers lifted: the zoom coasts on at their speed, or bounces back from past a limit. */
  private releaseZoom(speed: number): void {
    const v = this.reducedMotion ? 0 : speed * stretchSlope(this.stretch)
    if (v === 0 && this.stretch === 1) return
    this.zoomMotion = { u: Math.log(this.zoomBase() * this.stretch), v, t: performance.now() }
    this.schedule()
  }

  /** One frame of a released zoom. Landed, it is the zoom (reported by `flush` at its end). */
  private stepZoomMotion(now: number): void {
    const m = this.zoomMotion
    if (!m) return
    const { min, max } = this.zoomLimits()
    const moving = stepZoom(m, Math.log(min), Math.log(max), now - m.t)
    m.t = now
    if (moving) this.stretch = Math.exp(m.u) / this.zoomBase()
    else this.settleZoom()
  }

  private zoomWithinLimits(): boolean {
    const { min, max } = this.zoomLimits()
    const drawn = this.zoomBase() * this.stretch
    return drawn >= min && drawn <= max
  }

  /** Ends a released zoom where it is drawn, or at the limit it is past. */
  private settleZoom(): void {
    const m = this.zoomMotion
    this.zoomMotion = null
    if (m) {
      const { min, max } = this.zoomLimits()
      const zoom = Math.max(min, Math.min(max, Math.exp(m.u)))
      if (this.reviewOn) this.zoomReview(zoom, this.stretchX)
      else if (zoom !== this.scale) {
        this.requestedZoom = zoom
        this.applyZoom(zoom, false)
        this.zoomLanded = true
      }
    }
    if (this.stretch === 1) return
    this.stretch = 1
    this.instant = true
    this.schedule()
  }

  /** The zoom as CSS while it is only drawn: on the few elements that read it, never the whole strip. */
  private drawnZoomProperties(scale: number | null): void {
    const put = (el: HTMLElement, name: string, value: number) => {
      if (scale === null) el.style.removeProperty(name)
      else el.style.setProperty(name, String(value))
    }
    put(this.cursorEl, '--pn-zoom', scale ?? 1)
    for (const el of [this.startHandle, this.endHandle, this.clearBtn]) put(el, '--pn-inv-zoom', 1 / (scale ?? 1))
  }

  /** The zoom for CSS: the cursor's width and the counter-scale of the loop controls. */
  private setZoomProperties(scale = this.scale): void {
    this.zoomProp = scale
    this.root.style.setProperty('--pn-inv-zoom', String(1 / scale))
    this.root.style.setProperty('--pn-zoom', String(scale))
  }

  /**
   * Re-fits the effective zoom from the requested one: a strip too short for it shows less zoom
   * without reporting it (the saved preference stays), and it comes back when there is room.
   */
  private measureHost(): void {
    const r = this.root.getBoundingClientRect()
    this.hostW = r.width || this.root.clientWidth || 0
    this.hostH = r.height || this.root.clientHeight || 0
    const fitted = this.clampZoom(this.requestedZoom)
    if (fitted !== this.scale) this.applyZoom(fitted, false)
  }

  /** Browse bounds: the first cursor stop to the content's right edge under the cursor line. */
  private clampTx(tx: number, scale = this.scale): number {
    return clampTranslate(tx, this.firstCursorX, this.layout.width, this.hostW, scale, this.opts.cursorAnchor)
  }

  /** The music springs back to the cursor's frame from where it is drawn. */
  private springBack(): void {
    this.instant = false
    if (this.reducedMotion || Number.isNaN(this.applied.tx) || !(this.hostW > 0)) this.instant = true
    else this.back = { x: 0, v: 0, t: NaN, target: 0 }
  }

  /** How far from the cursor's frame (`target`) the returning music is drawn at `now`; 0 once there. */
  private stepBack(now: number, target: number): number {
    const b = this.back
    if (!b) return 0
    if (Number.isNaN(b.t)) {
      // From very far only the last part is shown, as a long wrap does.
      const x = this.applied.tx - target
      b.x = Math.abs(x) > this.hostW * WRAP_PAN_VIEWPORTS ? Math.sign(x) * this.hostW * WRAP_LEAD_VIEWPORTS : x
    } else {
      // The music's own motion is carried along; a seek meanwhile is sprung to from what is drawn.
      const jump = target - b.target
      if (Math.abs(jump) > RETURN_SEEK_PX) b.x -= jump
      const dt = Math.min(50, Math.max(0, now - b.t)) / 1000
      const e = Math.exp(-RETURN_RATE * dt)
      const c = (b.v + RETURN_RATE * b.x) * dt
      b.x = (b.x + c) * e
      b.v = (b.v - RETURN_RATE * c) * e
    }
    b.t = now
    b.target = target
    if (Math.abs(b.x) < 0.5) this.back = null
    return this.back ? b.x : 0
  }

  /** Where a swipe may rest: the browse bounds, or the review's. */
  private browseRange(): { min: number; max: number } {
    const base = this.reviewOn ? this.reviewBase() : null
    const clamp = (tx: number) => (base ? this.clampReview(tx, base.scale) : this.clampTx(tx))
    return { min: clamp(-Infinity), max: clamp(Infinity) }
  }

  private clampReview(tx: number, scale: number): number {
    return clampReviewTranslate(tx, this.firstCursorX, this.layout.width, this.hostW, scale)
  }

  private swipeBegan(): boolean {
    if (this.reviewOn) return this.reviewBase() !== null
    if (!this.browseEnabled || this.dragTx !== null || this.cursorDrag) return false
    if (!this.browsing) {
      this.browsing = true
      this.browseTx = this.tx
      this.root.classList.add('pn-browsing')
      this.opts.onBrowse?.(true)
    }
    return true
  }

  /** Ends a swipe before its time. Its browse gesture is over too: the release still follows (U95). */
  private endSwipe(): void {
    const browse = this.swipe.active && this.browsing && !this.reviewOn
    this.swipe.stop()
    if (!browse) return
    // After the caller, which may be a Start or a seek that the hold no longer waits for.
    setTimeout(() => {
      if (!this.destroyed) this.opts.onBrowseRelease?.()
    })
  }

  /** The swipe's momentum and bounce are over: the browse gesture's release (U95). */
  private swipeSettled(tx: number): void {
    if (this.destroyed) return
    if (this.reviewOn) {
      this.panReview(tx)
      return
    }
    if (!this.browsing) return
    this.browseTx = this.clampTx(tx)
    this.schedule()
    this.browseReleased()
  }

  private browseReleased(): void {
    if (this.destroyed) return
    this.opts.onBrowseRelease?.()
    // Back where the cursor rests (a bounce at the start): nothing is browsed.
    if (this.browsing && Math.abs(this.clampTx(this.browseTx) - this.cursorTranslate()) < 1) this.returnToCurrent()
  }

  /** Translate placing `cursorX` under the fixed cursor (U28). */
  private cursorTranslate(): number {
    return scrollTranslate({
      cursorX: this.cursorX,
      contentWidth: this.layout.width,
      viewportWidth: this.hostW,
      scale: this.scale,
      anchor: this.opts.cursorAnchor ?? 1 / 3,
    })
  }

  /** The loop's extent in layout px (whole-bar edges on barlines, note-level edges per `loopEdgeX`). */
  private loopExtent(r: LoopRange): { x0: number; x1: number } {
    const occs = this.layout.occurrences
    const pos = passagePositions(occs, r)
    return {
      x0: r.start ? loopEdgeX(occs, pos.start) : occs[r.fromOcc]!.x0,
      x1: r.end ? loopEdgeX(occs, pos.end) : occs[r.toOcc]!.x1,
    }
  }

  /** Staves plus their fit margins, layout px. */
  private staffSpan(): number {
    const L = this.layout
    return (L.staves[L.staves.length - 1]?.bottom ?? 0) - (L.staves[0]?.top ?? 0) + 2 * STAFF_MARGIN
  }

  /** The review frame (U97): the one a zoom back in leaves from, the learner's, or the fitted one. */
  private reviewTarget(): { tx: number; ty: number; scale: number } | null {
    if (!this.reviewOn && this.reviewFrozen) return this.reviewFrozen
    const base = this.reviewBase()
    if (!base) return null
    const h = Math.max(1, this.hostH - this.reviewInset - this.reviewTop)
    return { ...base, ty: this.reviewTop + verticalTranslate(this.layout, h, base.scale) }
  }

  /** The review's horizontal frame: panned or pinched by the learner, else fitted to the loop. */
  private reviewBase(): { tx: number; scale: number } | null {
    if (this.reviewManual) return this.reviewManual
    if (!this.loop || !(this.hostW > 0)) return null
    const { x0, x1 } = this.loopExtent(this.loop)
    const min = this.opts.minZoom ?? 0.5
    const f = reviewFrame({
      x0,
      x1,
      viewportWidth: this.hostW,
      viewportHeight: Math.max(1, this.hostH - this.reviewInset - this.reviewTop),
      staffSpan: this.staffSpan(),
      leftReserve: this.contextWidth > 0 ? this.contextWidth + CONTEXT_FADE : 0,
      playScale: this.scale,
      minScale: Math.max(min, this.opts.reviewMinZoom ?? REVIEW_MIN_ZOOM),
    })
    return { tx: f.tx, scale: f.scale }
  }

  /** Advances the review's blend to `now`; true while it is still animating. */
  private stepReview(now: number): boolean {
    const a = this.reviewAnim
    if (!a) return false
    if (Number.isNaN(a.t0)) a.t0 = now
    const k = a.dur > 0 ? (now - a.t0) / a.dur : 1
    this.reviewP = a.from + (a.to - a.from) * reviewEase(k)
    if (k < 1) return true
    this.reviewP = a.to
    this.reviewAnim = null
    if (a.to === 0) this.reviewFrozen = null
    return false
  }

  /** A gesture takes over: a running zoom (out or in) lands at once. */
  private settleReview(): void {
    const a = this.reviewAnim
    if (!a) return
    this.reviewAnim = null
    this.reviewP = a.to
    if (a.to === 0) this.reviewFrozen = null
    this.instant = true
    this.schedule()
  }

  /** The learner pans the review (drag, wheel): the fitted frame becomes theirs. */
  private panReview(tx: number): void {
    const base = this.reviewBase()
    if (!base) return
    this.reviewManual = { scale: base.scale, tx: this.clampReview(tx, base.scale) }
    this.instant = true
    this.schedule()
  }

  /** The learner zooms the review (pinch, ctrl-wheel) around screen x `at`: never saved. The zoom in its limits. */
  private zoomReview(scale: number, at: number): number | null {
    const base = this.reviewBase()
    if (!base) return null
    const { min, max } = this.zoomLimits()
    const s = Math.max(min, Math.min(max, scale))
    const tx = zoomAround(base.tx, base.scale, s, (at - base.tx) / base.scale)
    this.reviewManual = { scale: s, tx: this.clampReview(tx, s) }
    this.instant = true
    this.schedule()
    return s
  }

  /** Ends a wrap (a pan still running then finishes under the normal transition). */
  private endWrap(): void {
    if (this.wrapTimer) clearTimeout(this.wrapTimer)
    this.wrapTimer = null
    if (!this.wrap) return
    this.wrap = null
    this.root.classList.remove('pn-wrap')
  }

  private schedule(): void {
    if (this.frame || this.destroyed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.flush()
    })
  }

  // ---------------------------------------------------------------- frame

  private flush(): void {
    if (this.destroyed) return
    const L = this.layout
    const prevTx = this.applied.tx
    const prevScale = this.applied.scale
    const now = performance.now()
    const wasStretched = this.stretch !== 1
    this.stepZoomMotion(now)
    const stretched = this.stretch !== 1
    let coasting = false
    if (this.swipe.active) {
      // Drawn where the native scroller is, past the ends too (its bounce).
      const { tx, done } = this.swipe.step()
      const base = this.reviewOn ? this.reviewBase() : null
      if (base) this.reviewManual = { scale: base.scale, tx }
      else this.browseTx = tx
      this.instant = true
      coasting = !done
    }
    // Browsing or a drag takes over the translate: a wrap in progress ends.
    if (this.wrap && (this.browsing || this.dragTx !== null)) this.endWrap()
    const wrap = this.wrap
    if (this.browsing || this.dragTx !== null) this.back = null
    const returning = this.back !== null
    // The music is held elsewhere: the cursor keeps its place in it (U151).
    const away = returning || this.browsing || (this.dragTx !== null && (!this.cursorDrag || this.cursorDrag.free))
    this.tx =
      this.dragTx !== null && (!this.cursorDrag || this.cursorDrag.free)
        ? this.clampTx(this.dragTx)
        : this.browsing && !this.cursorDrag?.moved
          ? this.swipe.active
            ? this.browseTx
            : this.clampTx(this.browseTx)
          : wrap?.phase === 'lead'
            ? wrap.from
            : this.cursorTranslate()
    if (returning) this.tx += this.stepBack(now, this.tx)
    this.ty = verticalTranslate(L, this.hostH, this.scale)
    // The review (U97) blends the playing frame into the review frame: the cursor's screen x moves
    // from the fixed anchor to the cursor note's place in the review, the music follows from there.
    const animating = this.stepReview(now)
    const anchorX = this.hostW * (this.opts.cursorAnchor ?? 1 / 3)
    let scale = this.scale
    let cursorSx = anchorX
    let reviewView: { x0: number; x1: number } | null = null
    const review = this.reviewP > 0 && this.dragTx === null && !this.browsing ? this.reviewTarget() : null
    if (review) {
      const p = this.reviewP
      scale = this.scale + (review.scale - this.scale) * p
      cursorSx = anchorX + (review.tx + this.cursorX * review.scale - anchorX) * p
      this.tx = cursorSx - this.cursorX * scale
      this.ty += (review.ty - this.ty) * p
      // Both ends of a zoom are mounted before it moves: no segment is parsed mid-flight.
      if (animating) {
        const a = visibleRange(review.tx, review.scale, this.hostW)
        const b = visibleRange(this.cursorTranslate(), this.scale, this.hostW)
        reviewView = { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1) }
      }
    }
    // A zoom past its limits, or one that coasts: the same frame, scaled about what stays put.
    if (stretched) {
      const k = this.stretch
      this.tx = this.stretchX - (this.stretchX - this.tx) * k
      if (this.browsing && !review && !this.swipe.active) this.tx = this.clampTx(this.tx, scale * k)
      if (review) cursorSx = this.stretchX - (this.stretchX - cursorSx) * k
      scale *= k
      const top = review ? this.reviewTop : 0
      const bottom = review ? this.reviewInset : 0
      this.ty = top + verticalTranslate(L, Math.max(1, this.hostH - top - bottom), scale)
    }
    if (away && !review) cursorSx = this.tx + this.cursorX * scale
    this.shown = scale
    // A far jump (seek) is not animated: it would sweep past everything in between and need it all
    // mounted. A wrap (`wrapTo`) has its own rules: an instant lead, then a quick pan. A review
    // zoom is driven frame by frame here, so it never runs under a CSS transition.
    const far = !review && !Number.isNaN(prevTx) && Math.abs(this.tx - prevTx) > this.hostW * FAR_JUMP_VIEWPORTS
    const instant = wrap
      ? wrap.phase === 'lead'
      : this.instant || far || animating || stretched || wasStretched || returning
    this.instant = false
    if (wrap?.phase === 'pan' && !this.wrapTimer) {
      this.root.classList.add('pn-wrap')
      this.wrapTimer = setTimeout(() => this.endWrap(), WRAP_MS + 80)
    }
    // The translate drawn this frame: the target, or a step of a glide driven here.
    const tx = this.glideTx(instant || review !== null, wrap?.phase === 'pan', now)
    const glide = this.glide
    this.root.classList.toggle('pn-instant', instant || glide !== null)

    const moved = tx !== prevTx || scale !== prevScale || this.ty !== this.applied.ty
    if (moved) {
      this.content.style.transform = `translate3d(${r2(tx)}px, ${r2(this.ty)}px, 0) scale(${scale})`
      if (this.ty !== this.applied.ty || scale !== prevScale) {
        this.stickyStaff.style.setProperty(
          '--pn-staff-transform',
          `translate3d(0, ${r2(this.ty)}px, 0) scale(${scale})`,
        )
      }
      this.applied.tx = tx
      this.applied.ty = this.ty
      this.applied.scale = scale
      this.swipe.moved()
    }
    // The cursor's width and the loop controls' counter-scale follow once a review zoom has landed
    // (a custom property restyles every mounted node: never per frame).
    if (stretched) this.drawnZoomProperties(scale)
    else {
      if (wasStretched) this.drawnZoomProperties(null)
      if (!animating && scale !== this.zoomProp) this.setZoomProperties(scale)
    }
    this.respace?.follow(this.screenFrame())

    // Mount for both the old and the new view so a smooth scroll never reveals a gap; during a
    // wrap, for the whole range its pan sweeps (already while the lead lands).
    const view = visibleRange(tx, scale, this.hostW)
    const old = glide
      ? visibleRange(glide.from, scale, this.hostW)
      : Number.isNaN(prevTx) || instant
        ? view
        : visibleRange(prevTx, Number.isNaN(prevScale) ? scale : prevScale, this.hostW)
    let vx0 = Math.min(view.x0, old.x0)
    let vx1 = Math.max(view.x1, old.x1)
    if (glide) {
      const end = visibleRange(this.tx, scale, this.hostW)
      vx0 = Math.min(vx0, end.x0)
      vx1 = Math.max(vx1, end.x1)
    }
    if (reviewView) {
      vx0 = Math.min(vx0, reviewView.x0)
      vx1 = Math.max(vx1, reviewView.x1)
    }
    if (wrap) {
      const a = visibleRange(wrap.from, this.scale, this.hostW)
      const b = visibleRange(wrap.to, this.scale, this.hostW)
      vx0 = Math.min(vx0, a.x0, b.x0)
      vx1 = Math.max(vx1, a.x1, b.x1)
    }
    const over = (this.opts.overscan ?? 1) * (this.hostW / scale)
    const required = new Set(this.store.wanted(vx0, vx1, this.cursorX))
    const wanted = this.store.wanted(vx0 - over, vx1 + over, (view.x0 + view.x1) / 2)
    const done = this.store.sync(wanted, required, this.opts.mountBudget ?? 1)

    this.applyNotes()
    this.applyLabels()

    // Screen x of the cursor: constant (no style write) while the music scrolls beneath it; in the
    // review the cursor moves over the still music instead.
    const sx = r2(cursorSx)
    if (sx !== this.applied.cursorSx) {
      this.cursorEl.style.transform = `translate3d(${sx}px, 0, 0)`
      this.applied.cursorSx = sx
    }
    // The full engraving's top stays put as individual notes scroll under the cursor. Placed while
    // hidden too, so the next cue appears in place.
    const offscreen = away && (sx < 0 || sx > this.hostW)
    this.timingCue.place(offscreen ? NaN : sx, this.hostW, this.ty)
    this.applyCursorBar()
    this.placeActionButton()
    this.applyLoop()
    if (this.pendingReminders) this.applyReminders()
    if (this.pendingCorrections) this.applyCorrections()
    const stickyW = this.applySticky(tx, view.x0)
    // A cursor carried off with its note fades out before the pinned signatures, as the notes do.
    const clear = sx - stickyW * scale
    const opacity = away && !this.cursorDrag ? r2(Math.min(1, Math.max(0, clear / CONTEXT_FADE))) : 1
    if (opacity !== this.applied.cursorOpacity) {
      this.cursorEl.style.opacity = opacity === 1 ? '' : String(opacity)
      this.cursorEl.classList.toggle('pn-cursor-out', opacity === 0)
      this.applied.cursorOpacity = opacity
    }
    this.applyOttava(view.x0 + stickyW, view.x1)
    if (moved || this.labelsChanged) this.reportVisibleLabels(view.x0 + stickyW, view.x1)
    this.labelsChanged = false
    if (wrap?.phase === 'lead') {
      // The lead is in place (committed when the browser renders this frame): pan next frame.
      wrap.phase = 'pan'
      this.schedule()
    } else if (!done || animating || glide || coasting || this.zoomMotion || this.back) this.schedule()
    if (this.zoomLanded) {
      this.zoomLanded = false
      this.opts.onZoomChange?.(this.scale)
    }
  }

  /**
   * The content translate to draw this frame. A CSS transition interpolates the translate linearly
   * between its ends, but the pinned opening is clamped at the edge (U125): a glide whose ends pin
   * it differently is drawn here frame by frame instead (no transition), so the music, the pinned
   * block and the masks share one translate on every frame. Other glides stay CSS transitions.
   * `wrapPan`: a wrap's pan, which keeps its timing while the transport moves its target on.
   */
  private glideTx(instant: boolean, wrapPan: boolean, now: number): number {
    const to = this.tx
    const prev = this.applied.tx
    if (instant || this.reducedMotion || Number.isNaN(prev)) {
      this.glide = this.cssGlide = null
      this.glideTarget = to
      return to
    }
    let g = this.glide
    if (to !== this.glideTarget && !(g?.wrap && wrapPan)) {
      // A new target: glide from what is on screen now (a running CSS glide's place is estimated).
      const css = this.cssGlide
      const from =
        !g && css && now < css.t0 + css.dur ? css.from + (css.to - css.from) * css.ease((now - css.t0) / css.dur) : prev
      const dur = wrapPan ? WRAP_MS : SCROLL_MS
      const ease = wrapPan ? WRAP_EASE : this.scrollEase
      g =
        from !== to && this.pinOffset(from) !== this.pinOffset(to) ? { from, t0: now, dur, ease, wrap: wrapPan } : null
      this.glide = g
      this.cssGlide = g || from === to ? null : { from, to, t0: now, dur, ease }
    }
    this.glideTarget = to
    if (!g) return to
    const k = (now - g.t0) / g.dur
    if (k < 1) return g.from + (to - g.from) * g.ease(k)
    // Landed: drawn at the target without a transition, released on the next frame.
    if (prev === to) this.glide = null
    return to
  }

  /** The pinned opening's screen x at content translate `tx` (0 at the edge, or nothing to pin). */
  private pinOffset(tx: number): number {
    const changes = this.layout.contextChanges
    const openingX = changes[0]?.openingX
    if (openingX === undefined) return 0
    const next = changes[1]
    if (next && next.x <= visibleRange(tx, this.shown, this.hostW).x0) return 0
    return Math.max(0, tx + openingX * this.shown)
  }

  /**
   * The cursor bar spans the staves on screen (top staff's top to bottom staff's bottom, scaled
   * and translated like the content) plus a margin at each end that its CSS mask fades out.
   * Written only when the vertical translate or zoom changed it.
   */
  /**
   * The cursor's button sits dead center in the gap between the staves (U14 addendum, user);
   * without a gap (one staff), at the stage's middle. Only while it shows; a hidden button keeps
   * its place so its fade-out does not jump.
   */
  private placeActionButton(): void {
    if (!this.cursorAction || !(this.hostH > 0)) return
    const L = this.layout
    const gap = staffGap(L.staves)
    const c = gap ? this.ty + ((gap.top + gap.bottom) / 2 - L.top) * this.shown : this.hostH / 2
    const top = r2(c - ACTION_RADIUS)
    if (top === this.applied.actionTop) return
    this.cursorBtn.style.top = `${top}px`
    this.applied.actionTop = top
  }

  private applyCursorBar(): void {
    const L = this.layout
    const first = L.staves[0]
    const last = L.staves[L.staves.length - 1]
    if (!first || !last) return
    const top = r2(this.ty + (first.top - L.top) * this.shown - CURSOR_MARGIN)
    const h = r2((last.bottom - first.top) * this.shown + 2 * CURSOR_MARGIN)
    if (top === this.applied.barTop && h === this.applied.barH) return
    this.cursorBar.style.top = `${top}px`
    this.cursorBar.style.height = `${h}px`
    this.applied.barTop = top
    this.applied.barH = h
  }

  private applyNotes(): void {
    if (!this.dirtyNotes.size) return
    const mounted = this.store.mounted
    for (const n of this.dirtyNotes) {
      const g = this.layout.notes[n]
      if (!g) continue
      const own = this.store.segmentOfOcc(g.occ)
      const seg = mounted.get(own)
      if (seg) this.paintNote(seg, n)
      // PF6 copies a measure into a neighbor it reaches into: the copied notehead shows the state too.
      for (const i of [own - 1, own + 1]) {
        const copy = mounted.get(i)
        if (copy?.heads.has(n)) this.paintNote(copy, n)
      }
    }
    this.dirtyNotes.clear()
  }

  /** Whether `seg` owns note `n` (holds its measure) rather than a copy of its notehead. */
  private owns(seg: MountedSegment, n: number): boolean {
    const g = this.layout.notes[n]
    return !!g && this.store.segmentOfOcc(g.occ) === seg.index
  }

  /**
   * Note classes on the owner's or a copy's notehead, with the halo or ring in the owning segment.
   */
  private paintNote(seg: MountedSegment, n: number): void {
    const f = this.flags[n]!
    const head = seg.heads.get(n)
    if (head) for (const [bit, cls] of FLAG_CLASSES) head.classList.toggle(cls, (f & bit) !== 0)
    if (!this.owns(seg, n)) return
    const markCls = f & ACCEPTED ? 'pn-ring' : f & TARGET ? 'pn-halo' : ''
    let mark = this.marks.get(n)
    if (!markCls) {
      if (mark) {
        mark.remove()
        this.marks.delete(n)
      }
      return
    }
    const g = this.layout.notes[n]!
    if (!mark) {
      mark = seg.marks.ownerDocument.createElementNS(SVG_NS, 'ellipse')
      mark.setAttribute('cx', String(r2(g.head.x + g.head.w / 2)))
      mark.setAttribute('cy', String(r2(g.head.y + g.head.h / 2)))
      mark.setAttribute('rx', String(r2(g.head.w * 0.5 + 4)))
      mark.setAttribute('ry', String(r2(g.head.h * 0.5 + 3.5)))
      seg.marks.append(mark)
      this.marks.set(n, mark)
    }
    if (mark.getAttribute('class') !== markCls) mark.setAttribute('class', markCls)
  }

  private onAttached(seg: MountedSegment): void {
    for (const n of seg.heads.keys()) this.paintNote(seg, n)
    for (const s of this.ottavaSpans) seg.ottava.get(s)?.forEach((el) => el.classList.add('pn-ott-on'))
    for (const [s, els] of seg.ottava)
      if (!this.ottavaSpans.includes(s)) els.forEach((el) => el.classList.remove('pn-ott-on'))
    for (let id = seg.data.labelStart; id < seg.data.labelEnd; id++) this.paintLabel(seg, id)
    this.labelsChanged = true
  }

  private onDetaching(seg: MountedSegment): void {
    for (const n of seg.heads.keys()) {
      const m = this.marks.get(n)
      // Only the owner's marks: a copied notehead's note keeps its mark in the owning segment.
      if (m && m.parentNode === seg.marks) {
        m.remove()
        this.marks.delete(n)
      }
    }
    for (let id = seg.data.labelStart; id < seg.data.labelEnd; id++) {
      const node = this.labelNodes.get(id)
      if (!node) continue
      node.text.remove()
      node.leader?.remove()
      this.labelNodes.delete(id)
    }
    this.labelsChanged = true
  }

  // ---------------------------------------------------------------- labels

  private labelState(label: LabelBox): { text: string; opacity: number } {
    let text = ''
    let opacity = 0
    for (const n of label.notes) {
      const o = this.noteOpacity[n] ?? 0
      if (o > opacity) opacity = o
      if (!text) text = this.noteText.get(n) ?? ''
    }
    return { text, opacity }
  }

  private applyLabels(): void {
    if (!this.dirtyLabels.size) return
    for (const id of this.dirtyLabels) {
      const label = this.layout.labels[id]
      if (!label) continue
      const seg = this.store.mounted.get(this.store.segmentOfOcc(label.occ))
      if (seg) this.paintLabel(seg, id)
    }
    this.dirtyLabels.clear()
    this.labelsChanged = true
  }

  private paintLabel(seg: MountedSegment, id: number): void {
    const label = this.layout.labels[id]!
    const { text, opacity } = this.labelState(label)
    let node = this.labelNodes.get(id)
    if (opacity <= 0 || !text) {
      if (node) {
        node.text.remove()
        node.leader?.remove()
        this.labelNodes.delete(id)
      }
      return
    }
    if (!node) {
      const doc = seg.labels.ownerDocument
      const t = doc.createElementNS(SVG_NS, 'text')
      t.setAttribute('class', 'pn-label')
      t.setAttribute('x', String(label.tx))
      t.setAttribute('y', String(label.ty))
      t.setAttribute('font-size', String(this.layout.params.labelFontPx))
      if (label.anchor !== 'start') t.setAttribute('text-anchor', label.anchor)
      t.setAttribute('data-h', label.hand)
      let leader: SVGLineElement | null = null
      if (label.leader) {
        leader = doc.createElementNS(SVG_NS, 'line')
        leader.setAttribute('class', 'pn-leader')
        const [x1, y1, x2, y2] = label.leader
        leader.setAttribute('x1', String(x1))
        leader.setAttribute('y1', String(y1))
        leader.setAttribute('x2', String(x2))
        leader.setAttribute('y2', String(y2))
        seg.labels.append(leader)
      }
      seg.labels.append(t)
      node = { text: t, leader, str: '', opacity: -1 }
      this.labelNodes.set(id, node)
    }
    if (node.str !== text) {
      node.text.textContent = text
      node.str = text
    }
    if (node.opacity !== opacity) {
      const v = opacity >= 1 ? '' : String(Math.round(opacity * 1000) / 1000)
      node.text.style.opacity = v
      if (node.leader) node.leader.style.opacity = v
      node.opacity = opacity
    }
  }

  private reportVisibleLabels(x0: number, x1: number): void {
    const next = new Set<number>()
    for (const seg of this.store.mounted.values()) {
      if (seg.data.x1 < x0 || seg.data.x0 > x1) continue
      for (let id = seg.data.labelStart; id < seg.data.labelEnd; id++) {
        const node = this.labelNodes.get(id)
        if (!node || node.opacity <= 0) continue
        const b = this.layout.labels[id]!.box
        if (b.x + b.w > x0 && b.x < x1) next.add(id)
      }
    }
    const added: number[] = []
    for (const id of next) if (!this.visibleLabelIds.has(id)) added.push(...this.layout.labels[id]!.notes)
    this.visibleLabelIds = next
    if (added.length) this.opts.onVisibleLabels?.(added.sort((a, b) => a - b))
  }

  // ---------------------------------------------------------------- overlays

  private applyOttava(x0: number, x1: number): void {
    const L = this.layout
    const doc = this.root.ownerDocument
    const active = new Set(this.ottavaSpans)
    for (const [s, el] of this.ottavaBoxes) {
      if (!active.has(s)) {
        el.classList.remove('pn-on')
      }
    }
    const remindByStaff = new Map<number, string>()
    for (const s of this.ottavaSpans) {
      const g = L.ottavas[s]!
      let box = this.ottavaBoxes.get(s)
      if (!box) {
        box = doc.createElement('div')
        box.className = 'pn-ott-box'
        box.style.left = `${g.box.x - 5}px`
        box.style.top = `${g.box.y - L.top - 4}px`
        box.style.width = `${g.box.w + 10}px`
        box.style.height = `${g.box.h + 8}px`
        this.content.insertBefore(box, this.startHandle)
        this.ottavaBoxes.set(s, box)
        void box.offsetWidth
      }
      box.classList.add('pn-on')
      const lb = g.labelBox
      const vy0 = L.top - this.ty / this.shown
      const vy1 = L.top + (this.hostH - this.ty) / this.shown
      const labelVisible = lb.x + lb.w > x0 + 2 && lb.x < x1 - 2 && lb.y >= vy0 - 1 && lb.y + lb.h <= vy1 + 1
      if (!labelVisible && !remindByStaff.has(g.staff)) remindByStaff.set(g.staff, g.text)
    }
    for (const [staff, el] of this.reminders) if (!remindByStaff.has(staff)) el.classList.remove('pn-on')
    for (const [staff, text] of remindByStaff) {
      let el = this.reminders.get(staff)
      if (!el) {
        el = doc.createElement('div')
        el.className = 'pn-ott-rem'
        el.setAttribute('role', 'status')
        const pill = doc.createElement('div')
        pill.className = 'pn-ott-rem-pill'
        el.append(pill)
        this.content.append(el)
        this.reminders.set(staff, el)
        void el.offsetWidth
      }
      const pill = el.firstElementChild as HTMLDivElement
      if (pill.textContent !== text) pill.textContent = text
      const st = L.staves.find((s) => s.index === staff)
      const y = this.clampVisibleY((st?.top ?? 0) - L.top - 16 - 28 / this.shown, 28) + 14 / this.shown
      el.style.transform = `translate(${r2(this.cursorX + 18)}px, ${r2(y)}px) scale(${1 / this.shown}) translateY(-50%)`
      el.classList.add('pn-on')
    }
  }

  /**
   * The loop band and its controls. Whole-bar edges sit on barlines; note-level edges halfway
   * between the edge note and the entry before it (`loopEdgeX`). Unchanged state writes nothing.
   */
  private applyLoop(): void {
    const L = this.layout
    const r = this.handleDrag?.range ?? this.loop
    const show = !!r && this.loopEditable
    const last = this.loopShown
    if (last.r === r && last.show === show && last.scale === this.zoomProp) return
    const entering = !last.r && !!r
    if (!!last.r && !r) {
      // Leaving: the band shrinks back into the cursor's position (U14).
      this.loopEl.style.setProperty('--pn-loop-origin', this.loopOrigin(last.mid - last.width / 2, last.width))
      this.loopTransition('pn-loop-leave')
    }
    this.loopShown = { r, show, scale: this.zoomProp, width: 0, mid: 0 }
    this.loopEl.classList.toggle('pn-on', !!r)
    this.setControlsShown(show)
    if (!r) return
    const { x0, x1 } = this.loopExtent(r)
    this.loopEl.style.left = `${r2(x0)}px`
    this.loopEl.style.width = `${r2(Math.max(0, x1 - x0))}px`
    const first = L.staves[0]
    const lastStaff = L.staves[L.staves.length - 1]
    const midY = ((first?.top ?? 0) + (lastStaff?.bottom ?? 0)) / 2 - L.top
    this.startHandle.style.left = `${r2(x0)}px`
    this.endHandle.style.left = `${r2(x1)}px`
    this.clearBtn.style.left = `${r2((x0 + x1) / 2)}px`
    for (const el of [this.startHandle, this.endHandle, this.clearBtn]) el.style.top = `${midY}px`
    this.loopShown.width = x1 - x0
    this.loopShown.mid = (x0 + x1) / 2
    if (entering) {
      // Entering: the band grows out of the cursor's position; the controls follow (CSS).
      this.loopEl.style.setProperty('--pn-loop-origin', this.loopOrigin(x0, x1 - x0))
      this.loopTransition('pn-loop-enter')
    }
    // A narrow band on screen gets the small ✕; it never hides while the loop is editable (U14).
    this.clearBtn.classList.toggle('pn-loop-clear-small', (x1 - x0) * this.zoomProp < CLEAR_SMALL_PX)
  }

  /**
   * Replaces the corrections: the shown ones fade out (removed on `animationend` or by a
   * fallback timer), the new ones are built once and fade in, staggered left to right.
   */
  private applyCorrections(): void {
    const marks = this.pendingCorrections ?? []
    this.pendingCorrections = null
    const leaving = [...this.corrLayer.children].filter((el) => !el.classList.contains('pn-corr-leave'))
    for (const el of leaving) {
      ;(el as SVGElement).style.animationDelay = ''
      el.classList.add('pn-corr-leave')
    }
    if (leaving.length) {
      if (this.corrLeaveTimer) clearTimeout(this.corrLeaveTimer)
      this.corrLeaveTimer = setTimeout(() => {
        this.corrLeaveTimer = null
        for (const el of [...this.corrLayer.querySelectorAll('.pn-corr-leave')]) el.remove()
      }, CORRECTION_LEAVE_MS)
    }
    const doc = this.root.ownerDocument
    const measurer = (this.corrMeasurer ??= canvasMeasurer(doc) ?? estimateMeasurer)
    layoutCorrections(this.layout, marks, measurer).forEach((shape, i) => {
      const delay = !this.reducedMotion && i > 0 ? i * CORRECTION_STAGGER_MS : 0
      this.corrLayer.append(buildCorrection(doc, shape, this.layout.top, delay))
    })
  }

  /**
   * Replaces the reminders: shown ticks fade out (removed immediately under reduced motion, or on
   * `animationend` / fallback timer), and new ones are built once without stagger.
   */
  private applyReminders(): void {
    const marks = this.pendingReminders ?? []
    this.pendingReminders = null
    const leaving = [...this.reminderLayer.children].filter((el) => !el.classList.contains('pn-reminder-leave'))
    if (this.reducedMotion) {
      for (const el of [...this.reminderLayer.children]) el.remove()
    } else if (leaving.length) {
      for (const el of leaving) el.classList.add('pn-reminder-leave')
      if (this.reminderLeaveTimer) clearTimeout(this.reminderLeaveTimer)
      this.reminderLeaveTimer = setTimeout(() => {
        this.reminderLeaveTimer = null
        for (const el of [...this.reminderLayer.querySelectorAll('.pn-reminder-leave')]) el.remove()
      }, REMINDER_LEAVE_MS)
    }
    const doc = this.root.ownerDocument
    for (const shape of layoutReminders(this.layout, marks)) {
      this.reminderLayer.append(buildReminder(doc, shape, this.layout.top))
    }
  }

  /** Where the cursor sits within a band, as a percentage for `transform-origin`. */
  private loopOrigin(x0: number, width: number): string {
    if (!(width > 0)) return '50%'
    return `${r2(Math.max(0, Math.min(100, ((this.cursorX - x0) / width) * 100)))}%`
  }

  /** Restarts the band's grow or shrink animation (no-op under reduced motion). */
  private loopTransition(cls: 'pn-loop-enter' | 'pn-loop-leave'): void {
    if (this.reducedMotion) return
    const el = this.loopEl
    el.classList.remove('pn-loop-enter', 'pn-loop-leave')
    void el.offsetWidth // restart the animation when the same class comes back
    el.classList.add(cls)
  }

  /**
   * Shows the loop controls at once (their CSS entrance plays whenever they are displayed), or
   * lets them fade out before hiding them (`pn-ctl-leave`); reduced motion hides them at once.
   */
  private setControlsShown(show: boolean): void {
    const ctls = [this.startHandle, this.endHandle, this.clearBtn]
    if (this.ctlLeaveTimer) {
      clearTimeout(this.ctlLeaveTimer)
      this.ctlLeaveTimer = null
    }
    if (show) {
      for (const el of ctls) {
        el.classList.remove('pn-ctl-leave')
        el.style.display = ''
      }
      return
    }
    const visible = ctls.filter((el) => el.style.display !== 'none')
    if (this.reducedMotion || visible.length === 0) {
      for (const el of ctls) {
        el.classList.remove('pn-ctl-leave')
        el.style.display = 'none'
      }
      return
    }
    for (const el of visible) el.classList.add('pn-ctl-leave')
    this.ctlLeaveTimer = setTimeout(() => {
      this.ctlLeaveTimer = null
      for (const el of ctls) {
        if (!el.classList.contains('pn-ctl-leave')) continue
        el.classList.remove('pn-ctl-leave')
        el.style.display = 'none'
      }
    }, 400)
  }

  /** Sticky clef/key/meter at content translate `tx`; returns the screen-covered width in layout px. */
  private applySticky(tx: number, viewX0: number): number {
    const L = this.layout
    const changes = L.contextChanges
    const first = changes[0]
    if (!first) return 0
    const on = first.openingX !== undefined || viewX0 > first.glyphEnd - 2
    this.stickyEl.classList.toggle('pn-on', on)
    let lo = 0
    let hi = changes.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (changes[mid]!.x <= viewX0) lo = mid
      else hi = mid - 1
    }
    const ctx = L.contexts[changes[lo]!.context]
    if (!ctx) return 0
    if (ctx.id !== this.stickyContext) {
      this.stickyContext = ctx.id
      const parts = ctx.staves
        .map((s) => {
          const st = L.staves.find((g) => g.index === s.staff)
          return `<g transform="translate(0 ${r2((st?.top ?? 0) - L.top)})">${s.glyph.svg}</g>`
        })
        .join('')
      const lines = L.staves
        .map((st) =>
          Array.from({ length: 5 }, (_, i) => {
            const y = r2(st.top - L.top + ((st.bottom - st.top) * i) / 4)
            return `<path d="M0 ${y}H${ctx.width + CONTEXT_FADE}"/>`
          }).join(''),
        )
        .join('')
      const svg = (width: number, body: string) =>
        `<svg xmlns="${SVG_NS}" width="${width}" height="${L.height}" viewBox="0 0 ${width} ${L.height}">${body}</svg>`
      this.stickyStaff.innerHTML = svg(ctx.width + CONTEXT_FADE, `<g class="pn-context-staff">${lines}</g>`)
      this.stickyInner.innerHTML = svg(ctx.width, parts)
      this.stickyInner.style.width = `${ctx.width}px`
      this.stickyInner.style.height = `${L.height}px`
    }
    // Start at the engraved position and glide to the edge with the score. The same glyphs
    // remain visible as the score moves underneath them, including when browsing backward.
    const offset = this.pinOffset(tx)
    const transform = `translate3d(${r2(offset)}px, ${r2(this.ty)}px, 0) scale(${this.shown})`
    if (transform !== this.stickyTransform) {
      this.stickyTransform = transform
      this.stickyInner.style.transform = transform
    }
    const width = r2(ctx.width * this.shown)
    const end = r2((ctx.width + CONTEXT_FADE) * this.shown)
    const mask = on ? `linear-gradient(to right, transparent ${width}px, #000 ${end}px)` : ''
    if (this.stickyMask !== mask) {
      this.stickyMask = mask
      const staffMask = on ? `linear-gradient(to right, #000 ${width}px, transparent ${end}px)` : ''
      // The replacement staff lines span the pinned block plus its fade, never the whole strip.
      this.stickyStaff.style.width = on ? `${end}px` : ''
      for (const [el, image] of [
        [this.stage, mask],
        [this.stickyStaff, staffMask],
      ] as const) {
        el.style.maskImage = image
        el.style.webkitMaskImage = image
        // Extra width keeps the far-right score visible when the gradient is shifted left.
        el.style.maskSize = `calc(100% + ${end}px) 100%`
        el.style.webkitMaskSize = el.style.maskSize
      }
    }
    // Slide both masks in over the last few pixels of travel (per frame during a driven glide, never
    // a transition). The replacement lines fill only the portion of the moving staff hidden by the
    // stage mask.
    const shift = r2(-end * Math.min(1, offset / (CONTEXT_FADE * this.shown)))
    if (shift !== this.stickyShift) {
      this.stickyShift = shift
      const position = `${shift}px 0px`
      this.stage.style.maskPosition = this.stickyStaff.style.maskPosition = position
      this.stage.style.webkitMaskPosition = this.stickyStaff.style.webkitMaskPosition = position
    }
    return on ? Math.max(0, width + shift) / this.shown : 0
  }

  // ---------------------------------------------------------------- input

  private button(cls: string, html: string, label: string): HTMLButtonElement {
    const b = this.root.ownerDocument.createElement('button')
    b.type = 'button'
    b.className = cls
    b.innerHTML = html
    if (label) b.setAttribute('aria-label', label)
    return b
  }

  private on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    el.addEventListener(type, fn as EventListener, opts)
    this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts))
  }

  private bindEvents(): void {
    this.on(this.root, 'pointerdown', (e) => this.pointerDown(e))
    this.on(this.root, 'pointermove', (e) => this.pointerMove(e))
    this.on(this.root, 'pointerup', (e) => this.pointerUp(e))
    this.on(this.root, 'pointercancel', (e) => this.pointerUp(e, true))
    this.on(this.root, 'wheel', (e) => this.wheel(e), { passive: this.swipe.trackpad })
    for (const [el, which] of [
      [this.startHandle, 'start'],
      [this.endHandle, 'end'],
    ] as const) {
      this.on(el, 'pointerdown', (e) => this.handleDown(e, which))
      this.on(el, 'pointermove', (e) => this.handleMove(e))
      this.on(el, 'pointerup', (e) => this.handleUp(e))
      // A canceled touch (a system gesture) or a lost capture ends the drag without committing it.
      this.on(el, 'pointercancel', (e) => this.handleUp(e, true))
      this.on(el, 'lostpointercapture', (e) => this.handleUp(e, true))
      this.on(el, 'keydown', (e) => this.handleKey(e, which))
    }
    this.on(this.cursorGrip, 'keydown', (e) => this.cursorKey(e))
    this.on(this.cursorGrip, 'focus', () => this.syncGripAria())
    this.on(this.cursorBtn, 'pointerdown', (e) => e.stopPropagation())
    this.on(this.cursorBtn, 'click', (e) => {
      e.stopPropagation()
      if (!this.cursorAction) return
      // The button stays with the cursor on its bar, browsed or not; browsing ends after the
      // callback, which schedules the frame that places the cursor.
      this.opts.onCursorAction?.()
      this.returnToCurrent()
    })
    // Entering and leaving Repeat mode (U14): the band's grow / shrink class is dropped when its
    // animation ends; a control fading out is hidden when its animation ends.
    this.on(this.loopEl, 'animationend', () => this.loopEl.classList.remove('pn-loop-enter', 'pn-loop-leave'))
    // A correction that finished fading out is removed (bubbles up from its SVG).
    this.on(this.corrLayer, 'animationend', (e) => {
      const el = e.target as Element | null
      if (el?.parentNode === this.corrLayer && el.classList.contains('pn-corr-leave')) el.remove()
    })
    this.on(this.reminderLayer, 'animationend', (e) => {
      const el = e.target as Element | null
      if (el?.parentNode === this.reminderLayer && el.classList.contains('pn-reminder-leave')) el.remove()
    })
    for (const el of [this.startHandle, this.endHandle, this.clearBtn]) {
      this.on(el, 'animationend', () => {
        if (!el.classList.contains('pn-ctl-leave')) return
        el.classList.remove('pn-ctl-leave')
        el.style.display = 'none'
      })
    }
    this.on(this.clearBtn, 'pointerdown', (e) => e.stopPropagation())
    this.on(this.clearBtn, 'click', (e) => {
      e.stopPropagation()
      if (!this.loopEditable) return
      const browsed = this.endHandleDrag()
      this.loop = null
      this.schedule()
      this.opts.onLoopChange?.(null)
      if (browsed) this.opts.onBrowseRelease?.()
    })
  }

  private pointerDown(e: PointerEvent): void {
    if ((e.target as Element).closest?.('button')) return
    // One finger drags the playhead; other fingers wait until it is released.
    if (this.cursorDrag) return
    // A zoom out or back in still running lands under the finger (U97).
    this.settleReview()
    // A finger stops a coasting zoom (a bounce past a limit goes on), and is no tap then.
    const coasting = this.zoomMotion !== null
    if (coasting && this.zoomWithinLimits()) this.settleZoom()
    const onGrip =
      this.cursorDraggable &&
      !this.reviewOn &&
      this.pointers.size === 0 &&
      !!(e.target as Element).closest?.('.pn-cursor-grip')
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const touch = (e.pointerType === 'touch' || e.pointerType === 'pen') && !onGrip
    // A touch is left to the native scroller under the music (and captured by it already).
    if (!touch) {
      try {
        this.root.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic events in tests have no active pointer.
      }
    }
    if (onGrip) {
      // One layout read per drag; every move after that is arithmetic on cached numbers.
      const rect = this.root.getBoundingClientRect()
      this.cursorDrag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        rootLeft: rect.left,
        rootW: rect.width || this.hostW,
        clientX: e.clientX,
        moved: false,
        free: false,
        knot: -1,
        restoreX: this.cursorX,
      }
      return
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Pointer, Pointer]
      // A pinch that catches a coasting or bouncing zoom goes on from what is on screen.
      const drawn = this.zoomBase() * this.stretch
      this.settleZoom()
      const zoom = this.zoomBase()
      if (Math.abs(drawn / zoom - 1) > 1e-6) this.stretch = drawn / zoom
      const scale = zoom * stretchSource(this.stretch)
      const speed = new PinchSpeed()
      speed.add(e.timeStamp, scale)
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale, speed }
      this.gesture = null
      return
    }
    if (this.pointers.size === 1) {
      this.gesture = {
        startX: e.clientX,
        startY: e.clientY,
        startTx: this.tx,
        t: e.timeStamp,
        // A finger that catches coasting music stops it: not a tap.
        moved: touch && (this.swipe.active || coasting),
        touch,
      }
    }
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    const d = this.cursorDrag
    if (d && d.pointerId === e.pointerId) {
      d.clientX = e.clientX
      if (!d.moved) {
        // A tap on the cursor still seeks to its bar; only past the slop does it become a drag.
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= TAP_SLOP) return
        d.moved = true
        d.free = this.browsing || this.back !== null
        this.dragTx = this.tx
        this.dragScrolled = false
        this.root.classList.add('pn-cursor-dragging')
      }
      this.dragCursorTo(e.clientX)
      this.edgeScroll(e.clientX, d.rootLeft, d.rootW)
      return
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [Pointer, Pointer]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const scale = (this.pinch.scale * dist) / this.pinch.dist
      // In the review a pinch zooms the review only: the playing zoom stays (U97).
      this.pinch.speed.add(e.timeStamp, scale)
      this.pinchTo(scale, this.reviewOn ? (a.x + b.x) / 2 - this.root.getBoundingClientRect().left : 0)
      return
    }
    const g = this.gesture
    if (!g) return
    const dx = e.clientX - g.startX
    if (!g.moved && Math.hypot(dx, e.clientY - g.startY) > TAP_SLOP) g.moved = true
    if (!g.moved) return
    if (g.touch) {
      this.adoptTouch(g, e, dx)
      return
    }
    if (this.reviewOn) {
      // The review pans; nothing is browsed, so playback is not held (U97).
      this.root.classList.add('pn-dragging')
      this.panReview(g.startTx + dx)
      return
    }
    if (!this.browseEnabled) return
    this.browseDragged = true
    if (!this.browsing) {
      this.browsing = true
      this.root.classList.add('pn-browsing')
      this.opts.onBrowse?.(true)
    }
    this.root.classList.add('pn-dragging')
    this.browseTx = this.clampTx(g.startTx + dx)
    this.instant = true
    this.schedule()
  }

  /**
   * A platform that pans cancels the pointer at once. A finger still reporting a sideways drag got
   * no native pan (a scroller that did not engage): it drags the music from here, as a mouse does.
   */
  private adoptTouch(g: { startX: number; startTx: number; t: number; touch: boolean }, e: PointerEvent, dx: number) {
    if (this.swipe.active || Math.abs(dx) < TOUCH_DRAG_PX || e.timeStamp - g.t < TOUCH_DRAG_MS) return
    this.swipe.stop()
    g.touch = false
    g.startX = e.clientX
    g.startTx = this.tx
  }

  private pointerUp(e: PointerEvent, canceled = false): void {
    const d = this.cursorDrag
    if (d && d.pointerId === e.pointerId) {
      this.pointers.delete(e.pointerId)
      this.endCursorDrag(e.clientX, canceled)
      return
    }
    if (!this.pointers.delete(e.pointerId)) return
    this.root.classList.remove('pn-dragging')
    // The last finger of a drag that browsed lifted (or was canceled): the release (U95).
    if (this.pointers.size === 0 && this.browseDragged) {
      this.browseDragged = false
      this.opts.onBrowseRelease?.()
    }
    if (this.pinch) {
      if (this.pointers.size < 2) {
        const { speed } = this.pinch
        this.pinch = null
        this.releaseZoom(canceled ? 0 : speed.at(e.timeStamp))
      }
      return
    }
    const g = this.gesture
    this.gesture = null
    if (!g || g.moved || canceled) return
    this.tap(e.clientX)
  }

  /** Scrub notes beneath the fixed playhead, snapping to onsets; O(log onsets), no layout reads. */
  private dragCursorTo(clientX: number): void {
    const d = this.cursorDrag
    const K = this.cursorKnots
    if (!d || K.pos.length === 0) return
    const x = (clientX - d.rootLeft - (this.dragTx ?? this.tx)) / this.scale
    const k = nearestKnot(K.x, x)
    if (k === d.knot) return
    d.knot = k
    this.cursorX = K.x[k]!
    const text = this.opts.cursorDragLabel?.(K.exact[k]!) ?? ''
    if (this.readoutEl.textContent !== text) this.readoutEl.textContent = text
    this.instant = true
    this.schedule()
  }

  private endCursorDrag(clientX: number, canceled: boolean): void {
    const d = this.cursorDrag
    if (!d) return
    this.cursorDrag = null
    this.stopEdgeScroll()
    this.root.classList.remove('pn-cursor-dragging')
    if (!d.moved) {
      if (!canceled) this.tap(clientX)
      return
    }
    this.dragTx = null
    if (this.browsing) {
      this.browsing = false
      this.root.classList.remove('pn-browsing')
      this.opts.onBrowse?.(false)
    }
    const exact = d.knot >= 0 ? this.cursorKnots.exact[d.knot] : undefined
    const seek = this.opts.onCursorSeek
    // The selected note stays under (or comes to) the fixed cursor; cancellation restores the previous note.
    if (d.free) this.springBack()
    else this.instant = false
    if (canceled || !exact || !seek || seek(exact) === false) this.cursorX = d.restoreX
    this.schedule()
  }

  private cancelCursorDrag(): void {
    const d = this.cursorDrag
    if (!d) return
    this.pointers.delete(d.pointerId)
    this.endCursorDrag(d.clientX, true)
  }

  /**
   * Near a strip edge a drag scrolls the music (the further in, the faster), one step per frame
   * while the finger stays there; the dragged item keeps snapping under the finger.
   */
  private edgeScroll(clientX: number, rootLeft: number, rootW: number): void {
    const rel = clientX - rootLeft
    const depth =
      rel < EDGE_ZONE
        ? (EDGE_ZONE - Math.max(0, rel)) / EDGE_ZONE
        : rel > rootW - EDGE_ZONE
          ? -(EDGE_ZONE - Math.max(0, rootW - rel)) / EDGE_ZONE
          : 0
    this.edgeSpeed = depth * EDGE_SPEED
    if (this.edgeSpeed !== 0 && !this.edgeFrame && !this.destroyed) {
      this.edgeFrame = requestAnimationFrame(this.edgeTick)
    }
  }

  private readonly edgeTick = (): void => {
    this.edgeFrame = 0
    if (this.destroyed || this.dragTx === null || this.edgeSpeed === 0) return
    const next = this.clampTx(this.dragTx + this.edgeSpeed)
    if (next === this.dragTx) return
    this.dragTx = next
    this.dragScrolled = true
    this.instant = true
    if (this.cursorDrag) this.dragCursorTo(this.cursorDrag.clientX)
    else if (this.handleDrag) this.dragHandleTo(this.handleDrag.clientX)
    this.schedule()
    // Already inside an animation frame: apply now rather than in the next one.
    this.flushFrame()
    this.edgeFrame = requestAnimationFrame(this.edgeTick)
  }

  private stopEdgeScroll(): void {
    this.edgeSpeed = 0
    if (this.edgeFrame) cancelAnimationFrame(this.edgeFrame)
    this.edgeFrame = 0
  }

  private tap(clientX: number): void {
    const occ = this.occAt(clientX)
    if (occ < 0) return
    if (this.selectMode === 'tap') {
      const res = tapSelect(this.tapAnchor, occ)
      this.tapAnchor = res.anchor
      this.loop = res.range
      this.schedule()
      this.opts.onLoopChange?.(res.range)
      if (res.done) this.setLoopSelectMode('off')
      return
    }
    // A tap is a seek the learner chose, often on a bar found by browsing: browsing ends so the
    // fixed cursor line shows the new position (as in the page view, U40). Seek first: the
    // session sets the new cursor in its frame, before this view's, so the music moves once.
    this.opts.onSeekRequest?.(occ)
    this.returnToCurrent()
  }

  private wheel(e: WheelEvent): void {
    this.settleReview()
    if (e.ctrlKey || e.metaKey) {
      if (!this.swipe.trackpad) e.preventDefault()
      this.settleZoom()
      const factor = Math.exp(-e.deltaY * 0.004)
      if (this.reviewOn) this.zoomReview(this.shown * factor, e.clientX - this.root.getBoundingClientRect().left)
      else this.userZoom(this.scale * factor)
      return
    }
    if (!this.browseEnabled || this.dragTx !== null) return
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
    if (!d) return
    // Desktop Safari's trackpad scrolls by itself, except over the playhead and the loop controls.
    if (this.swipe.trackpad && this.swipe.el.contains(e.target as Node)) {
      this.swipe.wheel()
      return
    }
    if (!this.swipe.trackpad) e.preventDefault()
    if (this.reviewOn) {
      this.panReview(this.tx - d)
      return
    }
    if (!this.browsing) {
      this.browsing = true
      this.browseTx = this.tx
      this.root.classList.add('pn-browsing')
      this.opts.onBrowse?.(true)
    }
    this.browseTx = this.clampTx(this.browseTx - d)
    this.instant = true
    this.schedule()
    // No finger to lift: a short idle after the last wheel event is the release (U95).
    if (this.wheelRelease) clearTimeout(this.wheelRelease)
    this.wheelRelease = setTimeout(() => {
      this.wheelRelease = 0
      this.browseReleased()
    }, WHEEL_RELEASE_MS)
  }

  /** The loop with one edge moved to loop knot `k`; the other edge stays exactly where it was. */
  private withEdge(loop: LoopRange, which: 'start' | 'end', k: number): LoopRange {
    const K = this.loopKnots
    if (which === 'start') {
      const p = passageFromKnots(K, k, Math.min(k + 1, K.pos.length - 1))
      return {
        fromOcc: Math.min(p.fromOcc, loop.toOcc),
        toOcc: loop.toOcc,
        ...(p.start ? { start: p.start } : {}),
        ...(loop.end ? { end: loop.end } : {}),
      }
    }
    const exact = K.exact[k] ?? null
    const toOcc = exact ? K.occ[k]! : K.occ[k]! - 1
    return {
      fromOcc: loop.fromOcc,
      toOcc: Math.max(loop.fromOcc, toOcc),
      ...(loop.start ? { start: loop.start } : {}),
      ...(exact ? { end: exact } : {}),
    }
  }

  private handleDown(e: PointerEvent, which: 'start' | 'end'): void {
    e.stopPropagation()
    if (!this.loop || !this.loopEditable || this.handleDrag) return
    const { start, end } = passagePositions(this.layout.occurrences, this.loop)
    const limits = edgeLimits(this.loopKnots, which, which === 'start' ? end : start)
    if (!limits) return
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events in tests have no active pointer.
    }
    ;(e.currentTarget as HTMLElement).classList.add('pn-grab')
    const rect = this.root.getBoundingClientRect()
    this.handleDrag = {
      pointerId: e.pointerId,
      which,
      range: this.loop,
      knot: knotAtPosition(this.loopKnots.pos, which === 'start' ? start : end),
      ...limits,
      rootLeft: rect.left,
      rootW: rect.width || this.hostW,
      clientX: e.clientX,
    }
    this.dragTx = this.tx
    this.dragScrolled = false
  }

  private handleMove(e: PointerEvent): void {
    const d = this.handleDrag
    if (!d || e.pointerId !== d.pointerId || !this.loop) return
    e.stopPropagation()
    d.clientX = e.clientX
    this.dragHandleTo(e.clientX)
    this.edgeScroll(e.clientX, d.rootLeft, d.rootW)
  }

  /** The dragged edge snaps to the nearest loop knot (note onset or barline) in its limits. */
  private dragHandleTo(clientX: number): void {
    const d = this.handleDrag
    if (!d || !this.loop) return
    const x = (clientX - d.rootLeft - (this.dragTx ?? this.tx)) / this.scale
    const k = nearestKnot(this.loopKnots.x, x, d.lo, d.hi)
    if (k === d.knot) return
    d.knot = k
    const next = this.withEdge(this.loop, d.which, k)
    if (!sameRange(next, d.range)) {
      d.range = next
      this.schedule()
    }
  }

  /**
   * Ends the drag of the pointer that started it; only a release commits. The `lostpointercapture`
   * that follows a release finds no drag and does nothing.
   */
  private handleUp(e: PointerEvent, canceled = false): void {
    const d = this.handleDrag
    if (!d || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    const browsed = this.endHandleDrag()
    if (!canceled && this.loop && this.loopEditable && !sameRange(d.range, this.loop)) {
      this.loop = d.range
      this.opts.onLoopChange?.(d.range)
    }
    // An edge scroll left the music browsed: the gesture is over, so it is released too (U95).
    if (browsed) this.opts.onBrowseRelease?.()
    this.schedule()
  }

  /**
   * Ends a handle drag without committing its range (the caller commits it on release). The
   * music stays where an edge scroll took it (browsing) instead of jumping back to the cursor.
   * True when that started browsing (the caller reports the release, U95).
   */
  private endHandleDrag(): boolean {
    if (!this.handleDrag) return false
    this.handleDrag = null
    this.stopEdgeScroll()
    this.startHandle.classList.remove('pn-grab')
    this.endHandle.classList.remove('pn-grab')
    let browsed = false
    if (this.dragScrolled && this.browseEnabled && this.dragTx !== null) {
      this.browseTx = this.dragTx
      if (!this.browsing) {
        this.browsing = true
        this.root.classList.add('pn-browsing')
        this.opts.onBrowse?.(true)
        browsed = true
      }
    }
    this.dragTx = null
    this.schedule()
    return browsed
  }

  /**
   * Keyboard playhead (the WP13 gap): arrow keys seek to the previous / next snap onset, with
   * Shift to the first onset of the previous / next bar, Home / End to the first / last onset.
   * Each key press is a seek (`onCursorSeek`), like releasing a drag there.
   */
  private cursorKey(e: KeyboardEvent): void {
    if (!this.cursorDraggable || this.cursorDrag) return
    const K = this.cursorKnots
    const n = K.pos.length
    if (n === 0) return
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    const at = nearestKnot(K.x, this.cursorX)
    let k: number
    if (e.key === 'Home') k = 0
    else if (e.key === 'End') k = n - 1
    else if (step !== 0) {
      if (!e.shiftKey) k = at + step
      else {
        const occs = this.layout.occurrences
        const i = occAtPosition(occs, K.pos[at]!)
        if (step > 0) k = firstKnotAtOrAfter(K.pos, occs[i + 1]?.start ?? Infinity)
        else {
          // The first note of this bar, or of the previous one when already on it.
          k = firstKnotAtOrAfter(K.pos, occs[i]?.start ?? 0)
          if (k >= at) k = firstKnotAtOrAfter(K.pos, occs[i - 1]?.start ?? 0)
        }
      }
      k = Math.max(0, Math.min(n - 1, k))
    } else return
    e.preventDefault()
    if (k === at && !this.browsing) return
    const exact = K.exact[k]
    const seek = this.opts.onCursorSeek
    if (!exact || !seek || seek(exact) === false) return
    this.cursorX = K.x[k]!
    this.instant = false
    this.returnToCurrent()
    this.syncGripAria(k)
    this.schedule()
  }

  /** Slider values and the readout for the focused grip; not called per frame. */
  private syncGripAria(k = nearestKnot(this.cursorKnots.x, this.cursorX)): void {
    const K = this.cursorKnots
    const g = this.cursorGrip
    g.setAttribute('aria-valuemin', '0')
    g.setAttribute('aria-valuemax', String(Math.max(0, K.pos.length - 1)))
    g.setAttribute('aria-valuenow', String(Math.min(k, Math.max(0, K.pos.length - 1))))
    const exact = K.exact[k]
    const text = exact ? (this.opts.cursorDragLabel?.(exact) ?? '') : ''
    if (text) g.setAttribute('aria-valuetext', text)
    else g.removeAttribute('aria-valuetext')
    if (this.readoutEl.textContent !== text) this.readoutEl.textContent = text
  }

  /** Arrow keys move an edge to the next note (Shift: the next barline). */
  private handleKey(e: KeyboardEvent, which: 'start' | 'end'): void {
    if (!this.loop || !this.loopEditable) return
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    e.preventDefault()
    const K = this.loopKnots
    const { start, end } = passagePositions(this.layout.occurrences, this.loop)
    const limits = edgeLimits(K, which, which === 'start' ? end : start)
    if (!limits) return
    let k = knotAtPosition(K.pos, which === 'start' ? start : end) + step
    if (e.shiftKey) while (k > limits.lo && k < limits.hi && K.exact[k] !== null) k += step
    k = Math.min(limits.hi, Math.max(limits.lo, k))
    const next = clampRange(this.withEdge(this.loop, which, k), this.layout.occurrences.length)
    if (sameRange(next, this.loop)) return
    this.loop = next
    this.schedule()
    this.opts.onLoopChange?.(next)
  }
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}
