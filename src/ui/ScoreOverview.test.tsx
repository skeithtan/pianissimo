// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { $, mount, press, type Mounted } from '../views/shared/testing'
import { rat } from '../core/music/rational'
import type { TempoMapData } from '../core/music/tempo'
import {
  barEdges,
  dragLoopEdge,
  fractionAt,
  loopExtent,
  occAtFraction,
  occAtPosition,
  overviewMeasures,
  progressAt,
  sectionAt,
  sectionMarkers,
  tickPath,
  totalLength,
  type OverviewMeasure,
} from './overviewMath'
import { LOOP_FADE_MS, ScoreOverview } from './ScoreOverview'

/** 10 bars of 1 whole note, except bar 4 which is a half bar. */
const MEASURES: OverviewMeasure[] = Array.from({ length: 10 }, (_, i) => ({
  start: i < 5 ? i : i - 0.5,
  duration: i === 4 ? 0.5 : 1,
}))

describe('overview math', () => {
  it('measures the piece and finds the bar at a position', () => {
    expect(totalLength(MEASURES)).toBe(9.5)
    expect(totalLength([])).toBe(0)
    expect(occAtPosition(MEASURES, 0)).toBe(0)
    expect(occAtPosition(MEASURES, 0.99)).toBe(0)
    expect(occAtPosition(MEASURES, 4.2)).toBe(4)
    expect(occAtPosition(MEASURES, 4.5)).toBe(5)
    expect(occAtPosition(MEASURES, 99)).toBe(9)
    expect(occAtPosition(MEASURES, -3)).toBe(0)
    expect(occAtPosition([], 3)).toBe(0)
  })

  it('maps pointer offsets to fractions and bars, clamped to the bar', () => {
    expect(fractionAt(150, 100, 200)).toBe(0.25)
    expect(fractionAt(50, 100, 200)).toBe(0)
    expect(fractionAt(999, 100, 200)).toBe(1)
    expect(fractionAt(5, 0, 0)).toBe(0)
    expect(occAtFraction(MEASURES, 0)).toBe(0)
    expect(occAtFraction(MEASURES, 1)).toBe(9)
    expect(occAtFraction(MEASURES, 0.5)).toBe(5) // 4.75 whole notes is inside bar 5 (starts at 4.5)
  })

  it('computes progress and the inclusive loop extent', () => {
    expect(progressAt(MEASURES, 0)).toBe(0)
    expect(progressAt(MEASURES, 4.75)).toBeCloseTo(0.5, 10)
    expect(progressAt(MEASURES, 100)).toBe(1)
    const extent = loopExtent(MEASURES, 2, 3)!
    expect(extent.left).toBeCloseTo(2 / 9.5, 10)
    expect(extent.width).toBeCloseTo(2 / 9.5, 10) // both boundary bars included
    expect(loopExtent(MEASURES, 3, 2)).toEqual(extent)
    expect(loopExtent([], 0, 0)).toBeNull()
  })

  it('draws one tick per bar boundary, thinning very long pieces', () => {
    expect(tickPath(MEASURES).match(/M/gu)).toHaveLength(9)
    const long = Array.from({ length: 500 }, (_, i) => ({ start: i, duration: 1 }))
    const drawn = tickPath(long).match(/M/gu)!.length
    expect(drawn).toBeLessThan(260)
    expect(drawn).toBeGreaterThan(100)
    expect(tickPath([])).toBe('')
  })
})

/** 4 bars of 1 whole note; bars 2–3 are at half the tempo, so they take twice as long. */
const TIMED: OverviewMeasure[] = [
  { start: 0, duration: 1, seconds: 2 },
  { start: 1, duration: 1, seconds: 4, section: 'B' },
  { start: 2, duration: 1, seconds: 4 },
  { start: 3, duration: 1, seconds: 2, section: 'Coda' },
]

