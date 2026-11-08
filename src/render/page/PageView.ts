/**
 * Portrait page mode (DECISIONS "Portrait page mode"): the score as an engraved page — systems
 * wrapped to the width and stacked, scrolling vertically — with the cursor moving along the
 * music instead of the music moving under a fixed cursor. Framework-free DOM; the same contract
 * the practice session drives on the strip (`StripSink` + the view's `StripHandle`).
 *
 * - Systems are segments mounted for the visible range ± one viewport (bounded detached LRU).
 * - The cursor is the strip's translucent bar (R13 look), spanning the current system's staves
 *   plus 96 px faded at each end, at the x of the musical position along that system's cursor
 *   path; the round repeat button rides on it. Within a system it glides (180 ms per seek,
 *   per-frame while following); at a system boundary it jumps to the next system.
 * - A page wider than the viewport can be browsed horizontally and pans to keep the cursor
 *   readable during playback. Pages that fit stay still while a line is played. When the current
 *   system changes (and on a seek, wrap or return), the page scrolls (300 ms `--ease-standard`, instant with reduced
 *   motion) so that system's top sits a quarter down the viewport, unless the learner browses
 *   (a manual scroll while browsing is enabled; "Return to current position").
 * - Note states, labels, ottava emphasis, loop band, corrections: the strip's classes and
 *   semantics (strip.css styles them; page.css adds the page structure).
 * - Zoom changes the page width: a pinch / ctrl-wheel / `setZoom` previews the scale at once and,
 *   250 ms after it settles, reports `onZoomChange(scale)`; the owner re-prepares the layout at
 *   `pageWidthFor(stage, scale)` and opens a new view at that zoom.
 * - A new engraving with other spacing (Labels Off ↔ on) keeps the cursor's line where it was on
 *   screen and glides the notes in from the previous view's columns (`respaceFrom`).
 */
import type { Hand } from '../../core/model/score'
import type { Rational } from '../../core/music/rational'
import { toNumber } from '../../core/music/rational'
import { canvasMeasurer, estimateMeasurer, loadLabelFont, type TextMeasurer } from '../labels/metrics'
import {
  CORRECTION_LEAVE_MS,
  CORRECTION_STAGGER_MS,
  buildCorrection,
  correctionsKey,
  layoutCorrections,
  type CorrectionMark,
} from '../shared/corrections'
import { clampRange, sameRange, tapSelect, type LoopRange } from '../strip/loop'
import { occAtPosition } from '../strip/scroll'
import {
  buildLoopKnots,
  edgeLimits,
  firstKnotAtOrAfter,
  knotAtPosition,
  nearestKnot,
  passageFromKnots,
  passagePositions,
  type CursorKnots,
  type LoopKnots,
} from '../strip/snap'
import type { StripOptions, StripStats, LoopSelectMode } from '../strip/StripView'
import { ACTION_RADIUS, staffGap } from '../shared/cursorAction'
import {
  collectPieces,
  lineOf,
  startRespace,
  wider,
  type RespaceRun,
  type RespaceSnapshot,
  type ScreenFrame,
} from '../shared/respace'
import type { LabelBox, PreparedLayout } from '../types'
import { PAGE_GUTTER, PageGeometry, type Band } from './geometry'
import { PageSegmentStore, type MountedSegment } from './segments'
import '../strip/strip.css'
import './page.css'

export interface PageOptions extends StripOptions {
  /** Where the current system's top rests, as a fraction of the viewport height (default 1/4). */
  readonly followOffset?: number
  /** Debounce before a zoom change is reported (`onZoomChange`), ms (default 250). */
  readonly zoomDebounceMs?: number
  /**
   * Fit the page to the host's width (R17, a phone): the shown scale never exceeds what puts the
   * whole canvas between the side gutters, so the page never scrolls sideways. The zoom asked for
   * is kept (and reported) as the preference; a wider host shows it again.
   */
  readonly fitWidth?: boolean
}

export type PageStats = StripStats

const SVG_NS = 'http://www.w3.org/2000/svg'
// Note flags and their classes: COPIED from StripView (same values and class names).
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
/** Space above the first system (screen px). */
export const PAGE_PAD_TOP = 16
/** The page's follow scroll (`--dur-slow`), ms. */
const SCROLL_MS = 300
/** `--ease-standard` (global.css); read from the theme when available. */
const EASE_STANDARD = 'cubic-bezier(0.4, 0, 0.2, 1)'
/** Below this band width on screen (px) the loop's ✕ is drawn small (U14). */
const CLEAR_SMALL_PX = 150
/** Consecutive `smooth: false` calls advancing at most this far are one motion (R12). */
const FOLLOW_MAX_STEP = 0.25
/** A held loop handle scrolls within this distance of a viewport edge. */
const HANDLE_SCROLL_ZONE = 48
const HANDLE_SCROLL_SPEED = 600

interface LabelNode {
  readonly text: SVGTextElement
  readonly leader: SVGLineElement | null
  str: string
  opacity: number
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

export class PageView {
  private readonly layout: PreparedLayout
  private readonly opts: PageOptions
  private readonly geo: PageGeometry
  private readonly root: HTMLDivElement
  private readonly scroller: HTMLDivElement
  private readonly sheet: HTMLDivElement
  private readonly content: HTMLDivElement
  private readonly loopLayer: HTMLDivElement
  private readonly segLayer: HTMLDivElement
  private readonly corrLayer: HTMLDivElement
  private readonly overlay: HTMLDivElement
  private readonly cursorEl: HTMLDivElement
  private readonly cursorBtn: HTMLButtonElement
  private readonly cursorGrip: HTMLDivElement
  private readonly readoutEl: HTMLDivElement
  private readonly startHandle: HTMLButtonElement
  private readonly endHandle: HTMLButtonElement
  private readonly clearBtn: HTMLButtonElement
  private readonly store: PageSegmentStore

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

  /** Musical position of the cursor and where it is drawn (system, layout x). */
  private cursorPos: number
  private cursor: { system: number; x: number }
  private followPos: number | null = null
  private following = false
  private cursorAction = false
  /** The page should bring the current system to its resting place in the next frame. */
  private followRequest: 'smooth' | 'instant' | null = 'instant'
  private followXRequest = true
  private lastSystem = -1
  private readonly reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly ease: string

  /** The scale shown: `requestedZoom`, or less when `fitWidth` needs it (`fitted`). */
  private scale: number
  /** The zoom asked for (option, `setZoom`, pinch, ctrl-wheel), the one reported and saved. */
  private requestedZoom: number
  private hostW = 0
  private hostH = 0
  /** Last scroll offset read or written (scroll events update it; no reads in the frame). */
  private scrollY = 0
  private scrollX = 0
  /** The offset this view last wrote; a scroll event elsewhere is the learner's. */
  private writtenY = 0
  private writtenX = 0
  /** A follow scroll gliding (Web Animations FLIP on the sheet) until `until`. */
  private glide: { from: number; to: number; fromX: number; toX: number; until: number } | null = null
  private glideAnim: Animation | null = null
  private instant = true
  private applied = {
    cursor: '',
    cursorH: NaN,
    sheetH: NaN,
    sheetW: NaN,
    position: NaN,
    transform: '',
    gx: NaN,
    actionTop: NaN,
  }
  private browsing = false
  private browseEnabled = false
  private subdued: Hand | null = null
  private wrongOn = false
  private earlyOn = false
  private ottavaSpans: number[] = []
  private readonly ottavaBoxes = new Map<number, HTMLDivElement>()
  private readonly reminders = new Map<number, HTMLDivElement>()

  private corrKey = ''
  private pendingCorrections: readonly CorrectionMark[] | null = null
  private corrLeaveTimer: ReturnType<typeof setTimeout> | null = null
  private corrMeasurer: TextMeasurer | null = null

  private loop: LoopRange | null = null
  private loopShown: { r: LoopRange | null; show: boolean; scale: number } = { r: null, show: false, scale: NaN }
  private readonly bandEls: HTMLDivElement[] = []
  private snapSource: readonly Rational[] | null = null
  private readonly cursorKnotCache = new Map<number, CursorKnots>()
  private readonly loopKnotCache = new Map<number, LoopKnots>()
  private globalLoopKnots: LoopKnots
  private cursorDraggable = false
  private loopEditable = true
  private selectMode: LoopSelectMode = 'off'
  private tapAnchor: number | null = null

