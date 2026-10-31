// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandSelection } from '../core/model/score'
import { byLabel, click, mount, type Mounted } from '../views/shared/testing'
import { HandToggles, handsFromToggles, playButtonLabel } from './HandToggles'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

function setup(hands: HandSelection, extra: Partial<Parameters<typeof HandToggles>[0]> = {}) {
  const onHandsChange = vi.fn()
  const onPlayPause = vi.fn()
  view = mount(
    <HandToggles hands={hands} onHandsChange={onHandsChange} playing={false} onPlayPause={onPlayPause} {...extra} />,
  )
  return { onHandsChange, onPlayPause, root: view.container }
}

describe('hand selection mapping', () => {
  it('maps toggle pairs to a selection', () => {
    expect(handsFromToggles(true, true)).toBe('both')
    expect(handsFromToggles(true, false)).toBe('left')
    expect(handsFromToggles(false, true)).toBe('right')
    expect(handsFromToggles(false, false)).toBe('none')
  })

  it('labels the primary button Start, Pause or Listen', () => {
    expect(playButtonLabel('both', false)).toBe('Start')
    expect(playButtonLabel('right', false)).toBe('Start')
    expect(playButtonLabel('none', false)).toBe('Listen')
    expect(playButtonLabel('none', true)).toBe('Pause')
    expect(playButtonLabel('both', true)).toBe('Pause')
  })
})

describe('<HandToggles>', () => {
  it.each([
    ['both', 'true', 'true'],
    ['left', 'true', 'false'],
    ['right', 'false', 'true'],
    ['none', 'false', 'false'],
  ] as const)('reflects %s in aria-pressed', (hands, left, right) => {
    const { root } = setup(hands)
    expect(byLabel(root, 'Left hand')?.getAttribute('aria-pressed')).toBe(left)
    expect(byLabel(root, 'Right hand')?.getAttribute('aria-pressed')).toBe(right)
  })

  it('turns hands on and off into the four selections', () => {
    let { onHandsChange, root } = setup('both')
    click(byLabel(root, 'Left hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('right')
    click(byLabel(root, 'Right hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('left')
    view?.unmount()

    ;({ onHandsChange, root } = setup('right'))
    click(byLabel(root, 'Right hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('none')
    click(byLabel(root, 'Left hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('both')
    view?.unmount()

    ;({ onHandsChange, root } = setup('none'))
    click(byLabel(root, 'Left hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('left')
    click(byLabel(root, 'Right hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('right')
  })

  it('shows a visible L / R cue and says who plays each hand, with no caption (U12)', () => {
    const { root } = setup('right', { handClass: 'fades' })
    expect(root.textContent).toBe('LR')
    expect(byLabel(root, 'Right hand')?.getAttribute('title')).toBe('Right hand: you play it')
    expect(byLabel(root, 'Left hand')?.getAttribute('title')).toBe('Left hand: the piano plays it')
    expect(root.querySelector('[role="status"]')).toBeNull()
    // The extra class goes on the hand toggles only, never on the main button.
    expect(root.querySelectorAll('.fades')).toHaveLength(2)
    expect(byLabel(root, 'Start')?.classList.contains('fades')).toBe(false)
  })

  it('runs the primary action with the right label', () => {
    const { onPlayPause, root } = setup('none')
    click(byLabel(root, 'Listen'))
    expect(onPlayPause).toHaveBeenCalledOnce()
    view?.rerender(<HandToggles hands="both" onHandsChange={() => undefined} playing onPlayPause={onPlayPause} />)
    expect(byLabel(root, 'Pause')).not.toBeNull()
    view?.rerender(
      <HandToggles
        hands="both"
        onHandsChange={() => undefined}
        playing={false}
        onPlayPause={onPlayPause}
        playLabel="Resume"
      />,
    )
    expect(byLabel(root, 'Resume')).not.toBeNull()
  })

  it('disables the hand toggles and the primary button independently', () => {
    const { root } = setup('both', { handsDisabled: true })
    expect((byLabel(root, 'Left hand') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Right hand') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Start') as HTMLButtonElement).disabled).toBe(false)
    view?.rerender(
      <HandToggles
        hands="both"
        onHandsChange={() => undefined}
        playing={false}
        onPlayPause={() => undefined}
        playDisabled
      />,
    )
    expect((byLabel(root, 'Start') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Left hand') as HTMLButtonElement).disabled).toBe(false)
  })

  it('unavailable hands show off, carry the reason, and a tap explains instead of toggling', () => {
    const onHandsUnavailable = vi.fn()
    const { root, onHandsChange } = setup('both', { handsUnavailable: 'Piano not connected', onHandsUnavailable })
    const left = byLabel(root, 'Left hand') as HTMLButtonElement
    expect(left.getAttribute('aria-pressed')).toBe('false')
    expect(byLabel(root, 'Right hand')?.getAttribute('aria-pressed')).toBe('false')
    expect(left.getAttribute('aria-disabled')).toBe('true')
    expect(left.disabled).toBe(false)
    expect(left.title).toBe('Left hand: Piano not connected')
    click(left)
    expect(onHandsChange).not.toHaveBeenCalled()
    expect(onHandsUnavailable).toHaveBeenCalledTimes(1)
  })
})