describe('dragLoopEdge (whole-bar overview handles)', () => {
  it('moves the dragged edge to a barline and keeps the other edge exactly', () => {
    const loop = { fromOcc: 2, toOcc: 5, start: rat(9, 4), end: rat(21, 4) }
    expect(dragLoopEdge(loop, 'end', 7, 9)).toEqual({ fromOcc: 2, toOcc: 7, start: rat(9, 4) })
    expect(dragLoopEdge(loop, 'start', 1, 9)).toEqual({ fromOcc: 1, toOcc: 5, end: rat(21, 4) })
    expect(dragLoopEdge({ fromOcc: 2, toOcc: 5 }, 'end', 3, 9)).toEqual({ fromOcc: 2, toOcc: 3 })
  })

  it('never crosses the other edge or leaves the piece', () => {
    expect(dragLoopEdge({ fromOcc: 2, toOcc: 5 }, 'start', 8, 9)).toEqual({ fromOcc: 5, toOcc: 5 })
    expect(dragLoopEdge({ fromOcc: 2, toOcc: 5 }, 'end', 0, 9)).toEqual({ fromOcc: 2, toOcc: 2 })
    expect(dragLoopEdge({ fromOcc: 2, toOcc: 5 }, 'start', -4, 9)).toEqual({ fromOcc: 0, toOcc: 5 })
    expect(dragLoopEdge({ fromOcc: 2, toOcc: 5 }, 'end', 40, 9)).toEqual({ fromOcc: 2, toOcc: 9 })
  })
})

describe('time-proportional overview (U12)', () => {
  it('sizes bars by their seconds, not their written length', () => {
    expect([...barEdges(TIMED)]).toEqual([0, 2 / 12, 6 / 12, 10 / 12, 1])
    expect(progressAt(TIMED, 1.5)).toBeCloseTo(4 / 12, 10) // halfway through the slow bar 2
    expect(occAtFraction(TIMED, 0.5)).toBe(2)
    expect(occAtFraction(TIMED, 0.49)).toBe(1)
    const loop = loopExtent(TIMED, 1, 2)!
    expect(loop.left).toBeCloseTo(2 / 12, 10)
    expect(loop.width).toBeCloseTo(8 / 12, 10)
    expect(tickPath(TIMED)).toBe('M166.67 0V1M500.00 0V1M833.33 0V1')
  })

  it('falls back to written lengths unless every bar has seconds', () => {
    const mixed = TIMED.map((m, i) => (i === 0 ? { start: m.start, duration: m.duration } : m))
    expect([...barEdges(mixed)]).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('builds measures from a score: seconds from the tempo map, section labels', () => {
    const tempo: TempoMapData = {
      segments: [
        { start: rat(0), quarterBpm: 120, beatUnit: rat(1, 4), beatBpm: 120, source: 'sound' },
        { start: rat(1), quarterBpm: 60, beatUnit: rat(1, 4), beatBpm: 60, source: 'sound' },
        { start: rat(3), quarterBpm: 120, beatUnit: rat(1, 4), beatBpm: 120, source: 'sound' },
      ],
    }
    const occurrences = [0, 1, 2, 3].map((i) => ({ index: i, start: rat(i), duration: rat(1) })) as never
    const measures = overviewMeasures({
      occurrences,
      tempo,
      sections: [
        { occ: 1, label: 'B' },
        { occ: 3, label: 'Coda' },
      ],
    })
    expect(measures).toEqual(TIMED)
    // A speed multiplier scales every bar alike: same proportions.
    expect([...barEdges(overviewMeasures({ occurrences, tempo }, 0.5))]).toEqual([...barEdges(TIMED)])
    // No numerical tempo: written lengths.
    expect(overviewMeasures({ occurrences, tempo: { segments: [] } })[0]).toEqual({ start: 0, duration: 1 })
  })

  it('places section markers with room up to the next one and names the current section', () => {
    const r = (v: number) => Math.round(v * 1e9) / 1e9
    expect(sectionMarkers(TIMED).map((m) => ({ ...m, left: r(m.left), room: r(m.room) }))).toEqual([
      { occ: 1, label: 'B', left: r(2 / 12), room: r(8 / 12) },
      { occ: 3, label: 'Coda', left: r(10 / 12), room: r(2 / 12) },
    ])
    expect(sectionAt(TIMED, 0)).toBeUndefined()
    expect(sectionAt(TIMED, 2)).toBe('B')
    expect(sectionAt(TIMED, 3)).toBe('Coda')
    expect(sectionMarkers(MEASURES)).toEqual([])
  })
})

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
  vi.restoreAllMocks()
})

function setup(props: Partial<Parameters<typeof ScoreOverview>[0]> = {}) {
  const onScrub = vi.fn()
  view = mount(<ScoreOverview measures={MEASURES} position={0} loop={null} onScrub={onScrub} {...props} />)
  const root = $(view.container, '[role="slider"]')!
  root.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 950,
    height: 34,
    right: 950,
    bottom: 34,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  return { onScrub, root }
}

