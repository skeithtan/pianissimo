import type { TimingDirection } from '../../core/model/practice'

const WIDTH = 108
const EDGE = 8
/** Distance from the top of the cue to the top staff, including a small gap. */
const STAFF_OFFSET = 40

/** Screen-space cue attached to the playhead in both score layouts. */
export class TimingCue {
  readonly element = document.createElement('div')
  private readonly bubble = document.createElement('div')
  private readonly arrow = document.createElement('span')
  private readonly label = document.createElement('span')
  private direction: TimingDirection | null = null
  private x = NaN
  private y = NaN

  constructor() {
    this.element.setAttribute('role', 'status')
    this.bubble.className = 'pn-timing-cue'
    this.bubble.dataset.testid = 'timing-cue'
    this.bubble.style.width = `${WIDTH}px`
    this.arrow.className = 'pn-timing-arrow'
    this.arrow.setAttribute('aria-hidden', 'true')
    this.bubble.append(this.arrow, this.label)
    this.element.append(this.bubble)
  }

  set(direction: TimingDirection | null): boolean {
    if (direction === this.direction) return false
    this.direction = direction
    if (direction === null) {
      delete this.bubble.dataset.direction
      this.arrow.textContent = ''
      this.label.textContent = ''
    } else {
      this.bubble.dataset.direction = direction
      this.arrow.textContent = direction === 'rushing' ? '←' : '→'
      this.label.textContent = direction === 'rushing' ? 'Rushing' : 'Dragging'
    }
    return true
  }

  place(cursorX: number, cursorY: number, staffTop: number, viewportWidth: number): void {
    if (!this.direction) return
    const inset = Math.min(WIDTH / 2 + EDGE, viewportWidth / 2)
    const x = Math.round(Math.max(inset, Math.min(cursorX, viewportWidth - inset)) - cursorX)
    const y = Math.round(Math.max(EDGE, staffTop - STAFF_OFFSET) - cursorY)
    if (x === this.x && y === this.y) return
    this.x = x
    this.y = y
    this.bubble.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }
}
