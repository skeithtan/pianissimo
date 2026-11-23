// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  CARD_RADIUS,
  clearOfContent,
  joinMotion,
  MOTION_PROPERTIES,
  panelOpening,
  screenOpening,
  startMotion,
  steerMotion,
  type MotionStep,
  type PanelParts,
} from './resultMotion'

const el = (name: string) => {
  const node = document.createElement('div')
  node.dataset['name'] = name
  return node
}

function parts(): PanelParts {
  return {
    card: el('card'),
    panel: el('panel'),
    content: [el('content')],
    row: el('row'),
    summary: el('summary'),
    start: [el('badge'), el('text')],
    end: el('actions'),
    outline: ['tl', 'tr', 'bl', 'br', 'l', 'r'].map(el),
  }
}

const named = (steps: MotionStep[], name: string) =>
  steps.find((s) => (s.target as HTMLElement).dataset['name'] === name)!

// A 600 × 90 pill at the bottom of a 900 px card whose row is 60 px tall, under a 500 px panel.
const PILL = { left: 300, right: 900, top: 610, bottom: 700 }
const CARD = { left: 150, right: 1050, top: 640, bottom: 700 }
const PANEL_TOP = 141
const VIEW = { height: 800 }

describe('the result opening (P4)', () => {
  it('animates nothing that lays anything out', () => {
    const steps = [
      ...panelOpening(parts(), PILL, CARD, PANEL_TOP, VIEW),
      ...screenOpening(el('screen'), PILL, { left: 0, top: 0, right: 390, bottom: 844 }, 22),
    ]
    expect(steps.length).toBe(15)
    for (const step of steps)
      for (const frame of step.keyframes)
        for (const key of Object.keys(frame)) if (key !== 'offset') expect(MOTION_PROPERTIES.has(key), key).toBe(true)
  })

  it("starts the tablet card at the pill's rectangle and ends at its own", () => {
    const steps = panelOpening(parts(), PILL, CARD, PANEL_TOP, VIEW)
    // The panel rises from behind the row: at first only the pill's height above the row shows
    // (30 px, plus the 1 px it overlaps the row), clipped to the pill's sides.
    expect(named(steps, 'panel').keyframes[0]).toEqual({
      transform: 'translateY(calc(100% - 31px))',
      clipPath: `inset(0px 150px 0px 150px round ${CARD_RADIUS}px ${CARD_RADIUS}px 0px 0px)`,
    })
    expect(named(steps, 'panel').keyframes.at(-1)!['transform']).toBe('translateY(0px)')
    expect(named(steps, 'row').keyframes[0]!['clipPath']).toBe(
      `inset(-46px 150px 0px 150px round 0px 0px ${CARD_RADIUS}px ${CARD_RADIUS}px)`,
    )
    // The summary starts where it was in the pill: 30 px higher, its ends at the pill's edges.
    expect(named(steps, 'summary').keyframes[0]).toEqual({ transform: 'translateY(-30px)' })
    expect(named(steps, 'badge').keyframes[0]).toEqual({ transform: 'translateX(150px)' })
    expect(named(steps, 'actions').keyframes[0]).toMatchObject({ transform: 'translateX(-150px)', opacity: 0 })
    // The outline: the top corners travel with the top edge (from the pill's top to the panel's).
    expect(named(steps, 'tl').keyframes[0]!['transform']).toBe('translate(150px, 469px)')
    expect(named(steps, 'br').keyframes[0]!['transform']).toBe('translate(-150px, 0px)')
    // The sides grow from the pill's straight height (90 − 2 × 24) to the card's (559 − 2 × 24).
    expect(named(steps, 'l').keyframes[0]!['transform']).toBe(
      `translateX(150px) scaleY(${Math.round((42 / 511) * 1e4) / 1e4})`,
    )
    // Nothing shows below the card, or in its rounded bottom corners, while the panel rises behind the row.
    expect(named(steps, 'card').keyframes[0]!['clipPath']).toBe(
      `inset(-830px 150px 0px 150px round 0px 0px ${CARD_RADIUS}px ${CARD_RADIUS}px)`,
    )
    for (const step of steps) {
      const last = step.keyframes.at(-1)!
      if (last['transform'])
        expect(String(last['transform'])).toMatch(/^(translate[XY]?\((0px(, )?)+\)( scaleY\(1\))?)$/)
    }
  })

  it("starts the phone's full-screen panel at the pill, fading in over it", () => {
    const [step] = screenOpening(el('screen'), PILL, { left: 0, top: 0, right: 1200, bottom: 800 }, 22)
    expect(step!.keyframes[0]).toEqual({
      transform: 'translateY(610px)',
      clipPath: 'inset(0px 300px 710px 300px round 22px)',
      opacity: 0,
    })
    expect(step!.keyframes.at(-1)).toMatchObject({ transform: 'translateY(0px)', opacity: 1 })
  })

  it('shows no contents until the side clip is clear of their padding, on the clip’s own easing', () => {
    // A clip that starts 150 px inside the edges and opens to nothing reaches content 24 px inside
    // them until it has opened 23 px of the way back (1 px to spare).
    expect(clearOfContent(150, 24)).toBeCloseTo(1 - 23 / 150, 6)
    expect(clearOfContent(16, 24)).toBe(0) // it never reaches the content
    expect(clearOfContent(150, 0)).toBe(1) // content right at the edge waits for the end
    const steps = panelOpening(parts(), PILL, CARD, PANEL_TOP, VIEW, 24)
    const content = named(steps, 'content')
    expect(content.keyframes).toEqual([{ opacity: 0 }, { opacity: 0, offset: 0.8467 }, { opacity: 1 }])
    // The opening's own easing (the keyframe offset is a point of it, as the clip's values are).
    expect(content.easing).toBeUndefined()
    // At that point of the eased progress the clip is inside the contents' padding.
    const clipAt = 150 * (1 - 0.8467)
    expect(clipAt).toBeLessThanOrEqual(23.1)

    // A phone's panel: its surface fades in early, its header and details once they are clear.
    const header = el('header')
    const body = el('body')
    const phone = screenOpening(
      el('screen'),
      PILL,
      { left: 0, top: 0, right: 1200, bottom: 800 },
      22,
      [header, body],
      8,
    )
    expect(phone).toHaveLength(3)
    for (const name of ['header', 'body'])
      expect(named(phone, name).keyframes).toEqual([
        { opacity: 0 },
        { opacity: 0, offset: Math.round((1 - 7 / 300) * 1e4) / 1e4 },
        { opacity: 1 },
      ])
    // A pill as wide as the screen never cuts the contents: they follow the surface.
    const wide = { left: 4, right: 1196, top: 610, bottom: 700 }
    expect(
      screenOpening(el('screen'), wide, { left: 0, top: 0, right: 1200, bottom: 800 }, 22, [header], 8),
    ).toHaveLength(1)
  })

  it('folds back from wherever it is, quicker when asked, and leaves a finished opening alone', () => {
    const animation = () => ({ playbackRate: 1, play: vi.fn() }) as unknown as Animation
    const [a, b] = [animation(), animation()]
    steerMotion([a, b], false)
    expect(a.play).not.toHaveBeenCalled() // already playing forward (or finished open): untouched
    steerMotion([a, b], true)
    expect(a.playbackRate).toBe(-1)
    expect(a.play).toHaveBeenCalledOnce()
    steerMotion([a, b], true, 3)
    expect(b.playbackRate).toBe(-3)
    steerMotion([a, b], false)
    expect(a.playbackRate).toBe(1)
  })

  it('brings an element that appears while it runs in at the same point, direction and speed', () => {
    const target = el('late')
    const joined = { playbackRate: 1, currentTime: 0 } as unknown as Animation
    const animate = vi.fn(() => joined)
    target.animate = animate as unknown as Element['animate']
    const reference = { playbackRate: -3, currentTime: 280 } as unknown as Animation
    const keyframes = [{ opacity: 0 }, { opacity: 1 }]
    expect(joinMotion(target, keyframes, reference, 420, 'ease')).toBe(joined)
    expect(animate).toHaveBeenCalledWith(keyframes, { duration: 420, easing: 'ease', fill: 'backwards' })
    expect(joined.playbackRate).toBe(-3)
    expect(joined.currentTime).toBe(280)
    const plain = document.createElement('div')
    ;(plain as { animate?: unknown }).animate = undefined
    expect(joinMotion(plain, keyframes, reference, 420, 'ease')).toBeNull()
  })

  it('starts each step with its own timing, held at its first frame until it plays', () => {
    const target = el('x')
    const animate = vi.fn(() => ({}) as Animation)
    target.animate = animate as unknown as Element['animate']
    startMotion([{ target, keyframes: [{ opacity: 0 }, { opacity: 1 }], easing: 'linear' }], 420, 'ease')
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], {
      duration: 420,
      easing: 'linear',
      fill: 'backwards',
    })
  })
})
