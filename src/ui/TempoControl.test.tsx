// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { rat } from '../core/music/rational'
import { $, $$, byLabel, byText, click, mount, press, type, type Mounted } from '../views/shared/testing'
import { TempoControl, type TempoControlProps } from './TempoControl'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
  vi.useRealTimers()
})

function setup(props: Partial<TempoControlProps> = {}) {
  const onChange = vi.fn()
  const full: TempoControlProps = { multiplier: 1, sourceBeatBpm: 72, beatUnit: rat(1, 4), onChange, ...props }
  view = mount(<TempoControl {...full} />)
  return { onChange, root: view.container, props: full }
}

const pointerEvent = (type: string) => new PointerEvent(type, { button: 0, pointerId: 1, bubbles: true })

describe('<TempoControl> display', () => {
  it('shows the percentage and the effective tempo with its beat unit', () => {
    const { root } = setup({ multiplier: 0.75, sourceBeatBpm: 72 })
    expect(root.textContent).toContain('75%')
    expect(root.textContent).toContain('= 54')
    expect(root.querySelector('svg[aria-label="quarter"]')).not.toBeNull()
  })

  it('draws a dotted quarter for compound meters', () => {
    const { root } = setup({ multiplier: 1, sourceBeatBpm: 60, beatUnit: rat(3, 8) })
    expect(root.textContent).toContain('100%')
    expect(root.textContent).toContain('= 60')
    const icon = root.querySelector('svg[aria-label="dotted quarter"]')
    expect(icon?.querySelector('circle')).not.toBeNull()
  })

  it('shows Set tempo… instead of a speed when the score has no tempo', () => {
    const onRequestTempo = vi.fn()
    const { root } = setup({ noTempo: true, onRequestTempo })
    expect(root.textContent).toContain('Set tempo')
    expect((byLabel(root, 'Slower by 5 percent') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Faster by 5 percent') as HTMLButtonElement).disabled).toBe(true)
    click(byText(root, 'Set tempo…')!.closest('button'))
    expect(onRequestTempo).toHaveBeenCalledOnce()
  })

  it('disables everything while disabled', () => {
    const { root } = setup({ disabled: true })
    expect((byLabel(root, 'Slower by 5 percent') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Faster by 5 percent') as HTMLButtonElement).disabled).toBe(true)
    expect((root.querySelector('[aria-haspopup]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('<TempoControl> stepping', () => {
  it('steps by five points with the keyboard / click', () => {
    const { root, onChange } = setup({ multiplier: 1 })
    click(byLabel(root, 'Faster by 5 percent'))
    expect(onChange).toHaveBeenLastCalledWith(1.05)
    click(byLabel(root, 'Slower by 5 percent'))
    expect(onChange).toHaveBeenLastCalledWith(0.95)
  })

  it('moves an off-grid value to the next grid value', () => {
    const { root, onChange } = setup({ multiplier: 0.62 })
    click(byLabel(root, 'Faster by 5 percent'))
    expect(onChange).toHaveBeenLastCalledWith(0.65)
    click(byLabel(root, 'Slower by 5 percent'))
    expect(onChange).toHaveBeenLastCalledWith(0.6)
  })

  it('disables the buttons at the limits', () => {
    expect((byLabel(setup({ multiplier: 0.05 }).root, 'Slower by 5 percent') as HTMLButtonElement).disabled).toBe(true)
    view?.unmount()
    expect((byLabel(setup({ multiplier: 4 }).root, 'Faster by 5 percent') as HTMLButtonElement).disabled).toBe(true)
  })

  it('repeats while held, after a delay', () => {
    vi.useFakeTimers()
    let multiplier = 1
    const onChange = vi.fn((m: number) => {
      multiplier = m
    })
    view = mount(<TempoControl multiplier={multiplier} sourceBeatBpm={72} beatUnit={rat(1, 4)} onChange={onChange} />)
    const plus = byLabel(view.container, 'Faster by 5 percent')!
    act(() => {
      plus.dispatchEvent(pointerEvent('pointerdown'))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onChange).toHaveBeenCalledTimes(1) // still within the hold delay
    // Re-render with the updated speed, as the parent would, then let the repeat run.
    view.rerender(<TempoControl multiplier={multiplier} sourceBeatBpm={72} beatUnit={rat(1, 4)} onChange={onChange} />)
    act(() => {
      vi.advanceTimersByTime(100 + 90)
    })
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2)
    act(() => {
      plus.dispatchEvent(pointerEvent('pointerup'))
    })
    const calls = onChange.mock.calls.length
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onChange).toHaveBeenCalledTimes(calls) // released: no more repeats
  })

  it('a pointer press does not also step on the click that follows it', () => {
    const { root, onChange } = setup({ multiplier: 1 })
    const plus = byLabel(root, 'Faster by 5 percent')!
    act(() => {
      plus.dispatchEvent(pointerEvent('pointerdown'))
      plus.dispatchEvent(pointerEvent('pointerup'))
      plus.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('<TempoControl> speed options', () => {
  const open = (root: HTMLElement) => click(root.querySelector('[aria-haspopup]'))

  it('keeps the popover on screen: shifts it from the right edge and flips it up near the bottom', () => {
    const restore: Array<() => void> = []
    const stub = (name: 'offsetWidth' | 'scrollHeight', value: number) => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value })
      restore.push(() => (original ? Object.defineProperty(HTMLElement.prototype, name, original) : undefined))
    }
    stub('offsetWidth', 336)
    stub('scrollHeight', 420)
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(360)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(740)
    const anchor = { left: 140, top: 600, width: 208, height: 56 }
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ ...anchor, right: 348, bottom: 656, x: 140, y: 600, toJSON: () => anchor } as DOMRect)
    try {
      const { root } = setup()
      open(root)
      const dialog = $(root, '[role="dialog"]')!
      expect(dialog.dataset['side']).toBe('up')
      const left = 140 + parseFloat(dialog.style.left)
      expect(left).toBeGreaterThanOrEqual(12)
      expect(left + 336).toBeLessThanOrEqual(360 - 12)
    } finally {
      rect.mockRestore()
      vi.restoreAllMocks()
      for (const undo of restore) undo()
    }
  })

  it('opens a dialog with the presets and marks the current one', () => {
    const { root, onChange } = setup({ multiplier: 0.75 })
    open(root)
    const dialog = $(root, '[role="dialog"]')!
    expect(dialog).not.toBeNull()
    const presets = $$(dialog, '[aria-label="Speed presets"] button')
    expect(presets.map((b) => b.textContent)).toEqual(['50%', '75%', '100%', '125%', '150%', '200%'])
    expect(presets.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent).toBe('75%')
    click(presets[5]!)
    expect(onChange).toHaveBeenLastCalledWith(2)
  })

  it('has a slider that changes the speed', () => {
    const { root, onChange } = setup({ multiplier: 1 })
    open(root)
    const slider = $(root, 'input[type="range"]')!
    type(slider, '60')
    expect(onChange).toHaveBeenLastCalledWith(0.6)
  })

  it('accepts a custom multiplier or percentage', () => {
    const { root, onChange } = setup()
    open(root)
    const input = $(root, 'input[type="text"]')!
    type(input, '0.6')
    click(byLabel(root, 'Set'))
    expect(onChange).toHaveBeenLastCalledWith(0.6)
    type(input, '180%')
    click(byLabel(root, 'Set'))
    expect(onChange).toHaveBeenLastCalledWith(1.8)
    type(input, '1.8x')
    click(byLabel(root, 'Set'))
    expect(onChange).toHaveBeenLastCalledWith(1.8)
  })

  it('accepts a custom BPM and derives the multiplier from the source tempo', () => {
    const { root, onChange } = setup({ sourceBeatBpm: 72 })
    open(root)
    click(byLabel(root, 'BPM'))
    type($(root, 'input[type="text"]'), '54')
    click(byLabel(root, 'Set'))
    expect(onChange).toHaveBeenLastCalledWith(0.75)
  })

  it('rejects zero, negative, non-finite and unparseable values with an inline message', () => {
    const { root, onChange } = setup()
    open(root)
    for (const [text, message] of [
      ['0', /greater than zero/u],
      ['-1', /greater than zero/u],
      ['Infinity', /Could not read/u],
      ['fast', /Could not read/u],
      ['', /Enter a speed/u],
    ] as const) {
      type($(root, 'input[type="text"]'), text)
      click(byLabel(root, 'Set'))
      expect($(root, '[role="alert"]')?.textContent).toMatch(message)
    }
    expect(onChange).not.toHaveBeenCalled()
    type($(root, 'input[type="text"]'), '0.5')
    expect($(root, '[role="alert"]')).toBeNull() // editing clears the message
  })

  it('resets to the original tempo', () => {
    const { root, onChange } = setup({ multiplier: 1.4 })
    open(root)
    click(byLabel(root, 'Reset to original tempo'))
    expect(onChange).toHaveBeenLastCalledWith(1)
  })

  it('disables reset at the original tempo', () => {
    const { root } = setup({ multiplier: 1 })
    open(root)
    expect((byLabel(root, 'Reset to original tempo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes on Escape and on Done', () => {
    vi.useFakeTimers()
    const { root } = setup()
    open(root)
    expect($(root, '[role="dialog"]')).not.toBeNull()
    press($(root, '[role="dialog"] button'), 'Escape')
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect($(root, '[role="dialog"]')).toBeNull()
    open(root)
    click(byLabel(root, 'Done'))
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect($(root, '[role="dialog"]')).toBeNull()
  })

  beforeEach(() => {
    document.body.innerHTML = ''
  })
})