const pointer = (type: string, clientX: number) =>
  new PointerEvent(type, { clientX, pointerId: 1, button: 0, bubbles: true, cancelable: true })

const nextFrame = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

describe('<ScoreOverview>', () => {
  it('is a slider with a spoken bar position', () => {
    const { root } = setup({ position: 2.3 })
    expect(root.getAttribute('aria-valuetext')).toBe('Bar 3 of 10')
    expect(root.getAttribute('aria-valuenow')).toBe('3')
    expect(root.getAttribute('aria-valuemax')).toBe('10')
    expect(root.tabIndex).toBe(0)
  })

  it('accepts a custom description', () => {
    const { root } = setup({ position: 0, describe: (occ, n) => `Measure ${occ + 12} (${n} bars)` })
    expect(root.getAttribute('aria-valuetext')).toBe('Measure 12 (10 bars)')
  })

  it('moves the played fill and the marker by transform only; ticks are not re-rendered', () => {
    const { root } = setup({ position: 0 })
    const tick = root.querySelector('svg path')!
    const played = root.children[1] as HTMLElement
    expect(played.style.transform).toBe('scaleX(0)')
    view!.rerender(<ScoreOverview measures={MEASURES} position={4.75} loop={null} onScrub={() => undefined} />)
    expect(played.style.transform).toBe('scaleX(0.5)')
    expect(root.querySelector('[data-testid="overview-marker"]')!.parentElement!.style.transform).toBe(
      'translateX(50%)',
    )
    expect(root.querySelector('svg path')).toBe(tick) // same DOM node: ticks untouched
  })

  it('highlights the loop across both boundary bars and fades it out when it goes', async () => {
    const { root } = setup({ loop: { fromOcc: 2, toOcc: 3 } })
    const loop = root.querySelector<HTMLElement>('[data-testid="overview-loop"]')!
    expect(parseFloat(loop.style.left)).toBeCloseTo((2 / 9.5) * 100, 4)
    expect(parseFloat(loop.style.width)).toBeCloseTo((2 / 9.5) * 100, 4)
    view!.rerender(<ScoreOverview measures={MEASURES} position={0} loop={null} onScrub={() => undefined} />)
    // Leaving Repeat mode (U14): the loop stays over its last extent while it fades.
    const leaving = root.querySelector<HTMLElement>('[data-testid="overview-loop"]')!
    expect(leaving.dataset['phase']).toBe('leaving')
    expect(parseFloat(leaving.style.width)).toBeCloseTo((2 / 9.5) * 100, 4)
    await act(async () => {
      await new Promise((res) => setTimeout(res, LOOP_FADE_MS + 60))
    })
    expect(root.querySelector('[data-testid="overview-loop"]')).toBeNull()
  })

  it('seeks immediately on tap and emits the final bar on release', () => {
    const { root, onScrub } = setup()
    act(() => {
      root.dispatchEvent(pointer('pointerdown', 475)) // halfway -> bar index 5
    })
    expect(onScrub).toHaveBeenLastCalledWith(5)
    act(() => {
      root.dispatchEvent(pointer('pointerup', 940)) // far right -> last bar
    })
    expect(onScrub).toHaveBeenLastCalledWith(9)
  })

  it('throttles drag moves to one emission per animation frame', async () => {
    const { root, onScrub } = setup()
    act(() => {
      root.dispatchEvent(pointer('pointerdown', 10))
    })
    onScrub.mockClear()
    act(() => {
      for (const x of [100, 200, 300, 400, 500]) root.dispatchEvent(pointer('pointermove', x))
    })
    expect(onScrub).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(onScrub).toHaveBeenCalledTimes(1)
    expect(onScrub).toHaveBeenCalledWith(occAtFraction(MEASURES, 500 / 950))
  })

  it('ignores pointers while disabled', () => {
    const { root, onScrub } = setup({ disabled: true })
    expect(root.getAttribute('aria-disabled')).toBe('true')
    expect(root.tabIndex).toBe(-1)
    act(() => {
      root.dispatchEvent(pointer('pointerdown', 475))
    })
    press(root, 'ArrowRight')
    expect(onScrub).not.toHaveBeenCalled()
  })

  it('moves by a bar with the arrow keys and jumps with Home / End', () => {
    const { root, onScrub } = setup({ position: 2.3 })
    press(root, 'ArrowRight')
    expect(onScrub).toHaveBeenLastCalledWith(3)
    press(root, 'ArrowLeft')
    expect(onScrub).toHaveBeenLastCalledWith(1)
    press(root, 'Home')
    expect(onScrub).toHaveBeenLastCalledWith(0)
    press(root, 'End')
    expect(onScrub).toHaveBeenLastCalledWith(9)
  })

  it('does not move past either end', () => {
    const { root, onScrub } = setup({ position: 0 })
    press(root, 'ArrowLeft')
    press(root, 'Home')
    expect(onScrub).not.toHaveBeenCalled()
  })

  it('draws section markers once and speaks the current section', () => {
    const { root } = setup({ measures: TIMED, position: 2.5 })
    const markers = root.querySelectorAll<HTMLElement>('[data-testid="overview-section"]')
    expect([...markers].map((m) => m.textContent)).toEqual(['B', 'Coda'])
    expect(markers[0]!.title).toBe('B')
    expect(parseFloat(markers[1]!.style.left)).toBeCloseTo((10 / 12) * 100, 4)
    expect(root.getAttribute('aria-valuetext')).toBe('Bar 3 of 4, B')
    view!.rerender(<ScoreOverview measures={TIMED} position={1.5} loop={null} onScrub={() => undefined} />)
    expect(root.querySelector('[data-testid="overview-section"]')).toBe(markers[0]) // not re-rendered
    const track = root.querySelector<HTMLElement>('[data-testid="overview-marker"]')!.parentElement!
    expect(parseFloat(/translateX\(([\d.]+)%\)/.exec(track.style.transform)![1]!)).toBeCloseTo((4 / 12) * 100, 6)
  })

  it('follows a live position by transforms only and re-renders only when the bar changes', () => {
    let position = 0.25
    const listeners = new Set<(p: number) => void>()
    const follow = {
      get: () => position,
      subscribe: (fn: (p: number) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const emit = (p: number) => {
      position = p
      act(() => listeners.forEach((fn) => fn(p)))
    }
    // `describe` runs on every render: it counts renders.
    const describe = vi.fn((occ: number, n: number) => `Bar ${occ + 1} of ${n}`)
    view = mount(
      <ScoreOverview measures={MEASURES} follow={follow} loop={null} onScrub={() => undefined} describe={describe} />,
    )
    const root = $(view.container, '[role="slider"]')!
    const played = root.children[1] as HTMLElement
    const track = root.querySelector<HTMLElement>('[data-testid="overview-marker"]')!.parentElement!
    expect(root.getAttribute('aria-valuenow')).toBe('1')
    expect(played.style.transform).toBe(`scaleX(${Math.round((0.25 / 9.5) * 4096) / 4096})`)

    // Within bar 1: the fill and marker move (in 1/4096 steps); nothing re-renders.
    const renders = describe.mock.calls.length
    emit(0.75)
    const step = Math.round((0.75 / 9.5) * 4096) / 4096
    expect(played.style.transform).toBe(`scaleX(${step})`)
    expect(track.style.transform).toBe(`translateX(${step * 100}%)`)
    expect(root.getAttribute('aria-valuenow')).toBe('1')
    expect(describe.mock.calls.length).toBe(renders)

    // A sub-step move writes nothing.
    const before = played.style.transform
    emit(0.75 + 1e-5)
    expect(played.style.transform).toBe(before)

    // Into bar 3: one re-render for the spoken value.
    emit(2.5)
    expect(root.getAttribute('aria-valuenow')).toBe('3')
    expect(root.getAttribute('aria-valuetext')).toBe('Bar 3 of 10')
    expect(describe.mock.calls.length).toBe(renders + 1)

    view.unmount()
    view = null
    expect(listeners.size).toBe(0)
  })

  describe('loop handles', () => {
    // 950 px wide: bars 0–3 are 100 px each, bar 4 is 400–450, bars 5–9 are 100 px from 450.
    const handle = (root: HTMLElement, edge: 'start' | 'end') =>
      root.querySelector<HTMLElement>(`[data-testid="overview-loop-${edge}"]`)

    it('appear only with onLoopChange and a loop', () => {
      const without = setup({ loop: { fromOcc: 2, toOcc: 3 } })
      expect(handle(without.root, 'start')).toBeNull()
      view!.unmount()
      const bare = setup({ onLoopChange: vi.fn() })
      expect(handle(bare.root, 'start')).toBeNull()
      view!.unmount()
      const { root } = setup({ loop: { fromOcc: 2, toOcc: 3 }, onLoopChange: vi.fn(), describe: (o) => `Bar ${o + 1}` })
      const start = handle(root, 'start')!
      const end = handle(root, 'end')!
      expect(start.getAttribute('aria-label')).toBe('Overview loop start')
      expect(start.getAttribute('role')).toBe('slider')
      expect(start.getAttribute('aria-valuetext')).toBe('Bar 3')
      expect(end.getAttribute('aria-label')).toBe('Overview loop end')
      expect(end.getAttribute('aria-valuetext')).toBe('Bar 4')
      expect(parseFloat(start.style.left)).toBeCloseTo((2 / 9.5) * 100, 4)
      expect(parseFloat(end.style.left)).toBeCloseTo((4 / 9.5) * 100, 4)
    })

    it('drag the end edge bar by bar, dropping its note-level end; a handle never seeks', async () => {
      const onLoopChange = vi.fn()
      const loop = { fromOcc: 1, toOcc: 3, start: rat(5, 4), end: rat(7, 2) }
      const { root, onScrub } = setup({ loop, onLoopChange })
      act(() => {
        handle(root, 'end')!.dispatchEvent(pointer('pointerdown', 350))
      })
      expect(onScrub).not.toHaveBeenCalled()
      expect(onLoopChange).not.toHaveBeenCalled()
      act(() => {
        root.dispatchEvent(pointer('pointermove', 500)) // bar 5
        root.dispatchEvent(pointer('pointermove', 620)) // bar 6
      })
      await nextFrame()
      expect(onLoopChange).toHaveBeenCalledTimes(1)
      expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 1, toOcc: 6, start: rat(5, 4) })
      act(() => {
        root.dispatchEvent(pointer('pointerup', 720)) // bar 7
      })
      expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 1, toOcc: 7, start: rat(5, 4) })
      expect(onScrub).not.toHaveBeenCalled()
    })

    it('clamp the start edge at the end edge', async () => {
      const onLoopChange = vi.fn()
      const { root } = setup({ loop: { fromOcc: 1, toOcc: 3 }, onLoopChange })
      act(() => {
        handle(root, 'start')!.dispatchEvent(pointer('pointerdown', 100))
        root.dispatchEvent(pointer('pointermove', 800))
      })
      await nextFrame()
      expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 3, toOcc: 3 })
      act(() => {
        root.dispatchEvent(pointer('pointerup', 900))
      })
      expect(onLoopChange).toHaveBeenCalledTimes(1) // same bar: nothing new on release
    })

    it('emit nothing for a tap that does not move', () => {
      const onLoopChange = vi.fn()
      const { root, onScrub } = setup({ loop: { fromOcc: 1, toOcc: 3, end: rat(7, 2) }, onLoopChange })
      act(() => {
        handle(root, 'end')!.dispatchEvent(pointer('pointerdown', 350))
        root.dispatchEvent(pointer('pointerup', 350))
      })
      expect(onLoopChange).not.toHaveBeenCalled()
      expect(onScrub).not.toHaveBeenCalled()
    })

    it('move an edge one bar with the arrow keys without seeking', () => {
      const onLoopChange = vi.fn()
      const { root, onScrub } = setup({ loop: { fromOcc: 2, toOcc: 4, start: rat(9, 4) }, onLoopChange })
      press(handle(root, 'end'), 'ArrowRight')
      expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 2, toOcc: 5, start: rat(9, 4) })
      press(handle(root, 'start'), 'ArrowRight')
      expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 3, toOcc: 4 })
      press(handle(root, 'start'), 'ArrowLeft') // a note-level start first snaps to its barline
      expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 2, toOcc: 4 })
      press(handle(root, 'start'), 'Home')
      expect(onScrub).not.toHaveBeenCalled()
    })

    it('stop at the other edge with the keyboard', () => {
      const onLoopChange = vi.fn()
      const { root } = setup({ loop: { fromOcc: 3, toOcc: 3 }, onLoopChange })
      press(handle(root, 'start'), 'ArrowRight')
      press(handle(root, 'end'), 'ArrowLeft')
      expect(onLoopChange).not.toHaveBeenCalled()
    })
  })

  it('renders an empty piece inertly', () => {
    view = mount(<ScoreOverview measures={[]} position={0} loop={null} onScrub={() => undefined} />)
    const root = $(view.container, '[role="slider"]')!
    expect(root.getAttribute('aria-valuetext')).toBe('No score')
    expect(root.getAttribute('aria-disabled')).toBe('true')
  })
})
