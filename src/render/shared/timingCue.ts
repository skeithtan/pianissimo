import { effect } from '@preact/signals'
import { msg, messageLanguage } from '../../i18n/messages'
import type { TimingDirection } from '../../core/model/practice'

const WIDTH = 158
const HEIGHT = 36
const EDGE = 8
const GAP = 8
const RESERVED_ROW_Y = -HEIGHT - 2

/**
 * A badge above the music that tracks the playhead horizontally. The direction is written on the
 * badge and on the cursor bar only (`data-direction`, `data-timing`), never on an ancestor of the
 * score: a change restyles those two elements, not every mounted note.
 */
export class TimingCue {
  private readonly frame: HTMLDivElement
  private readonly bubble: HTMLDivElement
  private readonly label: HTMLSpanElement
  private readonly cursor: HTMLElement
  private readonly stopLanguage: () => void
  private enabled = false
  private direction: TimingDirection | null = null
  /** The last place the view reported (`place`), kept while hidden; NaN before the first. */
  private cursorX = NaN
  private width = NaN
  private scoreTop = NaN
  private x = NaN
  private y = NaN

  /** `cursor`: the playhead bar, tinted while a cue shows (U119). */
  constructor(host: HTMLElement, score: HTMLElement, cursor: HTMLElement) {
    const doc = host.ownerDocument
    this.cursor = cursor
    this.frame = doc.createElement('div')
    this.frame.className = 'pn-score-viewport'
    const layer = doc.createElement('div')
    layer.className = 'pn-timing-layer'
    layer.setAttribute('role', 'status')
    this.bubble = doc.createElement('div')
    this.bubble.className = 'pn-timing-cue'
    this.bubble.dataset.testid = 'timing-cue'
    this.bubble.style.width = `${WIDTH}px`
    this.bubble.style.height = `${HEIGHT}px`
    // The gradient slides on its own layer (transform only), clipped by the badge.
    const sweep = doc.createElement('span')
    sweep.className = 'pn-timing-sweep'
    sweep.setAttribute('aria-hidden', 'true')
    const signal = doc.createElement('span')
    signal.className = 'pn-timing-signal'
    signal.setAttribute('aria-hidden', 'true')
    const arrows = doc.createElement('span')
    arrows.className = 'pn-timing-chevrons'
    // Three positions are visible and the fourth lets the track loop as it slides.
    for (let i = 0; i < 4; i++) {
      const chevron = doc.createElement('span')
      chevron.className = 'pn-timing-chevron'
      arrows.append(chevron)
    }
    signal.append(arrows)
    this.label = doc.createElement('span')
    this.label.className = 'pn-timing-label'
    this.bubble.append(sweep, signal, this.label)
    layer.append(this.bubble)
    this.frame.append(score, layer)
    host.append(this.frame)
    this.stopLanguage = effect(() => {
      messageLanguage()
      this.updateText()
    })
  }

  set(direction: TimingDirection | null, enabled: boolean): boolean {
    const layoutChanged = enabled !== this.enabled
    if (layoutChanged) {
      this.enabled = enabled
      this.frame.toggleAttribute('data-timing-enabled', enabled)
    }
    if (direction === this.direction) return layoutChanged
    const appearing = this.direction === null
    this.direction = direction
    if (direction === null) {
      delete this.bubble.dataset.direction
      delete this.cursor.dataset.timing
    } else {
      // In place before it is painted: at the view's last reported place, or hidden until the first.
      if (appearing) this.apply()
      this.bubble.dataset.direction = direction
      this.cursor.dataset.timing = direction
    }
    this.updateText()
    return true
  }

  private updateText(): void {
    this.label.textContent =
      this.direction === null ? '' : this.direction === 'rushing' ? msg('Rushing') : msg('Dragging')
  }

  get visible(): boolean {
    return this.direction !== null
  }

  get active(): boolean {
    return this.enabled
  }

  /**
   * The playhead's screen x, the viewport width and the top of the score (px). Views report it on
   * every frame, hidden or not; only a visible cue is moved.
   */
  place(cursorX: number, width: number, scoreTop = 0): void {
    this.cursorX = cursorX
    this.width = width
    this.scoreTop = scoreTop
    if (this.direction !== null) this.apply()
  }

  private apply(): void {
    if (Number.isNaN(this.cursorX)) {
      this.bubble.style.visibility = 'hidden'
      return
    }
    const inset = Math.min(WIDTH / 2 + EDGE, this.width / 2)
    const x = Math.round(Math.max(inset, Math.min(this.cursorX, this.width - inset)))
    const y = Math.max(RESERVED_ROW_Y, Math.floor(this.scoreTop) - HEIGHT - GAP)
    if (this.bubble.style.visibility) this.bubble.style.visibility = ''
    if (x === this.x && y === this.y) return
    this.x = x
    this.y = y
    this.bubble.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  destroy(): void {
    this.stopLanguage()
    this.frame.remove()
  }
}
