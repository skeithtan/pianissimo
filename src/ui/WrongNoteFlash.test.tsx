// @vitest-environment happy-dom
import { signal } from '@preact/signals'
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'preact/test-utils'
import { mount, type Mounted } from '../views/shared/testing'
import { FlashDriver } from './flashDriver'
import { envelopeEnd, hitEnvelope } from './flashEnvelope'
import { WrongNoteFlash, type WrongNoteFlashHandle } from './WrongNoteFlash'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

/** A driver on a manual clock and frame queue. */
function rig(options: { reduced?: boolean } = {}) {
  let time = 0
  let queued: (() => void) | null = null
  const overlay = document.createElement('div')
  const driver = new FlashDriver({
    overlay,
    now: () => time,
    reducedMotion: () => options.reduced === true,
    requestFrame: (cb) => {
      queued = cb
      return 1
    },
    cancelFrame: () => {
      queued = null
    },
  })
  const advance = (ms: number) => {
    time += ms
    const run = queued
    queued = null
    run?.()
  }
  return { driver, overlay, advance, now: () => time, frameQueued: () => queued !== null }
}

describe('FlashDriver', () => {
  it('writes the opacity from the envelope and stops its loop when finished', () => {
    const { driver, overlay, advance, frameQueued } = rig()
    driver.hit(0)
    expect(overlay.style.opacity).toBe('0')
    advance(60)
    expect(Number(overlay.style.opacity)).toBe(1)
    advance(150)
    const mid = Number(overlay.style.opacity)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    advance(300)
    expect(overlay.style.opacity).toBe('0')
    expect(frameQueued()).toBe(false)
  })

  it('a soft hit is gentler and does not lift a running full flash', () => {
    const { driver, overlay, advance, frameQueued } = rig()
    driver.hit(0, undefined, { soft: true })
    advance(60)
    expect(Number(overlay.style.opacity)).toBeCloseTo(0.35, 3)
    advance(400)
    expect(overlay.style.opacity).toBe('0')
    expect(frameQueued()).toBe(false)
    advance(540) // t = 1000
    driver.hit(1000)
    advance(60) // full peak
    expect(Number(overlay.style.opacity)).toBe(1)
    driver.hit(1060, undefined, { soft: true })
    expect(driver.intensity).toBe(1)
    advance(100)
    expect(driver.intensity).toBeLessThan(1)
    expect(driver.intensity).toBeGreaterThan(0.35)
  })

  it('extends on a repeat: intensity continues from its current value and the decay moves later', () => {
    const { driver, overlay, advance, now } = rig()
    driver.hit(0)
    advance(200)
    const before = Number(overlay.style.opacity)
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(1)
    driver.hit(now())
    expect(Number(overlay.style.opacity)).toBeCloseTo(before, 3) // no drop to zero
    advance(30)
    expect(Number(overlay.style.opacity)).toBeGreaterThan(0.95)
    // The first hit alone would have ended at ~320 ms; the repeat keeps the flash alive past it.
    advance(100)
    expect(Number(overlay.style.opacity)).toBeGreaterThan(0)
    expect(envelopeEnd(hitEnvelope(null, 0))).toBeLessThan(360)
  })

  it('honors the engine feedback deadline', () => {
    const { driver, overlay, advance } = rig()
    driver.hit(0, 1000)
    advance(700)
    expect(Number(overlay.style.opacity)).toBe(1)
    advance(300)
    expect(overlay.style.opacity).toBe('0')
  })

  it('uses the plain fade under reduced motion', () => {
    const { driver, overlay, advance } = rig({ reduced: true })
    driver.hit(0)
    advance(80)
    expect(Number(overlay.style.opacity)).toBe(1)
    advance(400)
    expect(overlay.style.opacity).toBe('0')
  })

  it('clear removes the flash immediately', () => {
    const { driver, overlay, advance } = rig()
    driver.hit(0)
    advance(30)
    driver.clear()
    expect(overlay.style.opacity).toBe('0')
  })
})

describe('<WrongNoteFlash>', () => {
  it('is a pointer-inert, hidden decoration', () => {
    view = mount(<WrongNoteFlash />)
    const overlay = view.container.querySelector('[data-testid="wrong-note-flash"]')
    expect(overlay?.getAttribute('aria-hidden')).toBe('true')
  })

  it('flashes when the trigger counter increases and not on first render', async () => {
    const trigger = signal(0)
    view = mount(<WrongNoteFlash trigger={trigger} />)
    const overlay = view.container.querySelector<HTMLElement>('[data-testid="wrong-note-flash"]')!
    expect(overlay.style.opacity === '' || overlay.style.opacity === '0').toBe(true)
    act(() => {
      trigger.value = 1
    })
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(Number(overlay.style.opacity)).toBeGreaterThan(0)
  })

  it('exposes an imperative handle', async () => {
    let handle: WrongNoteFlashHandle | null = null
    view = mount(<WrongNoteFlash onReady={(h) => (handle = h)} />)
    const overlay = view.container.querySelector<HTMLElement>('[data-testid="wrong-note-flash"]')!
    act(() => handle!.hit(performance.now()))
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(Number(overlay.style.opacity)).toBeGreaterThan(0)
    act(() => handle!.clear())
    expect(overlay.style.opacity).toBe('0')
  })
})
