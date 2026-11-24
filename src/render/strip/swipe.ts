/**
 * Native swiping for the strip (DECISIONS U150). An empty, invisible horizontal scroller lies under
 * the score and takes the finger, so the platform itself supplies the drag, the momentum, the
 * catch on touch and the bounce at the ends. The strip draws the music where the scroller is: the
 * notation, the pinned signatures and their masks keep sharing one translate.
 *
 * Desktop Safari's trackpad scrolls it natively too (`trackpad`, U153), bounce included. Other
 * browsers keep their bounce to themselves (`scrollLeft` stops at the ends): the strip draws their wheel.
 *
 * The scroller is only ever written while nobody scrolls it (a write stops iOS momentum and
 * bounce), and never on a playback frame: it is lined up with the music when a finger lands, or
 * after the music has been still for a while.
 */

/** A lifted swipe has settled after this long without a scroll event (no `scrollend` before that), ms. */
export const SWIPE_SETTLE_MS = 150
/** A quick flick's first scroll event may come this long after its touch ended, ms. */
const ARM_MS = 300
/** A `scrollend` that never comes is not waited for longer than this after the last scroll event, ms. */
const LOST_END_MS = 2000
/** The music is still (and the scroller lined up, on a touch device) this long after its last move, ms. */
const REST_MS = 300
/** A trackpad gives no warning of a gesture: there the scroller keeps up, at most this often, ms. */
const KEEP_UP_MS = 100
/**
 * Share of the way to the scroller drawn per frame while it coasts: WebKit reports whole px, and
 * the slow end of a glide would step. The music is compared with nothing, so the lag is not seen.
 */
const COAST_FOLLOW = 0.7

export interface SwipeHost {
  /** Viewport width, px. */
  width(): number
  /** The content translate drawn now. */
  tx(): number
  /** Where the translate may rest. */
  range(): { min: number; max: number }
  /** A swipe moved: false refuses it. */
  begin(): boolean
  /** The scroller moved: draw a frame (`step`). */
  move(): void
  /** The swipe came to rest at translate `tx`. */
  settle(tx: number): void
}

export class SwipeScroller {
  readonly el: HTMLDivElement
  private readonly track: HTMLDivElement
  private readonly host: SwipeHost
  private trackW = 0
  /** `scrollLeft` as last written or read. */
  private at = 0
  /** The translate at `scrollLeft` 0 during a swipe. */
  private base = 0
  private drawn = 0
  private touches = 0
  /** A finger landed on the scroller: the next scroll it did not get from `align` is a swipe. */
  private armed = false
  private swiping = false
  /** Scroll events seen that still report the place before `align` wrote it. */
  private stray = 0
  /** The browser took the touch over (Chrome): only `scrollend` tells when the finger lifted. */
  private taken = false
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private armTimer: ReturnType<typeof setTimeout> | null = null
  private restTimer: ReturnType<typeof setTimeout> | null = null
  private unlockTimer: ReturnType<typeof setTimeout> | null = null
  /** When the music last moved by itself (a trackpad's: when the scroller last kept up). */
  private movedAt = 0
  private readonly touchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
  /**
   * Desktop Safari: its scroller reports the places past the ends while it bounces. It bounces only
   * where no wheel listener may cancel the scroll, so the owner's is passive there, and any scroll
   * `align` did not write is the learner's.
   */
  readonly trackpad =
    typeof navigator !== 'undefined' && /^Apple/.test(navigator.vendor ?? '') && !(navigator.maxTouchPoints > 0)
  /** A trackpad's fingers (or its momentum) are still on: `scrollend` comes after each, momentum too. */
  private wheeling = false
  /** Momentum that outlives a `stop` is ignored until the trackpad is quiet. */
  private quietTimer: ReturnType<typeof setTimeout> | null = null

  constructor(doc: Document, host: SwipeHost) {
    this.host = host
    this.el = doc.createElement('div')
    this.el.className = 'pn-scroll'
    this.el.setAttribute('aria-hidden', 'true')
    this.el.tabIndex = -1
    this.track = doc.createElement('div')
    this.track.className = 'pn-scroll-track'
    this.el.append(this.track)
    // Not passive: the scroller is lined up before the platform starts to pan, and two fingers
    // are a pinch, never a pan.
    this.el.addEventListener('touchstart', (e) => this.touchStart(e), { passive: false })
    this.el.addEventListener('touchmove', (e) => this.touchMove(e), { passive: false })
    this.el.addEventListener('touchend', (e) => this.touchEnd(e, false))
    this.el.addEventListener('touchcancel', (e) => this.touchEnd(e, true))
    this.el.addEventListener('scroll', () => this.scrolled(), { passive: true })
    this.el.addEventListener('scrollend', () => {
      this.wheeling = false
      if (!this.swiping || this.touches > 0) return
      // A trackpad's ends when the fingers lift, before its momentum or its spring back.
      if (this.trackpad) this.waitForRest()
      else this.settle()
    })
  }

  /** A finger drags the music, or it coasts or bounces after one. */
  get active(): boolean {
    return this.swiping
  }

