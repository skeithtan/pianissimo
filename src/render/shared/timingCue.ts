import type { TimingDirection } from '../../core/model/practice'
import { INK_COLUMN_WIDTH } from '../geom'
import type { PreparedLayout } from '../types'
import type { ScreenFrame } from './respace'

const WIDTH = 158
const HEIGHT = 36
const EDGE = 8
const GAP = 8
const FALLBACK_Y = -HEIGHT - 2

/** Screen-space badge above the playhead's staff, with a fallback outside the score. */
export class TimingCue {
  private readonly frame: HTMLDivElement
  private readonly bubble: HTMLDivElement
  private readonly label: HTMLSpanElement
  private enabled = false
  private direction: TimingDirection | null = null
  private x = NaN
  private y = NaN

  constructor(
    host: HTMLElement,
    score: HTMLElement,
    private readonly layout: PreparedLayout,
  ) {
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

  place(cursorX: number, width: number, height: number, frame: ScreenFrame | null, system?: number): void {
    if (!this.direction) return
    const inset = Math.min(WIDTH / 2 + EDGE, width / 2)
    const x = Math.round(Math.max(inset, Math.min(cursorX, width - inset)))
    const y = frame ? this.clearY(x, height, frame, system) : FALLBACK_Y
    if (x === this.x && y === this.y) return
    this.x = x
    this.y = y
    this.bubble.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  private clearY(x: number, height: number, { scale, dx, dy }: ScreenFrame, system?: number): number {
    const line = system === undefined ? undefined : this.layout.systems?.[system]
    const profile = line?.inkBounds ?? this.layout.inkBounds
    const staves = line?.staves ?? this.layout.staves
    let top = profile ? (staves[0]?.top ?? 0) : (line?.y0 ?? this.layout.top)
    let bottom = profile ? (staves.at(-1)?.bottom ?? top) : (line?.y1 ?? this.layout.top + this.layout.height)
    if (profile) {
      const halfWidth = WIDTH / 2 + GAP
      const first = Math.max(0, Math.floor((x - halfWidth - dx) / scale / INK_COLUMN_WIDTH))
      const last = Math.min(profile.top.length - 1, Math.floor((x + halfWidth - dx) / scale / INK_COLUMN_WIDTH))
      for (let i = first; i <= last; i++) {
        top = Math.min(top, profile.top[i]!)
        bottom = Math.max(bottom, profile.bottom[i]!)
      }
    }
    const prev = system === undefined ? undefined : this.layout.systems?.[system - 1]
    const next = system === undefined ? undefined : this.layout.systems?.[system + 1]
    const above = Math.floor(top * scale + dy) - HEIGHT - GAP
    const below = Math.ceil(bottom * scale + dy) + GAP
    // The adjacent systems' padded extents already leave clearance on their sides of the gap.
    const upperLimit = prev ? Math.max(EDGE, Math.ceil(prev.y1 * scale + dy)) : EDGE
    const lowerLimit = next ? Math.min(height - EDGE, Math.floor(next.y0 * scale + dy)) : height - EDGE
    if (above >= upperLimit && above + HEIGHT <= height - EDGE) return above
    if (below >= EDGE && below + HEIGHT <= lowerLimit) return below
    return FALLBACK_Y
  }

  destroy(): void {
    this.frame.remove()
  }
}
