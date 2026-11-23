// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'preact'
import { act } from 'preact/test-utils'
import { useRef } from 'preact/hooks'
import { mount, type Mounted } from '../shared/testing'
import type { StripHandle } from './env'
import {
  REVIEW_CARD_GAP,
  reviewFrame,
  reviewInsetFor,
  reviewTopFor,
  useReviewInset,
  type ReviewInsetHandle,
} from './reviewInset'

describe('review insets (U97)', () => {
  it('keeps the dock and the top overlays clear, nothing without them', () => {
    // Stage 100–700, a 60 px card 12 px above its bottom edge.
    expect(reviewInsetFor(700, 628, 60)).toBe(72 + REVIEW_CARD_GAP)
    expect(reviewInsetFor(700, 700, 0)).toBe(0)
    // A 56 px Repeat panel 8 px below the stage's top edge.
    expect(reviewTopFor(100, 164, 56)).toBe(64 + REVIEW_CARD_GAP)
    expect(reviewTopFor(100, 108, 0)).toBe(0)
  })
})

const rect = (top: number, bottom: number) =>
  ({ top, bottom, height: bottom - top, left: 0, right: 800, width: 800, x: 0, y: top }) as DOMRect

/** A stub ResizeObserver: the test says when an observed element changed size. */
class Resize {
  static all: Resize[] = []
  readonly targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    Resize.all.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
  }
  static resized(target: Element) {
    for (const o of Resize.all.filter((o) => o.targets.has(target))) act(() => o.callback([], o as never))
  }
}

describe('review insets against the score view (P8)', () => {
  let view: Mounted | null = null
  afterEach(() => {
    view?.unmount()
    view = null
    vi.unstubAllGlobals()
    Resize.all = []
  })

  it('measures against the strip root, which starts lower while the timing-cue row is on', () => {
    vi.stubGlobal('ResizeObserver', Resize)
    const setReviewInset = vi.fn()
    let handle: ReviewInsetHandle | null = null
    function Stage() {
      const dock = useRef<HTMLDivElement>(null)
      const overlays = useRef<HTMLDivElement>(null)
      const strip = useRef({ setReviewInset } as unknown as StripHandle)
      handle = useReviewInset(dock, overlays, strip, 'strip')
      return h('div', { id: 'stage' }, [
        h('div', { 'data-testid': 'strip-host', key: 'host' }, h('div', { class: 'pn-strip' })),
        h('div', { ref: overlays, id: 'overlays', key: 'overlays' }),
        h('div', { ref: dock, id: 'dock', key: 'dock' }),
      ])
    }
    // Stage 100–700; the overlay column ends at 164; the dock is 600–688.
    const stub = (id: string, value: () => DOMRect) => {
      const el = id === 'strip' ? document.querySelector('.pn-strip')! : document.getElementById(id)!
      el.getBoundingClientRect = value
    }
    view = mount(h(Stage, null))
    // The cue row is on: the strip starts 40 px below the stage, the overlay column with it.
    let stripTop = 140
    stub('stage', () => rect(100, 700))
    stub('strip', () => rect(stripTop, 700))
    stub('overlays', () => rect(108 + (stripTop - 100), 164 + (stripTop - 100)))
    stub('dock', () => rect(600, 688))
    act(() => handle!.attach())
    expect(reviewFrame(document.getElementById('stage')!).top).toBe(140)
    // Measured against the stage, the top would keep 40 px too many (104 + 8).
    expect(setReviewInset).toHaveBeenLastCalledWith(100 + REVIEW_CARD_GAP, 64 + REVIEW_CARD_GAP)
    // The row turns off: the overlays move up (a move, not a resize) and the strip root grows. Its
    // resize measures again, and nothing is left stale.
    stripTop = 100
    Resize.resized(document.querySelector('.pn-strip')!)
    expect(setReviewInset).toHaveBeenLastCalledWith(100 + REVIEW_CARD_GAP, 64 + REVIEW_CARD_GAP)
    expect(setReviewInset).not.toHaveBeenCalledWith(expect.anything(), 104 + REVIEW_CARD_GAP)
    // A dock that grows is followed as before.
    stub('dock', () => rect(560, 688))
    Resize.resized(document.getElementById('dock')!)
    expect(setReviewInset).toHaveBeenLastCalledWith(140 + REVIEW_CARD_GAP, 64 + REVIEW_CARD_GAP)
  })
})