  private readonly pointers = new Map<number, { x: number; y: number }>()
  private gesture: {
    startX: number
    startY: number
    scrollX: number
    mouse: boolean
    moved: boolean
  } | null = null
  private pinch: { dist: number; scale: number } | null = null
  private handleDrag: {
    pointerId: number
    which: 'start' | 'end'
    range: LoopRange
    system: number
    knot: number
    lo: number
    hi: number
    left: number
    top: number
    width: number
    height: number
    startX: number
    clientX: number
    clientY: number
    wrappedSystem: number | null
    wrappedY: number
    edge: -1 | 0 | 1
    scrolled: boolean
  } | null = null
  private handleScrollFrame = 0
  private handleScrollAt = 0
  private handleScrollSpeed = 0
  private handleScrollSpeedX = 0
  private cursorDrag: {
    pointerId: number
    startX: number
    startY: number
    left: number
    moved: boolean
    knot: number
    system: number
    knots: CursorKnots
    restore: number
    clientX: number
    viewLeft: number
    scrollX: number
  } | null = null
  private cursorScrollFrame = 0
  private cursorScrollAt = 0
  private cursorScrollSpeed = 0
  private zoomTimer: ReturnType<typeof setTimeout> | null = null

  private respace: RespaceRun | null = null
  private cursorRespace: {
    readonly geo: PageGeometry
    readonly prev: ScreenFrame
    readonly next: ScreenFrame
  } | null = null

  private frame = 0
  private destroyed = false
  private readonly resize: ResizeObserver | undefined
  private readonly cleanup: (() => void)[] = []

