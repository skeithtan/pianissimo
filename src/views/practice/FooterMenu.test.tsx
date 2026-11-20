// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PracticeSession, SessionUi } from '../../app/session'
import { $$, click, mount, type Mounted } from '../shared/testing'
import { PracticeMenuItems, type MetronomeRow } from './FooterMenu'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
})

const UI = {
  playing: false,
  hands: 'both',
  handsAvailable: true,
  rhythm: false,
  playThrough: false,
  keyboardVisible: false,
  follow: 'piano',
  pianoConnected: true,
  micSupported: true,
  playThroughLocked: false,
} as unknown as SessionUi

function render(
  metronome: MetronomeRow,
  onMetronome: (on: boolean) => void,
  ui: Partial<SessionUi> = {},
  session: Partial<PracticeSession> = {},
) {
  view = mount(
    <PracticeMenuItems
      ui={{ ...UI, ...ui }}
      session={session as PracticeSession}
      labels="off"
      onLabels={() => undefined}
      hasTempo
      scorePlayback={{ on: false, volume: 1, onToggle: () => undefined, onVolume: () => undefined }}
      metronome={metronome}
      onMetronome={onMetronome}
      rowClass={undefined}
      labelClass={undefined}
      toggleClass={undefined}
    />,
  )
  const row = $$(view.container, 'label').find((el) => el.textContent?.trim().startsWith('Metronome'))!
  return { row, input: row.querySelector<HTMLInputElement>('input[role="switch"]')! }
}

describe('PracticeMenuItems Metronome row (U87, P20)', () => {
  it('renders the state it is given and reports a change', () => {
    const onMetronome = vi.fn()
    const { row, input } = render({ on: false, disabled: false }, onMetronome)
    expect(input.checked).toBe(false)
    expect(input.disabled).toBe(false)
    expect(row.querySelector('small')).toBeNull()
    click(input)
    expect(onMetronome).toHaveBeenCalledWith(true)
  })

  it('shows the muted state: disabled, unchecked, with its description', () => {
    const { row, input } = render(
      { on: false, disabled: true, note: 'Silent while the microphone follows.' },
      () => undefined,
    )
    expect(input.disabled).toBe(true)
    expect(input.checked).toBe(false)
    expect(row.querySelector('small')?.textContent).toBe('Silent while the microphone follows.')
  })
})

it('disables Keep time without a connected piano and explains why', () => {
  render({ on: false, disabled: false }, () => undefined, { pianoConnected: false })
  const row = $$(view!.container, 'label').find((el) => el.textContent?.startsWith('Keep time'))!
  expect(row.querySelector<HTMLInputElement>('input')?.disabled).toBe(true)
  expect(row.querySelector('small')?.textContent).toContain('Needs a connected piano.')
})
