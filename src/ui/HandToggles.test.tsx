// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LearnerHands } from '../core/model/score'
import { byLabel, click, mount, type Mounted } from '../views/shared/testing'
import { untranslatedText, usePseudoCatalog } from '../views/shared/catalogTesting'
import { msg } from '../i18n/messages'
import { HandToggles, toggledHands, type HandTogglesProps } from './HandToggles'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

const PROPS: HandTogglesProps = {
  hands: 'both',
  onHandsChange: () => undefined,
  onOnlyHand: () => undefined,
  onText: 'you play it',
  offText: 'the piano plays it',
  playing: false,
  onPlayPause: () => undefined,
  playLabel: 'Start',
}

function setup(hands: LearnerHands, extra: Partial<HandTogglesProps> = {}) {
  const onHandsChange = vi.fn()
  const onOnlyHand = vi.fn()
  const onPlayPause = vi.fn()
  view = mount(<HandToggles {...PROPS} {...{ hands, onHandsChange, onOnlyHand, onPlayPause }} {...extra} />)
  return { onHandsChange, onOnlyHand, onPlayPause, root: view.container }
}

it('a tap turns a hand off or on, except the only one on', () => {
  expect(toggledHands('both', 'left')).toBe('right')
  expect(toggledHands('both', 'right')).toBe('left')
  expect(toggledHands('left', 'right')).toBe('both')
  expect(toggledHands('right', 'left')).toBe('both')
  expect(toggledHands('left', 'left')).toBeNull()
  expect(toggledHands('right', 'right')).toBeNull()
})

describe('<HandToggles>', () => {
  it.each([
    ['both', 'true', 'true'],
    ['left', 'true', 'false'],
    ['right', 'false', 'true'],
  ] as const)('reflects %s in aria-pressed', (hands, left, right) => {
    const { root } = setup(hands)
    expect(byLabel(root, 'Left hand')?.getAttribute('aria-pressed')).toBe(left)
    expect(byLabel(root, 'Right hand')?.getAttribute('aria-pressed')).toBe(right)
  })

  it('turns hands on and off', () => {
    let { onHandsChange, root } = setup('both')
    click(byLabel(root, 'Left hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('right')
    click(byLabel(root, 'Right hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('left')
    view?.unmount()

    ;({ onHandsChange, root } = setup('right'))
    click(byLabel(root, 'Left hand'))
    expect(onHandsChange).toHaveBeenLastCalledWith('both')
  })

  it('a tap on the only lit hand leaves it on and says so (U141)', () => {
    const { onHandsChange, onOnlyHand, root } = setup('right')
    click(byLabel(root, 'Right hand'))
    expect(onHandsChange).not.toHaveBeenCalled()
    expect(onOnlyHand).toHaveBeenCalledOnce()
    expect(byLabel(root, 'Right hand')?.getAttribute('aria-pressed')).toBe('true')
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

  it('runs the primary action with the label it is given', () => {
    const { onPlayPause, root } = setup('both', { playLabel: 'Play' })
    click(byLabel(root, 'Play'))
    expect(onPlayPause).toHaveBeenCalledOnce()
    view?.rerender(<HandToggles {...PROPS} playing playLabel="Pause" />)
    expect(byLabel(root, 'Pause')).not.toBeNull()
    view?.rerender(<HandToggles {...PROPS} playLabel="Resume" />)
    expect(byLabel(root, 'Resume')).not.toBeNull()
  })

  it('disables the hand toggles and the primary button independently', () => {
    const { root } = setup('both', { handsDisabled: true })
    expect((byLabel(root, 'Left hand') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Right hand') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Start') as HTMLButtonElement).disabled).toBe(false)
    view?.rerender(<HandToggles {...PROPS} playDisabled />)
    expect((byLabel(root, 'Start') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel(root, 'Left hand') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('<HandToggles> translation coverage', () => {
  it('shows no text that bypasses the catalogs', () => {
    const restore = usePseudoCatalog()
    try {
      for (const hands of ['both', 'left', 'right'] as const) {
        const { root } = setup(hands, {
          onText: msg('you play it'),
          offText: msg('the piano plays it'),
          playLabel: msg('Start'),
        })
        expect(untranslatedText(root)).toEqual([])
        view?.unmount()
      }
    } finally {
      restore()
    }
  })
})
