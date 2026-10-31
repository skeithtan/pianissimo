// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { byLabel, click, mount, type Mounted } from '../views/shared/testing'
import { LoopSteppers } from './LoopSteppers'
import type { LoopRange } from './loopStep'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

function setup(loop: LoopRange | null, currentOcc: number, extra: { disabled?: boolean } = {}) {
  const onLoopChange = vi.fn()
  view = mount(<LoopSteppers loop={loop} currentOcc={currentOcc} lastOcc={58} onLoopChange={onLoopChange} {...extra} />)
  const button = (name: string) => byLabel(view!.container, name) as HTMLButtonElement
  return { onLoopChange, button, root: view.container }
}

const NAMES = [
  'Move loop start one bar earlier',
  'Move loop start one bar later',
  'Move loop end one bar earlier',
  'Move loop end one bar later',
] as const

describe('<LoopSteppers>', () => {
  it('has four labeled buttons and two groups', () => {
    const { button, root } = setup({ fromOcc: 5, toOcc: 9 }, 7)
    for (const name of NAMES) expect(button(name)).not.toBeNull()
    expect(root.querySelectorAll('[role="group"]')).toHaveLength(2)
    expect(root.textContent).toContain('Bar 6')
    expect(root.textContent).toContain('Bar 10')
  })

  it('with no loop enables only the outward buttons', () => {
    const { button } = setup(null, 10)
    expect(button(NAMES[0]).disabled).toBe(false)
    expect(button(NAMES[1]).disabled).toBe(true)
    expect(button(NAMES[2]).disabled).toBe(true)
    expect(button(NAMES[3]).disabled).toBe(false)
  })

  it('with no loop, "start earlier" creates [current - 1, current]', () => {
    const { button, onLoopChange } = setup(null, 10)
    click(button(NAMES[0]))
    expect(onLoopChange).toHaveBeenCalledWith({ fromOcc: 9, toOcc: 10 })
  })

  it('with no loop, "end later" creates [current, current + 1]', () => {
    const { button, onLoopChange } = setup(null, 10)
    click(button(NAMES[3]))
    expect(onLoopChange).toHaveBeenCalledWith({ fromOcc: 10, toOcc: 11 })
  })

  it('disables the outward button that would leave the piece', () => {
    expect(setup(null, 0).button(NAMES[0]).disabled).toBe(true)
    view?.unmount()
    expect(setup(null, 58).button(NAMES[3]).disabled).toBe(true)
  })

  it('with a loop moves each edge by one bar', () => {
    const { button, onLoopChange } = setup({ fromOcc: 5, toOcc: 9 }, 7)
    click(button(NAMES[0]))
    expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 4, toOcc: 9 })
    click(button(NAMES[1]))
    expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 6, toOcc: 9 })
    click(button(NAMES[2]))
    expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 5, toOcc: 8 })
    click(button(NAMES[3]))
    expect(onLoopChange).toHaveBeenLastCalledWith({ fromOcc: 5, toOcc: 10 })
  })

  it('keeps a one-bar minimum', () => {
    const { button } = setup({ fromOcc: 7, toOcc: 7 }, 7)
    expect(button(NAMES[1]).disabled).toBe(true)
    expect(button(NAMES[2]).disabled).toBe(true)
    expect(button(NAMES[0]).disabled).toBe(false)
    expect(button(NAMES[3]).disabled).toBe(false)
  })

  it('disables everything while disabled', () => {
    const { button } = setup({ fromOcc: 5, toOcc: 9 }, 7, { disabled: true })
    for (const name of NAMES) expect(button(name).disabled).toBe(true)
  })

  it('formats bar labels with a custom function', () => {
    const onLoopChange = vi.fn()
    view = mount(
      <LoopSteppers
        loop={{ fromOcc: 2, toOcc: 4 }}
        currentOcc={3}
        lastOcc={58}
        onLoopChange={onLoopChange}
        barLabel={(occ) => `m. ${occ + 10}`}
      />,
    )
    expect(view.container.textContent).toContain('m. 12')
    expect(view.container.textContent).toContain('m. 14')
  })
})