  /** Lines the scroller up with the music (its place and its ends). Never changes what is drawn. */
  align(): void {
    const w = this.host.width()
    if (this.swiping || !(w > 0)) return
    const { min, max } = this.host.range()
    const trackW = Math.ceil(w + max - min)
    if (trackW !== this.trackW) {
      this.trackW = trackW
      this.track.style.width = `${trackW}px`
    }
    const at = Math.max(0, Math.round(max - this.host.tx()))
    if (at === this.at) return
    this.el.scrollLeft = at
    this.at = this.el.scrollLeft
  }

  /** A trackpad or wheel event over the scroller, which scrolls it natively (`trackpad` only). */
  wheel(): void {
    this.wheeling = true
    if (this.quietTimer) this.waitForQuiet()
  }

  /** The music moved by other means (following, a seek): line up once it has been still. */
  moved(): void {
    if (!(this.touchDevice || this.trackpad) || this.swiping) return
    const now = performance.now()
    if (this.trackpad) {
      this.restTimer ??= setTimeout(this.rest, Math.max(0, this.movedAt + KEEP_UP_MS - now))
      return
    }
    this.movedAt = now
    this.restTimer ??= setTimeout(this.rest, REST_MS)
  }

  private readonly rest = (): void => {
    this.restTimer = null
    if (this.swiping || this.armed || this.quietTimer) return
    const now = performance.now()
    if (!this.trackpad && now - this.movedAt < REST_MS - 50) this.restTimer = setTimeout(this.rest, REST_MS)
    else {
      this.movedAt = now
      this.align()
    }
  }

  /** One drawn frame of a swipe: the translate, and whether the scroller's place is reached. */
  step(): { tx: number; done: boolean } {
    const target = this.base - this.at
    const gap = target - this.drawn
    this.drawn = this.touches > 0 || Math.abs(gap) < 0.25 ? target : this.drawn + gap * COAST_FOLLOW
    return { tx: this.drawn, done: this.drawn === target }
  }

  /** The music was placed at `tx` during a swipe (a zoom): the swipe goes on from there. */
  rebase(tx: number): void {
    if (!this.swiping) return
    this.base = tx + this.at
    this.drawn = tx
  }

  /** Ends a swipe at once, momentum included; nothing is reported. */
  stop(): void {
    this.armed = false
    if (!this.swiping) return
    this.swiping = false
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    if (this.trackpad) this.waitForQuiet()
    // A scroller that cannot scroll has no momentum.
    this.el.style.overflowX = 'hidden'
    this.unlockTimer ??= setTimeout(() => {
      this.unlockTimer = null
      this.el.style.overflowX = ''
    }, 60)
  }

  destroy(): void {
    this.armed = this.swiping = false
    for (const t of [this.settleTimer, this.armTimer, this.restTimer, this.unlockTimer, this.quietTimer])
      if (t) clearTimeout(t)
  }

  private waitForQuiet(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null
      this.align()
    }, SWIPE_SETTLE_MS)
  }

  private touchStart(e: TouchEvent): void {
    this.touches = e.targetTouches.length
    if (this.armTimer) clearTimeout(this.armTimer)
    this.armTimer = null
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    if (e.touches.length > 1) {
      if (e.cancelable) e.preventDefault()
      if (!this.swiping) this.armed = false
      return
    }
    this.taken = false
    // A finger that catches coasting music: the platform stops it, and may drag it on.
    if (this.swiping) return
    this.armed = true
    this.stray = 0
    this.align()
  }

  private touchMove(e: TouchEvent): void {
    if (!e.cancelable) return
    if (e.touches.length > 1) e.preventDefault()
    // The music may follow playback under a resting finger: the ends stay true until it pans.
    else if (this.armed) this.align()
  }

  private touchEnd(e: TouchEvent, canceled: boolean): void {
    this.touches = e.targetTouches.length
    if (this.touches > 0) return
    this.taken = canceled && 'onscrollend' in this.el
    if (this.swiping) this.waitForRest()
    else this.disarmLater()
  }

  private disarmLater(): void {
    if (this.armTimer) clearTimeout(this.armTimer)
    this.armTimer = setTimeout(() => {
      this.armTimer = null
      if (!this.swiping) this.armed = false
    }, ARM_MS)
  }

  private scrolled(): void {
    const at = this.el.scrollLeft
    if (!this.swiping) {
      if (this.quietTimer) this.waitForQuiet()
      if (!(this.armed || this.trackpad) || this.quietTimer || at === this.at) {
        this.at = at
        return
      }
      // Right after `align`, an event may still report the place the platform panned from.
      const far = Math.abs(at - this.at) > this.host.width() / 2
      if (far && ++this.stray < 3) return
      this.drawn = this.host.tx()
      this.base = this.drawn + (far ? at : this.at)
      this.swiping = true
      if (!this.host.begin()) this.stop()
      if (!this.swiping) return
    }
    this.at = at
    this.host.move()
    if (this.touches === 0) this.waitForRest()
  }

  private waitForRest(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    const held = this.taken || (this.trackpad && this.wheeling)
    this.settleTimer = setTimeout(() => this.settle(), held ? LOST_END_MS : SWIPE_SETTLE_MS)
  }

  private settle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    if (!this.swiping) return
    this.swiping = false
    this.armed = false
    this.host.settle(this.base - this.at)
  }
}
