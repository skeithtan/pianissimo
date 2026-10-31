// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { KeyboardGuide } from './KeyboardGuide'
import type { GuideKey, KeyboardGuideProps } from './types'

let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  render(null, host)
  host.remove()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

async function mount(props: KeyboardGuideProps): Promise<void> {
  await act(() => {
    render(<KeyboardGuide {...props} />, host)
  })
}

/** happy-dom has no layout: pretend the panel is this many CSS pixels wide. */
function setPanelWidth(width: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
}

const root = () => host.querySelector<HTMLElement>('[data-part="keyboard-guide"]')!
const bar = (midi: number) => host.querySelector<SVGElement>(`[data-part="bar"][data-midi="${midi}"]`)
const bars = () => host.querySelectorAll('[data-part="bar"]')
const labelTexts = () => [...host.querySelectorAll('[data-part="label"]')].map((l) => l.textContent ?? '')

const key = (midi: number, state: GuideKey['state'], label: string, extra: Partial<GuideKey> = {}): GuideKey => ({
  midi,
  state,
  hand: midi < 60 ? 'L' : 'R',
  label,
  held: false,
  ...extra,
})

describe('KeyboardGuide', () => {
  it('always draws the whole 88-key piano, A0 to C8', async () => {
    await mount({ keys: [] })
    expect(host.querySelectorAll('[data-part="white-keys"] rect')).toHaveLength(52)
    expect(host.querySelectorAll('[data-part="black-keys"] rect')).toHaveLength(36)
    expect(host.querySelector('[data-part="white-keys"] rect[data-midi="21"]')).not.toBeNull()
    expect(host.querySelector('[data-part="white-keys"] rect[data-midi="108"]')).not.toBeNull()
    expect(root().getAttribute('aria-label')).toBe('Keyboard guide. No keys to play.')
  })

  it('puts a translucent bar in the part color and the note name above every highlighted key, with no hand letter', async () => {
    await mount({ keys: [key(48, 'sounding', 'C3'), key(60, 'target', 'C4'), key(63, 'target', 'E♭4')] })
    expect(bars()).toHaveLength(3)
    expect(bar(48)?.getAttribute('data-hand')).toBe('L')
    expect(bar(60)?.getAttribute('data-hand')).toBe('R')
    expect(bar(60)?.getAttribute('data-state')).toBe('target')
    // A black key's bar is drawn over the black keys; a white key's bar under them.
    expect(bar(63)?.closest('[data-part="black-bars"]')).not.toBeNull()
    expect(bar(60)?.closest('[data-part="white-bars"]')).not.toBeNull()
    expect(labelTexts()).toEqual(['C3', 'C4', 'E♭4'])
    expect(host.textContent).not.toMatch(/\b[LR]\b/u)
    expect(root().getAttribute('aria-label')).toBe('Keyboard guide. Play: C4, E♭4. Sounding: C3.')
  })

  it('marks played, held and wrong keys with shapes, not color alone', async () => {
    await mount({
      keys: [
        key(60, 'accepted', 'C4', { held: true }),
        key(62, 'wrong', 'D4', { hand: null, held: true }),
        key(64, 'held', 'E4', { hand: null, held: true }),
      ],
    })
    expect(host.querySelectorAll('[data-marker="held"]')).toHaveLength(3)
    const label = (midi: number) => host.querySelector(`[data-part="label"][data-midi="${midi}"]`)!
    expect(label(60).getAttribute('data-state')).toBe('accepted')
    expect(label(60).querySelectorAll('path')).toHaveLength(2) // leader + tick
    expect(label(62).querySelectorAll('path')).toHaveLength(2) // leader + cross
    expect(label(64).querySelectorAll('path')).toHaveLength(1) // leader only
    expect(bar(62)?.getAttribute('data-hand')).toBe('N')
    expect(root().getAttribute('aria-label')).toBe('Keyboard guide. Played: C4. Held: E4. Wrong keys held: D4.')
  })

  it('stacks the names of a dense cluster into lanes so they never cover each other on a phone', async () => {
    setPanelWidth(340)
    const cluster = [60, 61, 62, 63, 64].map((m) => key(m, 'target', `X${m}`))
    await mount({ keys: cluster })
    const chips = [...host.querySelectorAll('[data-part="label"] rect')].map((r) => ({
      x: Number(r.getAttribute('x')),
      y: Number(r.getAttribute('y')),
      w: Number(r.getAttribute('width')),
    }))
    expect(chips).toHaveLength(5)
    for (const [i, a] of chips.entries()) {
      expect(a.x).toBeGreaterThanOrEqual(0)
      expect(a.x + a.w).toBeLessThanOrEqual(340 + 1e-6)
      for (const b of chips.slice(i + 1)) {
        if (a.y === b.y) expect(a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true)
      }
    }
    expect(new Set(chips.map((c) => c.y)).size).toBeGreaterThan(1)
  })

  it('shows the roll direction for a marked arpeggio', async () => {
    await mount({ keys: [key(60, 'target', 'C4'), key(67, 'target', 'G4')], rollDirection: 'down' })
    expect(host.querySelector('[data-part="roll"]')?.getAttribute('data-direction')).toBe('down')
    expect(root().getAttribute('aria-label')).toContain('Roll downward, high to low.')
  })

  it('names only middle C when the keys are too narrow for every octave landmark, and follows fixed do', async () => {
    setPanelWidth(340)
    await mount({ keys: [], naming: { ...DEFAULT_SETTINGS.naming, system: 'fixed-do' } })
    expect([...host.querySelectorAll('[data-part="landmark"]')].map((t) => t.textContent)).toEqual(['do4'])
    render(null, host)
    setPanelWidth(1150)
    await mount({ keys: [] })
    expect([...host.querySelectorAll('[data-part="landmark"]')].map((t) => t.textContent)).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
    ])
  })

  it('updates only the highlights: the plain keys are the same elements after a change', async () => {
    await mount({ keys: [key(60, 'target', 'C4')] })
    const c4 = host.querySelector('[data-part="white-keys"] rect[data-midi="60"]')
    await mount({ keys: [key(62, 'target', 'D4', { held: true })] })
    expect(host.querySelector('[data-part="white-keys"] rect[data-midi="60"]')).toBe(c4)
    expect(bar(60)).toBeNull()
    expect(bar(62)).not.toBeNull()
  })

  it('fades out when hidden and stays mounted', async () => {
    await mount({ keys: [], visible: false, fadeMs: 250 })
    expect(root().style.opacity).toBe('0')
    expect(root().getAttribute('aria-hidden')).toBe('true')
    expect(root().style.transition).toContain('250ms')
  })
})
