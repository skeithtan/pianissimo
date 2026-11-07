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
 * - All live updates (targets, accepted, wrong marker, automatic part, playback, subdued hand,
 *   ottava emphasis, labels and their opacity) are attribute/class/style writes on mounted nodes,
 *   batched in one requestAnimationFrame and O(changed notes). Nothing is re-engraved.
 * - Pinch/ctrl-wheel zoom is a CSS scale (R2); drag inspection while browsing is enabled;
 *   passage selection with handles (snapping to note onsets, U21), tap selection and a clear
 *   button; the playhead itself can be dragged onto a note while nothing plays (U23).
 * - A new engraving of the same score with other spacing (Labels Off ↔ on) glides in from the
 *   previous view's columns, the cursor note staying under the fixed line (`respaceFrom`).
 */
import type { Hand } from '../../core/model/score'
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
import { ACTION_RADIUS, staffGap } from '../shared/cursorAction'
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
import {
  clampTranslate,
  occAtPosition,
  occAtX,
  scrollTranslate,
  verticalTranslate,
  visibleRange,
  zoomAround,
} from './scroll'
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
  /** Tap on a measure outside selection mode. */
  readonly onSeekRequest?: (occ: number) => void
  /** Handle drag end, tap selection, keyboard nudge, or the clear button (null). */
  readonly onLoopChange?: (range: LoopRange | null) => void
  readonly onLoopSelectModeChange?: (mode: LoopSelectMode) => void
  /** Note indices whose labels became visible in the viewport (assistance tracking). */
  readonly onVisibleLabels?: (added: readonly number[]) => void
  readonly onZoomChange?: (scale: number) => void
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
const AUTO = 4
const PLAY = 8
const FLAG_CLASSES: readonly [number, string][] = [
  [TARGET, 'pn-target'],
  [ACCEPTED, 'pn-acc'],
  [AUTO, 'pn-auto'],
  [PLAY, 'pn-play'],
]
const TAP_SLOP = 8
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
/** Below this band width on screen (px) the loop's ✕ is drawn small (U14). */
const CLEAR_SMALL_PX = 150
/** Cursor bar margin beyond the top and bottom staves, faded by its mask (screen px). */
const CURSOR_MARGIN = 96
/** Space kept above the top staff and below the bottom staff when fitting zoom (layout px). */
const STAFF_MARGIN = 28
/** Fade distance to the right of the fixed clef/key/meter, in layout px. */
const CONTEXT_FADE = 32
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
  private readonly segLayer: HTMLDivElement
  private readonly cursorEl: HTMLDivElement
  private readonly cursorBar: HTMLDivElement
  private readonly cursorBtn: HTMLButtonElement
  private readonly cursorGrip: HTMLDivElement
  private readonly readoutEl: HTMLDivElement
  private readonly contextWidth: number
  private readonly path: CursorPath
  private readonly stickyEl: HTMLDivElement
  private readonly stickyInner: HTMLDivElement
  private readonly loopEl: HTMLDivElement
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
  private applied = { tx: NaN, ty: NaN, scale: NaN, cursorSx: NaN, barTop: NaN, barH: NaN, actionTop: NaN }
  private hostW = 0
  private hostH = 0
  private instant = true
  private browsing = false
  private browseTx = 0
  private browseEnabled = false
  private subdued: Hand | null = null

  private wrongOn = false
  private earlyOn = false
  private ottavaSpans: number[] = []
  private readonly ottavaBoxes = new Map<number, HTMLDivElement>()
  private readonly reminders = new Map<number, HTMLDivElement>()

  /** Identity of the corrections last asked for; `pendingCorrections` waits for the next frame. */
  private corrKey = ''
  private pendingCorrections: readonly CorrectionMark[] | null = null
  private corrLeaveTimer: ReturnType<typeof setTimeout> | null = null
  private corrMeasurer: TextMeasurer | null = null

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
  private stickyContext = -1

  private readonly pointers = new Map<number, Pointer>()
  private gesture: { startX: number; startY: number; startTx: number; t: number; moved: boolean } | null = null
  private pinch: { dist: number; scale: number } | null = null
  private handleDrag: {
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
    knot: number
    /** Where the cursor really is (restored on cancel or refusal; follows `setCursor` meanwhile). */
    restoreX: number
  } | null = null
  /** Content translate while a drag holds (and edge-scrolls) the music; null otherwise. */
  private dragTx: number | null = null
  private dragScrolled = false
  private edgeSpeed = 0
  private edgeFrame = 0

  private respace: RespaceRun | null = null

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
    this.path = new CursorPath(layout.occurrences)
    this.cursorX = this.path.at(layout.occurrences[0]?.start ?? 0)
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
    this.root.setAttribute('aria-label', 'Score')
    this.stage = div('pn-stage')
    this.content = div('pn-content')
    this.content.style.width = `${layout.width}px`
    this.content.style.height = `${layout.height}px`

    this.loopEl = div('pn-loop')
    this.loopEl.style.height = `${layout.height}px`
    this.segLayer = div('pn-segs')
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
    grip.setAttribute('aria-label', opts.cursorLabel ?? 'Playhead: drag or use arrow keys')
    grip.setAttribute('aria-orientation', 'horizontal')
    grip.tabIndex = 0
    grip.toggleAttribute('inert', true)
    this.cursorGrip = grip
    this.readoutEl = div('pn-cursor-readout')
    this.readoutEl.setAttribute('aria-hidden', 'true')
    this.cursorBtn = this.button('pn-cursor-action', icon.repeat, opts.cursorActionLabel ?? 'Repeat from here')
    this.cursorBtn.toggleAttribute('inert', true)
    // Without a handler (Consult mode, U72) the button is never shown, so it is not in the DOM.
    this.cursorEl.append(bar, grip, this.readoutEl)
    if (opts.onCursorAction) this.cursorEl.append(this.cursorBtn)

    this.startHandle = this.button(
      'pn-loop-ctl pn-handle pn-handle-start',
      icon.left,
      'Passage start: drag or use arrow keys',
    )
    this.endHandle = this.button(
      'pn-loop-ctl pn-handle pn-handle-end',
      icon.right,
      'Passage end: drag or use arrow keys',
    )
    this.clearBtn = this.button('pn-loop-ctl pn-loop-clear', icon.clear, 'Clear passage selection')

    this.content.append(this.loopEl, this.segLayer, this.corrLayer, this.startHandle, this.endHandle, this.clearBtn)
    this.stickyEl = div('pn-sticky')
    this.stickyInner = div('pn-sticky-inner')
    this.stickyEl.append(this.stickyInner)
    this.stage.append(this.content)
    this.root.append(this.stage, this.stickyEl, this.cursorEl)
    if (opts.returnButton !== false) {
      const ret = this.button(
        'pn-return',
        `${icon.back}<span>${escapeText(opts.returnLabel ?? 'Return to current position')}</span>`,
        '',
      )
      ret.addEventListener('click', () => this.returnToCurrent())
      this.root.append(ret)
    }
    host.append(this.root)

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
        this.measureHost()
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
   * The transport wrapped back to the start of a loop (`position`, whole notes): the music pans
   * back quickly (320 ms ease-out, `pn-wrap`) to put that position under the fixed cursor. A wrap
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
    this.cursorX = this.path.smoothAt(position)
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

  /** Notes the app plays (automatic part), drawn in the automatic-part color. */
  setAutomatic(notes: readonly number[]): void {
    this.setFlag(AUTO, notes)
  }

  /** Notes sounding in reference playback / Listen. */
  setPlaybackHighlights(notes: readonly number[]): void {
    this.setFlag(PLAY, notes)
  }

  /** Subdues the unselected hand's notation and labels (hand practice). */
  setSubduedHand(hand: Hand | null): void {
    if (hand === this.subdued) return
    this.subdued = hand
    this.root.classList.toggle('pn-sub-L', hand === 'L')
    this.root.classList.toggle('pn-sub-R', hand === 'R')
  }

  /** Wrong-key cursor tint; stays until the group completes (`false`). */
  setWrongMarker(on: boolean): void {
    if (on === this.wrongOn) return
    this.wrongOn = on
    this.schedule()
  }

  /** Too-early press (right pitch, too soon): amber cursor tint; the wrong tint wins over it. */
  setEarlyMarker(on: boolean): void {
    if (on === this.earlyOn) return
    this.earlyOn = on
    this.schedule()
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

  /** One wrong attack: retain the cursor tint; screen-level feedback is owned by the caller. */
  pulseWrong(): void {
    this.wrongOn = true
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
    if (!editable) this.endHandleDrag()
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
    this.userZoom(scale)
  }

  zoom(): number {
    return this.scale
  }

  isBrowsing(): boolean {
    return this.browsing
  }

  /** Exact note under the fixed cursor after browsing, ready for the session to resume there. */
  browsedPosition(): Rational | null {
    if (!this.browsing) return null
    return this.cursorKnots.exact[this.knotUnderCursorLine()] ?? null
  }

  returnToCurrent(): void {
    if (!this.browsing) return
    this.browsing = false
    this.root.classList.remove('pn-browsing')
    this.instant = false
    this.opts.onBrowse?.(false)
    this.schedule()
  }

  /** Measure index under a client x coordinate. */
  occAt(clientX: number): number {
    const rect = this.root.getBoundingClientRect()
    return occAtX(this.layout.occurrences, (clientX - rect.left - this.tx) / this.scale)
  }

  /** The bar under the fixed cursor line as the music is currently placed on screen (-1 for an empty layout). */
  private occUnderCursorLine(): number {
    const tx = Number.isNaN(this.applied.tx) ? this.tx : this.applied.tx
    const sx = this.hostW * (this.opts.cursorAnchor ?? 1 / 3)
    return occAtX(this.layout.occurrences, (sx - tx) / this.scale)
  }

  /** Use the applied transform: an unpainted drag or zoom must not choose a different note. */
  private knotUnderCursorLine(): number {
    const tx = Number.isNaN(this.applied.tx) ? this.tx : this.applied.tx
    const scale = Number.isNaN(this.applied.scale) ? this.scale : this.applied.scale
    const sx = Number.isNaN(this.applied.cursorSx)
      ? this.hostW * (this.opts.cursorAnchor ?? 1 / 3)
      : this.applied.cursorSx
    return nearestKnot(this.cursorKnots.x, (sx - tx) / scale)
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
    const instant = this.instant
    this.flush()
    // Commit styles while the no-transition class is set, so a later frame removing it cannot
    // animate this synchronous jump.
    if (instant) void getComputedStyle(this.content).transform
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
    this.resize?.disconnect()
    for (const off of this.cleanup) off()
    this.store.destroy()
    this.root.remove()
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
    const margin = 6 / this.scale
    const top = -this.ty / this.scale + margin
    const bottom = (this.hostH - this.ty) / this.scale - margin - h / this.scale
    return bottom < top ? y : Math.min(bottom, Math.max(top, y))
  }

  private applyZoom(scale: number, notify: boolean): void {
    if (scale === this.scale) return
    if (this.browsing) {
      const center = (this.hostW / 2 - this.browseTx) / this.scale
      this.browseTx = clampTranslate(
        zoomAround(this.browseTx, this.scale, scale, center),
        this.layout.width,
        this.hostW,
        scale,
        this.opts.cursorAnchor,
      )
    }
    this.scale = scale
    this.instant = true
    this.setZoomProperties()
    if (notify) this.opts.onZoomChange?.(scale)
    this.schedule()
  }

  /** A zoom the user (or the owner) asked for: remembered, applied fitted, reported. */
  private userZoom(scale: number): void {
    const z = this.clampZoom(scale)
    this.requestedZoom = z
    this.applyZoom(z, true)
  }

  /** The zoom for CSS: the cursor's width and the counter-scale of the loop controls. */
  private setZoomProperties(): void {
    this.root.style.setProperty('--pn-inv-zoom', String(1 / this.scale))
    this.root.style.setProperty('--pn-zoom', String(this.scale))
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
    // Browsing or a drag takes over the translate: a wrap in progress ends.
    if (this.wrap && (this.browsing || this.dragTx !== null)) this.endWrap()
    const wrap = this.wrap
    this.tx =
      this.dragTx !== null && !this.cursorDrag
        ? clampTranslate(this.dragTx, L.width, this.hostW, this.scale, this.opts.cursorAnchor)
        : this.browsing && !this.cursorDrag?.moved
          ? clampTranslate(this.browseTx, L.width, this.hostW, this.scale, this.opts.cursorAnchor)
          : wrap?.phase === 'lead'
            ? wrap.from
            : this.cursorTranslate()
    this.ty = verticalTranslate(L, this.hostH, this.scale)
    // A far jump (seek) is not animated: it would sweep past everything in between and need it all
    // mounted. A wrap (`wrapTo`) has its own rules: an instant lead, then a quick pan.
    const far = !Number.isNaN(prevTx) && Math.abs(this.tx - prevTx) > this.hostW * FAR_JUMP_VIEWPORTS
    const instant = wrap ? wrap.phase === 'lead' : this.instant || far
    this.root.classList.toggle('pn-instant', instant)
    this.instant = false
    if (wrap?.phase === 'pan' && !this.wrapTimer) {
      this.root.classList.add('pn-wrap')
      this.wrapTimer = setTimeout(() => this.endWrap(), WRAP_MS + 80)
    }

    const moved = this.tx !== prevTx || this.scale !== prevScale || this.ty !== this.applied.ty
    if (moved) {
      this.content.style.transform = `translate3d(${r2(this.tx)}px, ${r2(this.ty)}px, 0) scale(${this.scale})`
      this.stickyInner.style.transform = `translate3d(0, ${r2(this.ty)}px, 0) scale(${this.scale})`
      this.applied.tx = this.tx
      this.applied.ty = this.ty
      this.applied.scale = this.scale
    }
    this.respace?.follow(this.screenFrame())

    // Mount for both the old and the new view so a smooth scroll never reveals a gap; during a
    // wrap, for the whole range its pan sweeps (already while the lead lands).
    const view = visibleRange(this.tx, this.scale, this.hostW)
    const old =
      Number.isNaN(prevTx) || instant
        ? view
        : visibleRange(prevTx, Number.isNaN(prevScale) ? this.scale : prevScale, this.hostW)
    let vx0 = Math.min(view.x0, old.x0)
    let vx1 = Math.max(view.x1, old.x1)
    if (wrap) {
      const a = visibleRange(wrap.from, this.scale, this.hostW)
      const b = visibleRange(wrap.to, this.scale, this.hostW)
      vx0 = Math.min(vx0, a.x0, b.x0)
      vx1 = Math.max(vx1, a.x1, b.x1)
    }
    const over = (this.opts.overscan ?? 1) * (this.hostW / this.scale)
    const required = new Set(this.store.wanted(vx0, vx1, this.cursorX))
    const wanted = this.store.wanted(vx0 - over, vx1 + over, (view.x0 + view.x1) / 2)
    const done = this.store.sync(wanted, required, this.opts.mountBudget ?? 1)

    this.applyNotes()
    this.applyLabels()

    // Screen x of the cursor: constant (no style write) while the music scrolls beneath it.
    const sx = r2(this.hostW * (this.opts.cursorAnchor ?? 1 / 3))
    if (sx !== this.applied.cursorSx) {
      this.cursorEl.style.transform = `translate3d(${sx}px, 0, 0)`
      this.applied.cursorSx = sx
    }
    this.applyCursorBar()
    this.placeActionButton()
    this.applyWrong()
    this.applyLoop()
    if (this.pendingCorrections) this.applyCorrections()
    const stickyW = this.applySticky(view.x0)
    this.applyOttava(view.x0 + stickyW, view.x1)
    if (moved || this.labelsChanged) this.reportVisibleLabels(view.x0 + stickyW, view.x1)
    this.labelsChanged = false
    if (wrap?.phase === 'lead') {
      // The lead is in place (committed when the browser renders this frame): pan next frame.
      wrap.phase = 'pan'
      this.schedule()
    } else if (!done) this.schedule()
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
    const c = gap ? this.ty + ((gap.top + gap.bottom) / 2 - L.top) * this.scale : this.hostH / 2
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
    const top = r2(this.ty + (first.top - L.top) * this.scale - CURSOR_MARGIN)
    const h = r2((last.bottom - first.top) * this.scale + 2 * CURSOR_MARGIN)
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
   * Note classes on `seg`'s notehead for `n` (the owner's or a copy's); the halo / ring / play
   * mark (`this.marks`, one per note) only in the owning segment.
   */
  private paintNote(seg: MountedSegment, n: number): void {
    const f = this.flags[n]!
    const head = seg.heads.get(n)
    if (head) for (const [bit, cls] of FLAG_CLASSES) head.classList.toggle(cls, (f & bit) !== 0)
    if (!this.owns(seg, n)) return
    const markCls = f & ACCEPTED ? 'pn-ring' : f & TARGET ? 'pn-halo' : f & PLAY ? 'pn-playmark' : ''
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

  private applyWrong(): void {
    this.cursorEl.classList.toggle('pn-cursor-wrong', this.wrongOn)
    this.cursorEl.classList.toggle('pn-cursor-early', this.earlyOn)
  }

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
      const vy0 = L.top - this.ty / this.scale
      const vy1 = L.top + (this.hostH - this.ty) / this.scale
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
      const y = this.clampVisibleY((st?.top ?? 0) - L.top - 16 - 28 / this.scale, 28) + 14 / this.scale
      el.style.transform = `translate(${r2(this.cursorX + 18)}px, ${r2(y)}px) scale(${1 / this.scale}) translateY(-50%)`
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
    if (last.r === r && last.show === show && last.scale === this.scale) return
    const entering = !last.r && !!r
    if (!!last.r && !r) {
      // Leaving: the band shrinks back into the cursor's position (U14).
      this.loopEl.style.setProperty('--pn-loop-origin', this.loopOrigin(last.mid - last.width / 2, last.width))
      this.loopTransition('pn-loop-leave')
    }
    this.loopShown = { r, show, scale: this.scale, width: 0, mid: 0 }
    this.loopEl.classList.toggle('pn-on', !!r)
    this.setControlsShown(show)
    if (!r) return
    const a = L.occurrences[r.fromOcc]!
    const b = L.occurrences[r.toOcc]!
    const pos = passagePositions(L.occurrences, r)
    const x0 = r.start ? loopEdgeX(L.occurrences, pos.start) : a.x0
    const x1 = r.end ? loopEdgeX(L.occurrences, pos.end) : b.x1
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
    this.clearBtn.classList.toggle('pn-loop-clear-small', (x1 - x0) * this.scale < CLEAR_SMALL_PX)
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

  /** Sticky clef/key/meter; returns the screen-covered width in layout px. */
  private applySticky(viewX0: number): number {
    const L = this.layout
    const changes = L.contextChanges
    const first = changes[0]
    if (!first) return 0
    const on = viewX0 > first.glyphEnd - 2
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
      this.stickyInner.innerHTML = `<svg xmlns="${SVG_NS}" width="${ctx.width + CONTEXT_FADE}" height="${L.height}" viewBox="0 0 ${ctx.width + CONTEXT_FADE} ${L.height}"><g class="pn-context-staff">${lines}</g>${parts}</svg>`
      this.stickyInner.style.width = `${ctx.width}px`
      this.stickyInner.style.height = `${L.height}px`
    }
    const mask = on
      ? `linear-gradient(to right, transparent ${r2(ctx.width * this.scale)}px, #000 ${r2((ctx.width + CONTEXT_FADE) * this.scale)}px)`
      : ''
    if (this.stickyMask !== mask) {
      this.stickyMask = mask
      this.stage.style.maskImage = mask
      this.stage.style.webkitMaskImage = mask
    }
    return on ? ctx.width : 0
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
    this.on(this.root, 'wheel', (e) => this.wheel(e), { passive: false })
    for (const [el, which] of [
      [this.startHandle, 'start'],
      [this.endHandle, 'end'],
    ] as const) {
      this.on(el, 'pointerdown', (e) => this.handleDown(e, which))
      this.on(el, 'pointermove', (e) => this.handleMove(e))
      this.on(el, 'pointerup', (e) => this.handleUp(e))
      this.on(el, 'pointercancel', (e) => this.handleUp(e))
      this.on(el, 'keydown', (e) => this.handleKey(e, which))
    }
    this.on(this.cursorGrip, 'keydown', (e) => this.cursorKey(e))
    this.on(this.cursorGrip, 'focus', () => this.syncGripAria())
    this.on(this.cursorBtn, 'pointerdown', (e) => e.stopPropagation())
    this.on(this.cursorBtn, 'click', (e) => {
      e.stopPropagation()
      if (!this.cursorAction) return
      if (!this.browsing) {
        this.opts.onCursorAction?.()
        return
      }
      // Browsing: the music under the fixed cursor line is not the cursor's bar, and the button
      // sits over that music (U14). The bar under the line is the one acted on; browsing ends
      // after the callback so the view settles on the position the action moves the cursor to
      // (the callback schedules that frame first).
      const occ = this.occUnderCursorLine()
      this.opts.onCursorAction?.(occ < 0 ? undefined : occ)
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
      this.endHandleDrag()
      this.loop = null
      this.schedule()
      this.opts.onLoopChange?.(null)
    })
  }

  private pointerDown(e: PointerEvent): void {
    if ((e.target as Element).closest?.('button')) return
    // One finger drags the playhead; other fingers wait until it is released.
    if (this.cursorDrag) return
    const onGrip =
      this.cursorDraggable && this.pointers.size === 0 && !!(e.target as Element).closest?.('.pn-cursor-grip')
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try {
      this.root.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events in tests have no active pointer.
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
        knot: -1,
        restoreX: this.cursorX,
      }
      return
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Pointer, Pointer]
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: this.scale }
      this.gesture = null
      return
    }
    if (this.pointers.size === 1) {
      this.gesture = { startX: e.clientX, startY: e.clientY, startTx: this.tx, t: e.timeStamp, moved: false }
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
      this.userZoom((this.pinch.scale * dist) / this.pinch.dist)
      return
    }
    const g = this.gesture
    if (!g) return
    const dx = e.clientX - g.startX
    if (!g.moved && Math.hypot(dx, e.clientY - g.startY) > TAP_SLOP) g.moved = true
    if (!g.moved || !this.browseEnabled) return
    if (!this.browsing) {
      this.browsing = true
      this.root.classList.add('pn-browsing')
      this.opts.onBrowse?.(true)
    }
    this.root.classList.add('pn-dragging')
    this.browseTx = clampTranslate(g.startTx + dx, this.layout.width, this.hostW, this.scale, this.opts.cursorAnchor)
    this.instant = true
    this.schedule()
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
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null
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
    // The selected note stays under the fixed cursor; cancellation restores the previous note.
    this.instant = false
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
    const next = clampTranslate(
      this.dragTx + this.edgeSpeed,
      this.layout.width,
      this.hostW,
      this.scale,
      this.opts.cursorAnchor,
    )
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
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      this.userZoom(this.scale * Math.exp(-e.deltaY * 0.004))
      return
    }
    if (!this.browseEnabled || this.dragTx !== null) return
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
    if (!d) return
    e.preventDefault()
    if (!this.browsing) {
      this.browsing = true
      this.browseTx = this.tx
      this.root.classList.add('pn-browsing')
      this.opts.onBrowse?.(true)
    }
    this.browseTx = clampTranslate(this.browseTx - d, this.layout.width, this.hostW, this.scale, this.opts.cursorAnchor)
    this.instant = true
    this.schedule()
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
    if (!this.loop || !this.loopEditable) return
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
    if (!d || !this.loop) return
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

  private handleUp(e: PointerEvent): void {
    const d = this.handleDrag
    ;(e.currentTarget as HTMLElement).classList.remove('pn-grab')
    if (!d) return
    e.stopPropagation()
    this.endHandleDrag()
    if (this.loop && this.loopEditable && !sameRange(d.range, this.loop)) {
      this.loop = d.range
      this.opts.onLoopChange?.(d.range)
    }
    this.schedule()
  }

  /**
   * Ends a handle drag without committing its range (the caller commits it on release). The
   * music stays where an edge scroll took it (browsing) instead of jumping back to the cursor.
   */
  private endHandleDrag(): void {
    if (!this.handleDrag) return
    this.handleDrag = null
    this.stopEdgeScroll()
    this.startHandle.classList.remove('pn-grab')
    this.endHandle.classList.remove('pn-grab')
    if (this.dragScrolled && this.browseEnabled && this.dragTx !== null) {
      this.browseTx = this.dragTx
      if (!this.browsing) {
        this.browsing = true
        this.root.classList.add('pn-browsing')
        this.opts.onBrowse?.(true)
      }
    }
    this.dragTx = null
    this.schedule()
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
    const at = this.browsing ? this.knotUnderCursorLine() : nearestKnot(K.x, this.cursorX)
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
    this.returnToCurrent()
    this.instant = false
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

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