  constructor(host: HTMLElement, layout: PreparedLayout, opts: PageOptions = {}) {
    this.layout = layout
    this.opts = opts
    this.geo = new PageGeometry(layout)
    this.flags = new Uint8Array(layout.notes.length)
    this.noteOpacity = new Float32Array(layout.notes.length)
    this.requestedZoom = this.clampZoom(opts.initialZoom ?? 1)
    this.scale = this.requestedZoom
    this.cursorPos = layout.occurrences[0]?.start ?? 0
    this.cursor = this.geo.cursorAt(this.cursorPos)
    this.globalLoopKnots = buildLoopKnots(layout.occurrences, null)
    const doc = host.ownerDocument
    const div = (cls: string): HTMLDivElement => {
      const d = doc.createElement('div')
      d.className = cls
      return d
    }

    this.root = div('pn-strip pn-page pn-instant')
    this.root.setAttribute('role', 'group')
    this.root.setAttribute('aria-label', 'Score')
    this.scroller = div('pn-page-scroll pn-page-locked')
    this.scroller.setAttribute('data-testid', 'page-scroll')
    this.sheet = div('pn-page-sheet')
    this.content = div('pn-page-content')
    this.content.style.width = `${layout.width}px`
    this.content.style.height = `${layout.height}px`
    this.loopLayer = div('pn-page-loops')
    this.segLayer = div('pn-segs')
    this.corrLayer = div('pn-corrs')
    this.corrLayer.setAttribute('aria-hidden', 'true')
    this.content.append(this.loopLayer, this.segLayer, this.corrLayer)

    // Screen-px overlay riding with the page: cursor, loop handles and ✕ keep their size at any zoom.
    this.overlay = div('pn-page-over')
    this.cursorEl = div('pn-cursor')
    const bar = div('pn-cursor-bar')
    const grip = div('pn-cursor-grip')
    grip.setAttribute('data-testid', 'cursor-grip')
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
    // Without a handler (Study mode, U72) the button is never shown, so it is not in the DOM.
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
    for (const el of [this.startHandle, this.endHandle, this.clearBtn]) el.style.display = 'none'
    this.overlay.append(this.cursorEl, this.startHandle, this.endHandle, this.clearBtn)

    this.sheet.append(this.content, this.overlay)
    this.scroller.append(this.sheet)
    this.root.append(this.scroller)
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

    this.store = new PageSegmentStore(
      layout,
      this.segLayer,
      { attached: (seg) => this.onAttached(seg), detaching: (seg) => this.onDetaching(seg) },
      opts.cacheSegments ?? 4,
    )
    let ease = ''
    try {
      ease = getComputedStyle(host).getPropertyValue('--ease-standard').trim()
    } catch {
      // No computed style (tests): the token's value.
    }
    this.ease = ease || EASE_STANDARD

    this.bindEvents()
    this.measureHost()
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => {
        const width = this.hostW
        const height = this.hostH
        this.measureHost()
        // The observer's initial notification often repeats the size measured above. It must
        // not overwrite a respacing handoff's scroll anchor with a fresh follow request.
        if (width === this.hostW && height === this.hostH) return
        this.instant = true
        this.followRequest = 'instant'
        if (width !== this.hostW) this.followXRequest = true
        this.schedule()
      })
      this.resize.observe(this.root)
    }
    this.root.style.setProperty('--pn-label-px', `${layout.params.labelFontPx}px`)
    void loadLabelFont(doc, layout.params.labelFontPx)
    this.root.style.setProperty('--pn-zoom', String(this.scale))
    this.schedule()
  }

  // ---------------------------------------------------------------- public API (StripSink)

  /** Moves the cursor (see the module doc); `smooth: false` steps that keep advancing follow. */
  setCursor(position: number, opts: { smooth?: boolean } = {}): void {
    const instant = opts.smooth === false
    const prev = this.followPos
    const follow = instant && prev !== null && position >= prev - 1e-9 && position - prev <= FOLLOW_MAX_STEP
    this.followPos = instant ? position : null
    if (this.cursorDrag?.moved) {
      this.cursorDrag.restore = position
      return
    }
    if (follow !== this.following) {
      this.following = follow
      this.root.classList.toggle('pn-follow', follow)
    }
    if (position === this.cursorPos) return
    this.cursorPos = position
    this.cursor = this.geo.cursorAt(position)
    if (instant) this.instant = true
    // A seek (anything but continuous following) brings its system to the resting place.
    if (!follow) {
      this.followRequest = 'smooth'
      this.followXRequest = true
    }
    this.schedule()
  }

  /** A loop wrap: a seek to the loop start; the page scrolls there with the same ease. */
  wrapTo(position: number): void {
    this.followPos = position
    if (this.cursorDrag?.moved) {
      this.cursorDrag.restore = position
      return
    }
    this.cursorPos = position
    this.cursor = this.geo.cursorAt(position)
    this.instant = true
    this.followRequest = 'smooth'
    this.followXRequest = true
    this.schedule()
  }

  setCursorAction(visible: boolean): void {
    if (visible === this.cursorAction) return
    this.cursorAction = visible
    this.cursorEl.classList.toggle('pn-action-on', visible)
    if (visible) this.schedule()
    this.cursorBtn.toggleAttribute('inert', !visible)
  }

  setTargets(notes: readonly number[]): void {
    this.setFlag(TARGET, notes)
  }

  setAccepted(notes: readonly number[]): void {
    this.setFlag(ACCEPTED, notes)
  }

  setAutomatic(notes: readonly number[]): void {
    this.setFlag(AUTO, notes)
  }

  setPlaybackHighlights(notes: readonly number[]): void {
    this.setFlag(PLAY, notes)
  }

  setSubduedHand(hand: Hand | null): void {
    if (hand === this.subdued) return
    this.subdued = hand
    this.root.classList.toggle('pn-sub-L', hand === 'L')
    this.root.classList.toggle('pn-sub-R', hand === 'R')
  }

  setWrongMarker(on: boolean): void {
    if (on === this.wrongOn) return
    this.wrongOn = on
    this.schedule()
  }

  setEarlyMarker(on: boolean): void {
    if (on === this.earlyOn) return
    this.earlyOn = on
    this.schedule()
  }

  setCorrections(marks: readonly CorrectionMark[]): void {
    const key = correctionsKey(marks)
    if (key === this.corrKey) return
    this.corrKey = key
    this.pendingCorrections = marks
    this.schedule()
  }

  pulseWrong(): void {
    this.wrongOn = true
    this.schedule()
  }

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

  setLabels(texts: ReadonlyMap<number, string>): void {
    for (const n of this.noteText.keys()) if (!texts.has(n)) this.touchNoteLabel(n)
    for (const [n, t] of texts) if (this.noteText.get(n) !== t) this.touchNoteLabel(n)
    this.noteText.clear()
    for (const [n, t] of texts) if (t) this.noteText.set(n, t)
    this.schedule()
  }

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

  setLoop(range: LoopRange | null): void {
    const r = range ? clampRange(range, this.layout.occurrences.length) : null
    if (sameRange(r, this.loop)) return
    // A handle held meanwhile was editing the old loop: its drag ends without committing.
    this.endHandleDrag()
    this.loop = r
    this.schedule()
  }

  setSnapPositions(onsets: readonly Rational[]): void {
    if (onsets === this.snapSource) return
    this.endHandleDrag()
    this.snapSource = onsets
    this.cursorKnotCache.clear()
    this.loopKnotCache.clear()
    this.globalLoopKnots = buildLoopKnots(this.layout.occurrences, onsets)
    if (this.cursorDrag?.moved) this.cancelCursorDrag()
  }

  setCursorDraggable(enabled: boolean): void {
    if (enabled === this.cursorDraggable) return
    this.cursorDraggable = enabled
    this.cursorEl.classList.toggle('pn-cursor-draggable', enabled)
    this.cursorGrip.toggleAttribute('inert', !enabled)
    if (!enabled && this.cursorDrag) this.cancelCursorDrag()
  }

  setLoopEditable(editable: boolean): void {
    this.loopEditable = editable
    this.root.classList.toggle('pn-loop-locked', !editable)
    if (!editable) this.endHandleDrag()
    this.schedule()
  }

  setLoopSelectMode(mode: LoopSelectMode): void {
    if (mode === this.selectMode) return
    this.selectMode = mode
    this.tapAnchor = null
    this.opts.onLoopSelectModeChange?.(mode)
  }

  /** Manual scrolling (browsing) is possible while enabled. The owner pauses playback on browse. */
  setBrowseEnabled(enabled: boolean): void {
    this.browseEnabled = enabled
    this.root.classList.toggle('pn-browse-enabled', enabled)
    this.scroller.classList.toggle('pn-page-locked', !enabled)
    if (!enabled && this.browsing) this.returnToCurrent()
  }

  /**
   * Previews `scale` at once (the prepared page scaled) and reports it after the debounce: the
   * owner re-prepares the page at the new width (zoom in = fewer bars per system).
   */
  setZoom(scale: number): void {
    this.userZoom(scale)
  }

  zoom(): number {
    return this.scale
  }

  isBrowsing(): boolean {
    return this.browsing
  }

  /** Scrolling the page leaves its notation-anchored cursor at the current musical position. */
  browsedPosition(): Rational | null {
    return null
  }

  returnToCurrent(): void {
    if (!this.browsing) return
    this.browsing = false
    this.root.classList.remove('pn-browsing')
    this.followRequest = 'smooth'
    this.followXRequest = true
    this.opts.onBrowse?.(false)
    this.schedule()
  }

  /**
   * Bar under a viewport point. With one argument (the strip's contract) the point is on the
   * current system's line, or while browsing on the system at the resting line a quarter down
   * the viewport.
   */
  occAt(clientX: number, clientY?: number): number {
    const rect = this.sheet.getBoundingClientRect()
    const gx = this.gutter()
    const x = (clientX - rect.left - gx) / this.scale
    let y: number
    if (clientY !== undefined) y = (clientY - rect.top - PAGE_PAD_TOP) / this.scale + this.layout.top
    else if (this.browsing) {
      const sr = this.scroller.getBoundingClientRect()
      y =
        (sr.top + this.hostH * (this.opts.followOffset ?? 0.25) - rect.top - PAGE_PAD_TOP) / this.scale +
        this.layout.top
      y += 1
    } else {
      const span = this.geo.staffSpan(this.cursor.system)
      y = (span.top + span.bottom) / 2
    }
    return this.geo.occAtPoint(x, y)
  }

  /** Viewport x of the cursor (the screen reveals the chrome near it). */
  cursorClientX(): number {
    const rect = this.sheet.getBoundingClientRect()
    return rect.left + this.gutter() + this.cursor.x * this.scale
  }

  visibleLabels(): number[] {
    const out: number[] = []
    for (const id of this.visibleLabelIds) out.push(...this.layout.labels[id]!.notes)
    return out.sort((a, b) => a - b)
  }

  stats(): PageStats {
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

  /** The current system index (tests, diagnostics). */
  currentSystem(): number {
    return this.cursor.system
  }

  flushFrame(): void {
    if (!this.frame || this.destroyed) return
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.flush()
  }

  flushNow(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    const instant = this.instant
    this.flush()
    if (instant) void getComputedStyle(this.cursorEl).transform
  }

  // ---------------------------------------------------------------- respacing (R3 revised)

  /** A replacement waits for an active glide instead of snapping its slices to their end. */
  whenRespaced(): Promise<void> {
    return this.respace?.finished ?? Promise.resolve()
  }

  /** See `StripView.respaceSnapshot`. A follow glide is captured at its visible frame. */
  respaceSnapshot(next: PreparedLayout): RespaceSnapshot | null {
    if (this.destroyed || this.browsing || this.handleDrag || this.cursorDrag?.moved) return null
    if (this.reducedMotion || !(this.hostW > 0) || !(this.hostH > 0)) return null
    this.respace?.cancel()
    return {
      layout: this.layout,
      frame: this.screenFrame(),
      pieces: wider(this.layout, next) === 'prev' ? collectPieces(this.store.mounted.values()) : null,
    }
  }

  /**
   * Scrolls so the cursor's line sits where `prev` drew it, then glides the notes from their old
   * places (other lines included) to their places here. Labels fade in after.
   */
  respaceFrom(prev: RespaceSnapshot | null): void {
    if (!prev || this.destroyed || this.reducedMotion || !(this.hostH > 0)) return
    this.flushNow()
    const L = this.layout
    const s = this.scale
    const occ = Math.max(0, occAtPosition(L.occurrences, this.cursorPos))
    const prevGeo = new PageGeometry(prev.layout)
    const wasX = prev.frame.dx + prevGeo.cursorAt(this.cursorPos).x * prev.frame.scale
    const x = this.clampScrollX(this.gutter() + this.cursor.x * s - wasX)
    const was = prev.frame.dy + lineOf(prev.layout, occ).top * prev.frame.scale
    const y = PAGE_PAD_TOP + (lineOf(L, occ).top - L.top) * s - was
    // Attaching at the current position may have started this new view's own follow glide.
    // The old view's visible position owns this handoff, even when its target scroll is equal.
    this.glideAnim?.cancel()
    this.glideAnim = null
    this.glide = null
    this.scrollTo(Math.max(0, Math.min(this.sheetHeight() - this.hostH, y)), false, x)
    this.followRequest = null
    this.followXRequest = false
    this.flushNow()
    // Everything the glide may show is cut now: mount the page ± one viewport at once.
    const toY = (sy: number): number => (sy - PAGE_PAD_TOP) / s + L.top
    const over = this.hostH / s
    const vy0 = toY(this.scrollY)
    const vy1 = toY(this.scrollY + this.hostH)
    const wanted = this.store.wanted(vy0 - over, vy1 + over, (vy0 + vy1) / 2)
    this.store.sync(wanted, new Set(wanted), 0)
    this.applyNotes()
    this.root.classList.add('pn-respacing')
    const systemOf = (layout: PreparedLayout) => (o: number) => layout.occurrences[o]?.system ?? -1
    const nextFrame = this.screenFrame()
    this.cursorRespace = { geo: prevGeo, prev: prev.frame, next: nextFrame }
    this.respace = startRespace({
      prev,
      next: { layout: L, frame: nextFrame },
      nextPieces: () => collectPieces(this.store.mounted.values()),
      segmentOf: { prev: systemOf(prev.layout), next: systemOf(L) },
      parent: this.root,
      before: this.scroller.nextElementSibling,
      width: this.hostW,
      height: this.hostH,
      easing: this.ease,
      onDone: () => {
        this.respace = null
        this.cursorRespace = null
        if (!this.destroyed) {
          this.applyCursor(this.applied.gx)
          this.root.classList.remove('pn-respacing')
        }
      },
    })
    if (!this.respace) {
      this.cursorRespace = null
      this.root.classList.remove('pn-respacing')
    } else {
      // Place the new cursor at the old layout's visible musical position before the first paint.
      this.applyCursor(this.applied.gx)
      this.schedule()
    }
  }

  /** See `StripView.holdLabels`. */
  holdLabels(on: boolean): void {
    this.root.classList.toggle('pn-labels-held', on)
  }

  /** Layout px → root px as last applied (the scroller fills the root). */
  private screenFrame(): ScreenFrame {
    const s = this.scale
    // A follow scroll sets scrollY to its destination immediately, then the sheet's compositor
    // animation carries the visible music there. Keep respacing on that visible frame too.
    const progress = this.glideAnim?.effect?.getComputedTiming().progress
    const remaining = progress == null ? 0 : 1 - progress
    const offset = this.glide ? (this.glide.to - this.glide.from) * remaining : 0
    const offsetX = this.glide ? (this.glide.toX - this.glide.fromX) * remaining : 0
    return {
      scale: s,
      dx: this.applied.gx - this.scrollX + offsetX,
      dy: PAGE_PAD_TOP - this.layout.top * s - this.scrollY + offset,
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stopHandleScroll()
    this.stopCursorScroll()
    this.respace?.cancel()
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.corrLeaveTimer) clearTimeout(this.corrLeaveTimer)
    if (this.zoomTimer) clearTimeout(this.zoomTimer)
    this.glideAnim?.cancel()
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

  private clampZoom(s: number): number {
    const min = this.opts.minZoom ?? 0.5
    const max = this.opts.maxZoom ?? 2.5
    return Math.max(min, Math.min(max, Number.isFinite(s) && s > 0 ? s : 1))
  }

  /** The scale shown for a requested zoom: capped to the host's width with `fitWidth` (R17). */
  private fitted(zoom: number): number {
    if (!this.opts.fitWidth || !(this.hostW > 0) || !(this.layout.width > 0)) return zoom
    return Math.min(zoom, Math.max(0.05, (this.hostW - 2 * PAGE_GUTTER) / this.layout.width))
  }

  /**
   * A zoom the user (or the owner) asked for: remembered, shown fitted, and reported after the
   * debounce so the owner re-prepares the page at the width that zoom means. A request beyond
   * the fit changes nothing on screen until that narrower page arrives, so it is still reported.
   */
  private userZoom(scale: number): void {
    const z = this.clampZoom(scale)
    const shown = this.fitted(z)
    const changed = z !== this.requestedZoom || shown !== this.scale
    this.requestedZoom = z
    this.applyZoom(shown)
    if (!changed || !this.opts.onZoomChange) return
    if (this.zoomTimer) clearTimeout(this.zoomTimer)
    this.zoomTimer = setTimeout(() => {
      this.zoomTimer = null
      if (!this.destroyed) this.opts.onZoomChange?.(this.requestedZoom)
    }, this.opts.zoomDebounceMs ?? 250)
  }

  private applyZoom(scale: number): void {
    if (scale === this.scale) return
    this.scale = scale
    this.instant = true
    this.followRequest = this.browsing ? null : 'instant'
    this.followXRequest = !this.browsing
    this.root.style.setProperty('--pn-zoom', String(scale))
    this.schedule()
  }

  /** Measures the host and re-fits the shown scale from the requested zoom (`fitWidth`). */
  private measureHost(): void {
    const r = this.root.getBoundingClientRect()
    this.hostW = r.width || this.root.clientWidth || 0
    this.hostH = r.height || this.root.clientHeight || 0
    this.applyZoom(this.fitted(this.requestedZoom))
  }

  /** Left gutter (screen px): the page centered, at least `PAGE_GUTTER` when it fits. */
  private gutter(): number {
    const free = this.hostW - this.layout.width * this.scale
    return Math.max(Math.min(PAGE_GUTTER, free / 2), free / 2, 0)
  }

  private sheetWidth(): number {
    return Math.max(this.hostW, Math.ceil(this.layout.width * this.scale))
  }

  private clampScrollX(x: number): number {
    return Math.max(0, Math.min(this.sheetWidth() - this.hostW, x))
  }

  /** Keep read-ahead room while following. A seek or a new line starts near the left third. */
  private followScrollX(reset: boolean): number {
    const x = this.gutter() + this.cursor.x * this.scale
    if (reset) return this.clampScrollX(x - this.hostW / 3)
    const left = Math.min(96, this.hostW * 0.2)
    const right = (this.hostW * 2) / 3
    return this.clampScrollX(Math.max(x - right, Math.min(this.scrollX, x - left)))
  }

  private sheetHeight(): number {
    return Math.ceil(PAGE_PAD_TOP + this.layout.height * this.scale + Math.max(PAGE_PAD_TOP, this.hostH * 0.5))
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
    const s = this.scale
    const gx = this.gutter()
    const sheetW = this.sheetWidth()
    if (sheetW !== this.applied.sheetW) {
      this.sheet.style.width = `${sheetW}px`
      this.applied.sheetW = sheetW
    }
    this.root.classList.toggle('pn-page-wide', sheetW > this.hostW)
    const sheetH = this.sheetHeight()
    if (sheetH !== this.applied.sheetH) {
      this.sheet.style.height = `${sheetH}px`
      this.applied.sheetH = sheetH
    }
    const transform = `translate3d(${r2(gx)}px, ${PAGE_PAD_TOP}px, 0) scale(${s})`
    if (transform !== this.applied.transform) {
      this.content.style.transform = transform
      this.applied.transform = transform
    }
    this.applied.gx = gx

    // Follow: bring the current system to its resting place (never during a line).
    const system = this.cursor.system
    const changed = system !== this.lastSystem
    const request = this.followRequest
    const requestX = this.followXRequest
    this.followRequest = null
    this.followXRequest = false
    const instantCursor = this.instant || changed || this.following
    this.root.classList.toggle('pn-instant', instantCursor)
    this.instant = false
    this.panTo(this.clampScrollX(this.scrollX))
    if ((changed || request) && !this.browsing && !this.handleDrag && !this.cursorDrag?.moved) {
      const target = this.geo.followScroll(system, {
        scale: s,
        padTop: PAGE_PAD_TOP,
        viewport: this.hostH,
        max: sheetH - this.hostH,
        offset: this.opts.followOffset ?? 0.25,
      })
      const animate = this.lastSystem >= 0 && request !== 'instant' && !this.reducedMotion
      const targetX = changed || requestX ? this.followScrollX(true) : this.scrollX
      // The cursor already belongs to the next system. Panning from the previous system's
      // right edge would carry that new cursor offscreen, so only the vertical axis glides.
      this.scrollTo(target, animate, targetX, !changed)
    } else if (
      this.cursorPos !== this.applied.position &&
      !this.browsing &&
      !this.handleDrag &&
      !this.cursorDrag?.moved
    ) {
      // Per-frame playback advances the scroll directly, alongside the cursor, without a
      // delayed animation that would trail it. An existing vertical glide remains intact.
      this.panTo(this.followScrollX(false))
    }
    this.applied.position = this.cursorPos
    this.lastSystem = system

    // Mounting: the visible range (and, while gliding, where the glide started) ± one viewport.
    const toY = (sy: number): number => (sy - PAGE_PAD_TOP) / s + L.top
    let vy0 = toY(this.scrollY)
    let vy1 = toY(this.scrollY + this.hostH)
    const glide = this.glide && performance.now() < this.glide.until ? this.glide : null
    if (glide) {
      vy0 = Math.min(vy0, toY(glide.from))
      vy1 = Math.max(vy1, toY(glide.from + this.hostH))
      this.schedule()
    } else this.glide = null
    this.respace?.follow(this.screenFrame())
    const over = (this.opts.overscan ?? 1) * (this.hostH / s)
    const focus = (vy0 + vy1) / 2
    const required = new Set(this.store.wanted(vy0, vy1, focus))
    const wanted = this.store.wanted(vy0 - over, vy1 + over, focus)
    const done = this.store.sync(wanted, required, this.opts.mountBudget ?? 1)

    this.applyNotes()
    this.applyLabels()
    this.applyCursor(gx)
    this.cursorEl.classList.toggle('pn-cursor-wrong', this.wrongOn)
    this.cursorEl.classList.toggle('pn-cursor-early', this.earlyOn)
    this.applyLoop(gx)
    if (this.pendingCorrections) this.applyCorrections()
    const visY0 = toY(this.scrollY)
    const visY1 = toY(this.scrollY + this.hostH)
    this.applyOttava(gx, visY0, visY1)
    this.reportVisibleLabels()
    this.labelsChanged = false
    if (!done || this.respace) this.schedule()
  }

  /** Writes horizontal following without restarting an active system-scroll animation. */
  private panTo(x: number): void {
    if (x === this.scrollX) return
    this.writtenX = x
    this.scrollX = x
    this.scroller.scrollLeft = x
  }

  /** Scrolls the page in both axes, animated as a FLIP glide of the sheet. */
  private scrollTo(y: number, animate: boolean, x = this.scrollX, animateX = true): void {
    if (Math.abs(y - this.scrollY) < 1 && Math.abs(x - this.scrollX) < 1) return
    const frame = this.screenFrame()
    const from = PAGE_PAD_TOP - this.layout.top * this.scale - frame.dy
    const fromX = animateX ? this.applied.gx - frame.dx : x
    this.panTo(x)
    this.writtenY = y
    this.scrollY = y
    this.scroller.scrollTop = y
    this.glideAnim?.cancel()
    this.glideAnim = null
    if (!animate || typeof this.sheet.animate !== 'function') {
      this.glide = null
      return
    }
    this.glide = { from, to: y, fromX, toX: x, until: performance.now() + SCROLL_MS + 40 }
    this.glideAnim = this.sheet.animate(
      [{ transform: `translate3d(${r2(x - fromX)}px, ${r2(y - from)}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: SCROLL_MS, easing: this.ease },
    )
    // A canceled glide rejects `finished`; nothing waits for it.
    this.glideAnim.finished?.catch(() => undefined)
  }

  /**
   * Cursor bar on the current system, at the position's x: a plain bar over the staves plus a
   * small margin at each end that never reaches a neighboring system (`cursorMargins`, U73).
   */
  private applyCursor(gx: number): void {
    const L = this.layout
    const s = this.scale
    const span = this.geo.staffSpan(this.cursor.system)
    const margin = this.geo.cursorMargins(this.cursor.system, s)
    let sx = gx + this.cursor.x * s
    let sy = PAGE_PAD_TOP + (span.top - L.top) * s - margin.top
    let h = (span.bottom - span.top) * s + margin.top + margin.bottom
    const handoff = this.cursorRespace
    if (handoff && this.respace) {
      const frame = this.screenFrame()
      const oldCursor = handoff.geo.cursorAt(this.cursorPos)
      const oldSpan = handoff.geo.staffSpan(oldCursor.system)
      const k = frame.scale / handoff.next.scale
      const dx = frame.dx - handoff.next.dx * k
      const dy = frame.dy - handoff.next.dy * k
      const p = this.respace.progress()
      const mix = (from: number, to: number) => from + (to - from) * p
      const oldY = (y: number) => (handoff.prev.dy + y * handoff.prev.scale) * k + dy
      const top = mix(oldY(oldSpan.top), frame.dy + span.top * s)
      const bottom = mix(oldY(oldSpan.bottom), frame.dy + span.bottom * s)
      sx =
        mix((handoff.prev.dx + oldCursor.x * handoff.prev.scale) * k + dx, frame.dx + this.cursor.x * s) - frame.dx + gx
      // The cursor rides the sheet, whereas the notation's glide is in viewport coordinates.
      sy = top - (frame.dy - PAGE_PAD_TOP + L.top * s) - margin.top
      h = bottom - top + margin.top + margin.bottom
    }
    sx = r2(sx)
    sy = r2(sy)
    h = r2(h)
    const t = `translate3d(${sx}px, ${sy}px, 0)`
    if (t !== this.applied.cursor) {
      this.cursorEl.style.transform = t
      this.applied.cursor = t
    }
    if (h !== this.applied.cursorH) {
      this.cursorEl.style.height = `${h}px`
      this.applied.cursorH = h
    }
    this.placeActionButton(span.top, h, margin.top)
  }

  /**
   * The cursor's button sits dead center in the gap between the current system's staves (U14
   * addendum, user); without a gap (one staff), at the cursor bar's middle. Only while it shows.
   * `spanTop`: the system's top staff (layout px); `h`: the cursor element's height (px);
   * `marginTop`: how far the element starts above that staff (px).
   */
  private placeActionButton(spanTop: number, h: number, marginTop: number): void {
    if (!this.cursorAction) return
    const sys = this.geo.systems[this.cursor.system]
    if (!sys) return
    const gap = staffGap(sys.staves)
    const c = gap ? ((gap.top + gap.bottom) / 2 - spanTop) * this.scale + marginTop : h / 2
    const top = r2(c - ACTION_RADIUS)
    if (top === this.applied.actionTop) return
    this.cursorBtn.style.top = `${top}px`
    this.applied.actionTop = top
  }

  private applyNotes(): void {
    if (!this.dirtyNotes.size) return
    for (const n of this.dirtyNotes) {
      const g = this.layout.notes[n]
      const seg = g ? this.store.mounted.get(this.store.segmentOfOcc(g.occ)) : undefined
      if (seg) this.paintNote(seg, n)
    }
    this.dirtyNotes.clear()
  }

  // COPIED from StripView.paintNote (same classes and halo geometry).
  private paintNote(seg: MountedSegment, n: number): void {
    const f = this.flags[n]!
    const head = seg.heads.get(n)
    if (head) for (const [bit, cls] of FLAG_CLASSES) head.classList.toggle(cls, (f & bit) !== 0)
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
    for (const [s, els] of seg.ottava) {
      const on = this.ottavaSpans.includes(s)
      els.forEach((el) => el.classList.toggle('pn-ott-on', on))
    }
    for (let id = seg.data.labelStart; id < seg.data.labelEnd; id++) this.paintLabel(seg, id)
    this.labelsChanged = true
  }

  private onDetaching(seg: MountedSegment): void {
    for (const n of seg.heads.keys()) {
      const m = this.marks.get(n)
      if (m) {
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

  // ---------------------------------------------------------------- labels (COPIED from StripView)

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

  /** Labels intersecting the viewport count as seen (assistance tracking). */
  private reportVisibleLabels(): void {
    const frame = this.screenFrame()
    const key = `${frame.scale}|${frame.dx}|${frame.dy}|${this.hostW}|${this.hostH}`
    if (!this.labelsChanged && key === this.reportedAt) return
    this.reportedAt = key
    const x0 = -frame.dx / this.scale
    const x1 = (this.hostW - frame.dx) / this.scale
    const y0 = -frame.dy / this.scale
    const y1 = (this.hostH - frame.dy) / this.scale
    const next = new Set<number>()
    for (const seg of this.store.mounted.values()) {
      if ((seg.data.y1 ?? 0) < y0 || (seg.data.y0 ?? 0) > y1) continue
      for (let id = seg.data.labelStart; id < seg.data.labelEnd; id++) {
        const node = this.labelNodes.get(id)
        if (!node || node.opacity <= 0) continue
        const b = this.layout.labels[id]!.box
        if (b.y + b.h > y0 && b.y < y1 && b.x + b.w > x0 && b.x < x1) next.add(id)
      }
    }
    const added: number[] = []
    for (const id of next) if (!this.visibleLabelIds.has(id)) added.push(...this.layout.labels[id]!.notes)
    this.visibleLabelIds = next
    if (added.length) this.opts.onVisibleLabels?.(added.sort((a, b) => a - b))
  }
  private reportedAt = ''

  // ---------------------------------------------------------------- overlays

  /** Emphasized ottava brackets; a bracket label out of view gets a reminder at the cursor. */
  private applyOttava(gx: number, y0: number, y1: number): void {
    const L = this.layout
    const doc = this.root.ownerDocument
    const active = new Set(this.ottavaSpans)
    for (const [s, el] of this.ottavaBoxes) if (!active.has(s)) el.classList.remove('pn-on')
    let remind = ''
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
        this.content.append(box)
        this.ottavaBoxes.set(s, box)
        void box.offsetWidth
      }
      box.classList.add('pn-on')
      const lb = g.labelBox
      const left = gx + lb.x * this.scale - this.scrollX
      if (!remind && (lb.y < y0 || lb.y + lb.h > y1 || left < 0 || left + lb.w * this.scale > this.hostW)) {
        remind = g.text
      }
    }
    let el = this.reminders.get(0)
    if (!remind) {
      el?.classList.remove('pn-on')
      return
    }
    if (!el) {
      el = doc.createElement('div')
      el.className = 'pn-ott-rem'
      el.setAttribute('role', 'status')
      const pill = doc.createElement('div')
      pill.className = 'pn-ott-rem-pill'
      el.append(pill)
      this.overlay.append(el)
      this.reminders.set(0, el)
      void el.offsetWidth
    }
    const pill = el.firstElementChild as HTMLDivElement
    if (pill.textContent !== remind) pill.textContent = remind
    const span = this.geo.staffSpan(this.cursor.system)
    const x = gx + this.cursor.x * this.scale + 18
    const y = PAGE_PAD_TOP + (span.top - L.top) * this.scale - 22
    el.style.transform = `translate(${r2(x)}px, ${r2(y)}px) translateY(-50%)`
    el.classList.add('pn-on')
  }

  /** One band per system the passage crosses; handles at its two edges, ✕ on its first band. */
  private applyLoop(gx: number): void {
    const L = this.layout
    const r = this.handleDrag?.range ?? this.loop
    const show = !!r && this.loopEditable
    const last = this.loopShown
    if (last.r === r && last.show === show && last.scale === this.scale) return
    const entering = !last.r && !!r
    this.loopShown = { r, show, scale: this.scale }
    const bands: Band[] = r ? this.geo.loopBands(r) : []
    const doc = this.root.ownerDocument
    while (this.bandEls.length < bands.length) {
      const el = doc.createElement('div')
      el.className = 'pn-loop'
      this.loopLayer.append(el)
      this.bandEls.push(el)
    }
    this.bandEls.forEach((el, i) => {
      const b = bands[i]
      el.classList.toggle('pn-on', !!b)
      if (!b) return
      const sys = this.geo.systems[b.system]!
      el.style.left = `${r2(b.x0)}px`
      el.style.width = `${r2(b.x1 - b.x0)}px`
      el.style.top = `${r2(sys.y0 - L.top)}px`
      el.style.height = `${r2(sys.y1 - sys.y0)}px`
      el.dataset['system'] = String(b.system)
      if (entering && !this.reducedMotion) {
        el.classList.remove('pn-loop-enter')
        void el.offsetWidth
        el.classList.add('pn-loop-enter')
      }
    })
    const ctls = [this.startHandle, this.endHandle, this.clearBtn]
    const first = bands[0]
    const lastBand = bands[bands.length - 1]
    if (!show || !first || !lastBand) {
      for (const el of ctls) el.style.display = 'none'
      return
    }
    for (const el of ctls) el.style.display = ''
    const s = this.scale
    const midY = (k: number): number => {
      const span = this.geo.staffSpan(k)
      return PAGE_PAD_TOP + ((span.top + span.bottom) / 2 - L.top) * s
    }
    this.place(this.startHandle, gx + first.x0 * s, midY(first.system))
    this.place(this.endHandle, gx + lastBand.x1 * s, midY(lastBand.system))
    this.place(this.clearBtn, gx + ((first.x0 + first.x1) / 2) * s, midY(first.system))
    this.clearBtn.classList.toggle('pn-loop-clear-small', (first.x1 - first.x0) * s < CLEAR_SMALL_PX)
  }

  private place(el: HTMLElement, x: number, y: number): void {
    el.style.left = `${r2(x)}px`
    el.style.top = `${r2(y)}px`
  }

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
    // Rings, labels in a band beyond each system's staves, links and "Ped.": the strip's U39 rules.
    layoutCorrections(this.layout, marks, measurer).forEach((shape, i) => {
      const delay = !this.reducedMotion && i > 0 ? i * CORRECTION_STAGGER_MS : 0
      this.corrLayer.append(buildCorrection(doc, shape, this.layout.top, delay))
    })
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
    this.on(this.scroller, 'scroll', () => this.onScroll(), { passive: true })
    this.on(this.scroller, 'pointerdown', (e) => this.pointerDown(e))
    this.on(this.scroller, 'pointermove', (e) => this.pointerMove(e))
    this.on(this.scroller, 'pointerup', (e) => this.pointerUp(e))
    this.on(this.scroller, 'pointercancel', (e) => this.pointerUp(e, true))
    this.on(this.scroller, 'wheel', (e) => this.wheel(e), { passive: false })
    for (const [el, which] of [
      [this.startHandle, 'start'],
      [this.endHandle, 'end'],
    ] as const) {
      this.on(el, 'pointerdown', (e) => this.handleDown(e, which))
      this.on(el, 'pointermove', (e) => this.handleMove(e))
      this.on(el, 'pointerup', (e) => this.handleUp(e))
      this.on(el, 'pointercancel', (e) => this.handleUp(e, true))
      this.on(el, 'lostpointercapture', (e) => this.handleUp(e, true))
      this.on(el, 'keydown', (e) => this.handleKey(e, which))
    }
    this.on(this.cursorGrip, 'keydown', (e) => this.cursorKey(e))
    this.on(this.cursorBtn, 'pointerdown', (e) => e.stopPropagation())
    this.on(this.cursorBtn, 'click', (e) => {
      e.stopPropagation()
      if (this.cursorAction) this.opts.onCursorAction?.()
    })
    this.on(this.corrLayer, 'animationend', (e) => {
      const el = e.target as Element | null
      if (el?.parentNode === this.corrLayer && el.classList.contains('pn-corr-leave')) el.remove()
    })
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

  /** A scroll this view did not write is the learner browsing (when allowed). */
  private onScroll(): void {
    const y = this.scroller.scrollTop
    const x = this.scroller.scrollLeft
    this.scrollY = y
    this.scrollX = x
    if (Math.abs(y - this.writtenY) > 2 || Math.abs(x - this.writtenX) > 2) {
      this.writtenY = y
      this.writtenX = x
      this.beginBrowse()
    }
    this.schedule()
  }

  private beginBrowse(): void {
    if (!this.browseEnabled || this.browsing) return
    this.browsing = true
    this.root.classList.add('pn-browsing')
    this.opts.onBrowse?.(true)
  }

  private pointerDown(e: PointerEvent): void {
    if ((e.target as Element).closest?.('button')) return
    if (this.cursorDrag) return
    const onGrip =
      this.cursorDraggable && this.pointers.size === 0 && !!(e.target as Element).closest?.('.pn-cursor-grip')
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (onGrip) {
      try {
        this.scroller.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic events in tests have no active pointer.
      }
      const system = this.cursor.system
      if (this.sheetWidth() > this.hostW) this.freezeScroll()
      this.cursorDrag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: this.sheet.getBoundingClientRect().left + this.gutter(),
        moved: false,
        knot: -1,
        system,
        knots: this.cursorKnotsOf(system),
        restore: this.cursorPos,
        clientX: e.clientX,
        viewLeft: this.root.getBoundingClientRect().left,
        scrollX: this.scrollX,
      }
      return
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: this.scale }
      this.gesture = null
      return
    }
    if (this.pointers.size === 1) {
      const mouse = e.pointerType === 'mouse' && this.sheetWidth() > this.hostW
      this.gesture = { startX: e.clientX, startY: e.clientY, scrollX: this.scrollX, mouse, moved: false }
      if (mouse) {
        try {
          this.scroller.setPointerCapture(e.pointerId)
        } catch {
          /* Synthetic pointer. */
        }
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
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= TAP_SLOP) return
        d.moved = true
        this.root.classList.add('pn-cursor-dragging')
      }
      d.clientX = e.clientX
      this.dragCursorTo(e.clientX)
      this.updateCursorScroll()
      return
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
      this.userZoom((this.pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / this.pinch.dist)
      return
    }
    const g = this.gesture
    if (g && !g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TAP_SLOP) g.moved = true
    if (g?.mouse && g.moved && this.browseEnabled) {
      const x = this.clampScrollX(g.scrollX + g.startX - e.clientX)
      if (x !== this.scrollX) {
        this.beginBrowse()
        this.panTo(x)
        this.schedule()
      }
    }
  }

  private pointerUp(e: PointerEvent, canceled = false): void {
    const d = this.cursorDrag
    if (d && d.pointerId === e.pointerId) {
      this.pointers.delete(e.pointerId)
      this.endCursorDrag(e.clientX, e.clientY, canceled)
      return
    }
    if (!this.pointers.delete(e.pointerId)) return
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null
      return
    }
    const g = this.gesture
    this.gesture = null
    if (!g || g.moved || canceled) return
    this.tap(e.clientX, e.clientY)
  }

  private cursorKnotsOf(system: number): CursorKnots {
    let k = this.cursorKnotCache.get(system)
    if (!k) {
      k = this.geo.cursorKnots(system, this.snapSource ?? [])
      this.cursorKnotCache.set(system, k)
    }
    return k
  }

  private loopKnotsOf(system: number): LoopKnots {
    let k = this.loopKnotCache.get(system)
    if (!k) {
      k = this.geo.loopKnots(system, this.snapSource)
      this.loopKnotCache.set(system, k)
    }
    return k
  }

  /** Scrubs the playhead along its own system (crossing systems is not supported). */
  private dragCursorTo(clientX: number): void {
    const d = this.cursorDrag
    if (!d || d.knots.pos.length === 0) return
    const x = (clientX - d.left + this.scrollX - d.scrollX) / this.scale
    const k = nearestKnot(d.knots.x, x)
    if (k === d.knot) return
    d.knot = k
    this.cursor = { system: d.system, x: d.knots.x[k]! }
    const text = this.opts.cursorDragLabel?.(d.knots.exact[k]!) ?? ''
    if (this.readoutEl.textContent !== text) this.readoutEl.textContent = text
    this.instant = true
    this.schedule()
  }

  /** A held playhead reaches offscreen notes on its current system without changing its size. */
  private updateCursorScroll(): void {
    const d = this.cursorDrag
    if (!d?.moved || this.sheetWidth() <= this.hostW) {
      this.stopCursorScroll()
      return
    }
    const x = d.clientX - d.viewLeft
    const depth =
      x < HANDLE_SCROLL_ZONE
        ? -(HANDLE_SCROLL_ZONE - Math.max(0, x)) / HANDLE_SCROLL_ZONE
        : x > this.hostW - HANDLE_SCROLL_ZONE
          ? (HANDLE_SCROLL_ZONE - Math.max(0, this.hostW - x)) / HANDLE_SCROLL_ZONE
          : 0
    this.cursorScrollSpeed = depth * HANDLE_SCROLL_SPEED
    if (!depth) this.stopCursorScroll()
    else if (!this.cursorScrollFrame) this.cursorScrollFrame = requestAnimationFrame(this.cursorScrollTick)
  }

  private readonly cursorScrollTick = (now: number): void => {
    this.cursorScrollFrame = 0
    const d = this.cursorDrag
    if (!d || this.destroyed || !this.cursorScrollSpeed) return
    const ms = this.cursorScrollAt ? Math.min(32, now - this.cursorScrollAt) : 16
    this.cursorScrollAt = now
    const x = this.clampScrollX(this.scrollX + (this.cursorScrollSpeed * ms) / 1000)
    if (x === this.scrollX) return
    this.panTo(x)
    this.dragCursorTo(d.clientX)
    this.flushNow()
    this.cursorScrollFrame = requestAnimationFrame(this.cursorScrollTick)
  }

  private stopCursorScroll(): void {
    if (this.cursorScrollFrame) cancelAnimationFrame(this.cursorScrollFrame)
    this.cursorScrollFrame = 0
    this.cursorScrollAt = 0
    this.cursorScrollSpeed = 0
  }

  private endCursorDrag(clientX: number, clientY: number, canceled: boolean): void {
    const d = this.cursorDrag
    if (!d) return
    this.cursorDrag = null
    this.stopCursorScroll()
    this.root.classList.remove('pn-cursor-dragging')
    if (!d.moved) {
      if (!canceled) this.tap(clientX, clientY)
      return
    }
    const exact = d.knot >= 0 ? d.knots.exact[d.knot] : undefined
    const seek = this.opts.onCursorSeek
    if (canceled || !exact || !seek || seek(exact) === false) {
      this.cursorPos = d.restore
      this.cursor = this.geo.cursorAt(d.restore)
      this.panTo(this.clampScrollX(d.scrollX))
    } else {
      this.cursorPos = toNumber(exact)
      this.cursor = this.geo.cursorAt(this.cursorPos)
      this.returnToCurrent()
    }
    this.schedule()
  }

  private cancelCursorDrag(): void {
    const d = this.cursorDrag
    if (!d) return
    this.pointers.delete(d.pointerId)
    this.endCursorDrag(d.startX, d.startY, true)
  }

  private tap(clientX: number, clientY: number): void {
    const occ = this.occAt(clientX, clientY)
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
    // A tap is a seek the learner chose, often on a system found by scrolling: browsing ends
    // and the page brings that system to its resting place.
    if (this.browsing) {
      this.browsing = false
      this.root.classList.remove('pn-browsing')
      this.followRequest = 'smooth'
      this.followXRequest = true
      this.opts.onBrowse?.(false)
      this.schedule()
    }
    this.opts.onSeekRequest?.(occ)
  }

  private wheel(e: WheelEvent): void {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      this.userZoom(this.scale * Math.exp(-e.deltaY * 0.004))
    }
  }

  // COPIED from StripView.withEdge.
  private withEdge(loop: LoopRange, which: 'start' | 'end', K: LoopKnots, k: number): LoopRange {
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

  /** Freeze a follow glide at its visible position before starting a direct-manipulation drag. */
  private freezeScroll(): void {
    if (!this.glideAnim) return
    const rect = this.root.getBoundingClientRect()
    const sheetRect = this.sheet.getBoundingClientRect()
    const visibleY = rect.top - sheetRect.top
    const visibleX = this.clampScrollX(rect.left - sheetRect.left)
    this.scrollTo(Math.max(0, Math.min(this.sheetHeight() - this.hostH, visibleY)), false, visibleX)
    this.glideAnim?.cancel()
    this.glideAnim = null
    this.glide = null
  }

  /** Capture a handle while keeping the other edge fixed in the whole piece's snap limits. */
  private handleDown(e: PointerEvent, which: 'start' | 'end'): void {
    e.stopPropagation()
    if (!this.loop || !this.loopEditable || this.handleDrag) return
    const { start, end } = passagePositions(this.layout.occurrences, this.loop)
    const system = this.geo.systemOfOcc[which === 'start' ? this.loop.fromOcc : this.loop.toOcc] ?? 0
    const limits = edgeLimits(this.globalLoopKnots, which, which === 'start' ? end : start)
    if (!limits) return
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events in tests have no active pointer.
    }
    ;(e.currentTarget as HTMLElement).classList.add('pn-grab')
    const rect = this.root.getBoundingClientRect()
    this.freezeScroll()
    this.handleDrag = {
      pointerId: e.pointerId,
      which,
      range: this.loop,
      system,
      knot: knotAtPosition(this.globalLoopKnots.pos, which === 'start' ? start : end),
      ...limits,
      left: rect.left,
      top: rect.top,
      width: rect.width || this.hostW,
      height: rect.height || this.hostH,
      startX: e.clientX,
      clientX: e.clientX,
      clientY: e.clientY,
      wrappedSystem: null,
      wrappedY: e.clientY,
      edge: 0,
      scrolled: false,
    }
  }

  private handleMove(e: PointerEvent): void {
    const d = this.handleDrag
    if (!d || e.pointerId !== d.pointerId || !this.loop) return
    e.stopPropagation()
    d.clientX = e.clientX
    d.clientY = e.clientY
    this.dragHandleTo(true)
    this.updateHandleScroll()
  }

  /** Pick a system vertically, then its nearest knot, constrained by the other loop edge. */
  private dragHandleTo(allowWrap = false): void {
    const d = this.handleDrag
    if (!d || !this.loop) return
    if (d.wrappedSystem !== null && Math.abs(d.clientY - d.wrappedY) > TAP_SLOP) d.wrappedSystem = null
    const y = (d.clientY - d.top + this.scrollY - PAGE_PAD_TOP) / this.scale + this.layout.top
    let system = d.wrappedSystem ?? this.geo.systemAtY(y)
    let knots = this.loopKnotsOf(system)
    const x = (d.clientX - d.left + this.scrollX - this.gutter()) / this.scale
    const first = knots.x[0] ?? 0
    const last = knots.x[knots.x.length - 1] ?? first
    // Reach the page edge even when the handle's outer half is clipped by the viewport.
    const origin = d.left + this.gutter() - this.scrollX
    const atLeft = d.clientX <= origin + first * this.scale - TAP_SLOP || (this.scrollX <= 1 && d.clientX <= d.left + 4)
    const atRight =
      d.clientX >= origin + last * this.scale + TAP_SLOP ||
      (this.scrollX >= this.clampScrollX(Infinity) - 1 && d.clientX >= d.left + d.width - 4)
    const edge = atLeft ? -1 : atRight ? 1 : 0
    if (!edge) d.edge = 0
    // A diagonal move onto another line selects that line first; it must re-enter the page
    // before a horizontal edge gesture can wrap again.
    const crossedVertically = d.wrappedSystem === null && system !== d.system
    if (crossedVertically) d.edge = edge
    const direction = Math.sign(d.clientX - d.startX)
    const wrap = allowWrap && !crossedVertically && edge && edge !== d.edge && direction === edge
    const fromSystem = system
    let didWrap = false
    let local: number
    if (wrap && system + edge >= 0 && system + edge < this.geo.systems.length) {
      system += edge
      knots = this.loopKnotsOf(system)
      // End edges are exclusive: move at least one knot into the new line.
      local = edge > 0 ? (d.which === 'end' ? 1 : 0) : knots.pos.length - (d.which === 'start' ? 2 : 1)
      didWrap = true
    } else {
      if (edge && d.edge === edge && d.wrappedSystem !== null) return
      local = nearestKnot(knots.x, x)
    }
    const candidate = knotAtPosition(this.globalLoopKnots.pos, knots.pos[Math.max(0, local)] ?? 0)
    const k = Math.max(d.lo, Math.min(d.hi, candidate))
    if (didWrap) d.edge = edge
    if (k === d.knot) return
    d.knot = k
    const next = this.withEdge(this.loop, d.which, this.globalLoopKnots, k)
    d.system = this.geo.systemOfOcc[d.which === 'start' ? next.fromOcc : next.toOcc] ?? system
    if (didWrap && d.system !== fromSystem) {
      d.wrappedSystem = d.system
      d.wrappedY = d.clientY
      // Keep the new line near the held finger. At the piece ends, the sticky system still
      // permits horizontal editing until the finger deliberately moves up or down.
      const span = this.geo.staffSpan(d.system)
      const target = PAGE_PAD_TOP + ((span.top + span.bottom) / 2 - this.layout.top) * this.scale
      this.scrollHandleTo(target - (d.clientY - d.top), edge > 0 ? 0 : this.clampScrollX(Infinity))
    }
    if (!sameRange(next, d.range)) {
      d.range = next
      this.schedule()
    }
  }

  private scrollHandleTo(y: number, x = this.scrollX): void {
    const d = this.handleDrag
    if (!d) return
    const next = Math.max(0, Math.min(Math.max(0, this.sheetHeight() - this.hostH), y))
    if (Math.abs(next - this.scrollY) < 1 && Math.abs(x - this.scrollX) < 1) return
    d.scrolled = true
    this.scrollTo(next, false, x)
    this.schedule()
  }

  /** Reveal the rest of a wide system or more systems while a held edge nears the viewport. */
  private updateHandleScroll(): void {
    const d = this.handleDrag
    if (!d || d.wrappedSystem !== null) {
      this.stopHandleScroll()
      return
    }
    const rel = d.clientY - d.top
    const depth =
      rel < HANDLE_SCROLL_ZONE
        ? -(HANDLE_SCROLL_ZONE - Math.max(0, rel)) / HANDLE_SCROLL_ZONE
        : rel > d.height - HANDLE_SCROLL_ZONE
          ? (HANDLE_SCROLL_ZONE - Math.max(0, d.height - rel)) / HANDLE_SCROLL_ZONE
          : 0
    this.handleScrollSpeed = depth * HANDLE_SCROLL_SPEED
    const horizontal = d.clientX - d.left
    const depthX =
      horizontal < HANDLE_SCROLL_ZONE
        ? -(HANDLE_SCROLL_ZONE - Math.max(0, horizontal)) / HANDLE_SCROLL_ZONE
        : horizontal > d.width - HANDLE_SCROLL_ZONE
          ? (HANDLE_SCROLL_ZONE - Math.max(0, d.width - horizontal)) / HANDLE_SCROLL_ZONE
          : 0
    this.handleScrollSpeedX = this.sheetWidth() > this.hostW ? depthX * HANDLE_SCROLL_SPEED : 0
    if (!depth && !this.handleScrollSpeedX) this.stopHandleScroll()
    else if (!this.handleScrollFrame) this.handleScrollFrame = requestAnimationFrame(this.handleScrollTick)
  }

  private readonly handleScrollTick = (now: number): void => {
    this.handleScrollFrame = 0
    if (!this.handleDrag || this.destroyed || (!this.handleScrollSpeed && !this.handleScrollSpeedX)) return
    const ms = this.handleScrollAt ? Math.min(32, now - this.handleScrollAt) : 16
    this.handleScrollAt = now
    const before = this.scrollY
    const beforeX = this.scrollX
    this.scrollHandleTo(
      before + (this.handleScrollSpeed * ms) / 1000,
      this.clampScrollX(beforeX + (this.handleScrollSpeedX * ms) / 1000),
    )
    if (this.scrollY === before && this.scrollX === beforeX) return
    this.dragHandleTo(true)
    this.flushNow()
    this.updateHandleScroll()
  }

  private stopHandleScroll(): void {
    if (this.handleScrollFrame) cancelAnimationFrame(this.handleScrollFrame)
    this.handleScrollFrame = 0
    this.handleScrollAt = 0
    this.handleScrollSpeed = 0
    this.handleScrollSpeedX = 0
  }

  private handleUp(e: PointerEvent, canceled = false): void {
    const d = this.handleDrag
    if (!d || e.pointerId !== d.pointerId) return
    e.stopPropagation()
    this.endHandleDrag()
    if (!canceled && this.loop && this.loopEditable && !sameRange(d.range, this.loop)) {
      this.loop = d.range
      this.opts.onLoopChange?.(d.range)
    }
    this.schedule()
  }

  /** End without committing (the release caller commits), retaining any edge-scroll position. */
  private endHandleDrag(): void {
    const d = this.handleDrag
    if (!d) return
    this.handleDrag = null
    this.stopHandleScroll()
    this.startHandle.classList.remove('pn-grab')
    this.endHandle.classList.remove('pn-grab')
    if (d.scrolled && this.browseEnabled && !this.browsing) {
      this.browsing = true
      this.root.classList.add('pn-browsing')
      this.opts.onBrowse?.(true)
    }
    this.schedule()
  }

  /** Arrow keys move an edge to the next note (Shift: the next barline), across systems too. */
  private handleKey(e: KeyboardEvent, which: 'start' | 'end'): void {
    if (!this.loop || !this.loopEditable) return
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    e.preventDefault()
    const K = this.globalLoopKnots
    const { start, end } = passagePositions(this.layout.occurrences, this.loop)
    const limits = edgeLimits(K, which, which === 'start' ? end : start)
    if (!limits) return
    let k = knotAtPosition(K.pos, which === 'start' ? start : end) + step
    if (e.shiftKey) while (k > limits.lo && k < limits.hi && K.exact[k] !== null) k += step
    k = Math.min(limits.hi, Math.max(limits.lo, k))
    const next = clampRange(this.withEdge(this.loop, which, K, k), this.layout.occurrences.length)
    if (sameRange(next, this.loop)) return
    this.loop = next
    this.schedule()
    this.opts.onLoopChange?.(next)
  }

  /** Keyboard playhead (U25): ← / → onsets, Shift bars, Home / End; across systems. */
  private cursorKey(e: KeyboardEvent): void {
    if (!this.cursorDraggable || this.cursorDrag) return
    const exactAll = this.snapSource ?? []
    const n = exactAll.length
    if (n === 0) return
    const pos = exactAll.map(toNumber)
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    const P = Float64Array.from(pos)
    const at = knotAtPosition(P, this.cursorPos)
    let k: number
    if (e.key === 'Home') k = 0
    else if (e.key === 'End') k = n - 1
    else if (step !== 0) {
      if (!e.shiftKey) k = at + step
      else {
        const occs = this.layout.occurrences
        const i = occAtPosition(occs, P[at]!)
        if (step > 0) k = firstKnotAtOrAfter(P, occs[i + 1]?.start ?? Infinity)
        else {
          k = firstKnotAtOrAfter(P, occs[i]?.start ?? 0)
          if (k >= at) k = firstKnotAtOrAfter(P, occs[i - 1]?.start ?? 0)
        }
      }
      k = Math.max(0, Math.min(n - 1, k))
    } else return
    e.preventDefault()
    if (k === at) return
    const exact = exactAll[k]!
    const seek = this.opts.onCursorSeek
    if (!seek || seek(exact) === false) return
    this.cursorPos = P[k]!
    this.cursor = this.geo.cursorAt(this.cursorPos)
    this.returnToCurrent()
    this.followRequest = 'smooth'
    this.followXRequest = true
    const text = this.opts.cursorDragLabel?.(exact) ?? ''
    if (text) this.cursorGrip.setAttribute('aria-valuetext', text)
    if (this.readoutEl.textContent !== text) this.readoutEl.textContent = text
    this.schedule()
  }
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
