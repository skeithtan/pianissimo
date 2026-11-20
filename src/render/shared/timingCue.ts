import type { TimingDirection } from '../../core/model/practice'

const WIDTH = 158
const HEIGHT = 36
const EDGE = 8

/** A badge in a fixed row above the score that tracks the playhead horizontally. */
export class TimingCue {
  private readonly frame: HTMLDivElement
  private readonly bubble: HTMLDivElement
  private readonly label: HTMLSpanElement
  private enabled = false
  private direction: TimingDirection | null = null
  private x = NaN

  constructor(host: HTMLElement, score: HTMLElement) {
    const doc = host.ownerDocument
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
    this.bubble.append(signal, this.label)
    layer.append(this.bubble)
    this.frame.append(score, layer)
    host.append(this.frame)
  }

  set(direction: TimingDirection | null, enabled: boolean): boolean {
    const layoutChanged = enabled !== this.enabled
    if (layoutChanged) {
      this.enabled = enabled
      this.frame.toggleAttribute('data-timing-enabled', enabled)
    }
    if (direction === this.direction) return layoutChanged
    this.direction = direction
    if (direction === null) {
      delete this.frame.dataset.timingDirection
      delete this.bubble.dataset.direction
      this.label.textContent = ''
    } else {
      this.frame.dataset.timingDirection = direction
      this.bubble.dataset.direction = direction
      this.label.textContent = direction === 'rushing' ? 'Rushing' : 'Dragging'
    }
    return true
  }

  get visible(): boolean {
    return this.direction !== null
  }

  place(cursorX: number, width: number): void {
    const inset = Math.min(WIDTH / 2 + EDGE, width / 2)
    const x = Math.round(Math.max(inset, Math.min(cursorX, width - inset)))
    if (x === this.x) return
    this.x = x
    this.bubble.style.transform = `translate3d(${x}px, 0, 0)`
  }

  destroy(): void {
    this.frame.remove()
  }
}
