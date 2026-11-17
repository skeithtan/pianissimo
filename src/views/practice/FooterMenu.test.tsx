// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PracticeSession, SessionUi } from '../../app/session'
import { $$, click, mount, type Mounted } from '../shared/testing'
import { settings } from '../../app/state'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { NO_PIANO_NOTE, ONE_HAND_MIC_NOTE, PracticeMenuItems, playThroughNote, type MetronomeRow } from './FooterMenu'

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

const OFF: MetronomeRow = { on: false, disabled: false }

function toggle(label: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = $$(view!.container, 'label').find((el) => el.querySelector('span > span')?.textContent === label)!
  return { row, input: row.querySelector<HTMLInputElement>('input[role="switch"]')! }
}

function segment(label: string): HTMLButtonElement | undefined {
  return $$(view!.container, '[role="radio"]').find((el) => el.textContent === label) as HTMLButtonElement | undefined
}

describe('PracticeMenuItems play-through rows (DECISIONS P22, U92)', () => {
  afterEach(() => {
    settings.value = DEFAULT_SETTINGS
  })

  it('a Follow choice next to Play through edits settings.mic.follow', () => {
    render(OFF, () => undefined)
    const group = $$(view!.container, '[role="radiogroup"]').find(
      (el) => el.getAttribute('aria-label') === 'Play through follows',
    )
    expect(group).toBeTruthy()
    expect(segment('Piano')!.getAttribute('aria-checked')).toBe('true')
    expect(segment('Piano')!.disabled).toBe(false)
    click(segment('Microphone'))
    expect(settings.value.mic.follow).toBe(true)
  })

  it('without a piano: Play through on and locked with its note, Piano unavailable, Keep time explains', () => {
    const setPlayThrough = vi.fn()
    render(
      OFF,
      () => undefined,
      { playThrough: true, playThroughLocked: true, follow: 'mic', pianoConnected: false },
      { setPlayThrough },
    )
    const play = toggle('Play through')
    expect(play.input.checked).toBe(true)
    expect(play.input.disabled).toBe(true)
    expect(play.row.querySelector('small')?.textContent).toBe(NO_PIANO_NOTE)
    expect(segment('Piano')!.disabled).toBe(true)
    expect(segment('Piano')!.title).toBe('Piano not connected')
    expect(segment('Microphone')!.getAttribute('aria-checked')).toBe('true')
    const keep = toggle('Keep time')
    expect(keep.input.disabled).toBe(true)
    expect(keep.row.querySelector('small')?.textContent).toBe('Needs a connected piano.')
  })

  it('hides the Follow choice when this browser cannot use a microphone', () => {
    render(OFF, () => undefined, { micSupported: false })
    expect(segment('Microphone')).toBeUndefined()
  })

  it('the note under Play through says what the microphone does', () => {
    const base = { playThrough: true, playThroughLocked: false, follow: 'mic', hands: 'both' } as const
    expect(playThroughNote(base)).toBeNull()
    expect(playThroughNote({ ...base, hands: 'right' })).toBe(ONE_HAND_MIC_NOTE)
    expect(playThroughNote({ ...base, follow: 'piano', hands: 'right' })).toBeNull()
    expect(playThroughNote({ ...base, playThroughLocked: true })).toBe(NO_PIANO_NOTE)
    expect(playThroughNote({ ...base, playThroughLocked: true, hands: 'left' })).toBe(
      `${NO_PIANO_NOTE} The other hand stays silent.`,
    )
    expect(playThroughNote({ ...base, playThrough: false })).toBeNull()
  })
})
