// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PracticeSession, SessionUi } from '../../app/session'
import { resetAppStateForTests, settings } from '../../app/state'
import type { PersistentLabelMode } from '../../core/model/settings'
import { $$, byText, click, mount, type Mounted } from '../shared/testing'
import { PracticeMenuItems, type MetronomeRow } from './FooterMenu'

let view: Mounted | null = null
afterEach(() => {
  view?.unmount()
  view = null
  resetAppStateForTests()
})

const UI = {
  playing: false,
  mode: 'wait',
  hands: 'both',
  keyboardVisible: false,
  follow: 'piano',
  pianoConnected: true,
  micSupported: true,
} as unknown as SessionUi

function render(
  metronome: MetronomeRow,
  onMetronome: (on: boolean) => void,
  ui: Partial<SessionUi> = {},
  session: Partial<PracticeSession> = {},
  labels: PersistentLabelMode = 'off',
  onNoteRules: () => void = () => undefined,
) {
  view = mount(
    <PracticeMenuItems
      ui={{ ...UI, ...ui }}
      session={session as PracticeSession}
      labels={labels}
      onLabels={() => undefined}
      onNoteRules={onNoteRules}
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

describe('PracticeMenuItems rows (U141)', () => {
  const rows = () =>
    [...view!.container.children].map(
      (row) =>
        row.textContent?.match(
          /Note names|Playback|Follow input|Metronome|Show keys|Record performance|Keep time/,
        )?.[0],
    )
  const show = (ui: Partial<SessionUi>) => {
    view?.unmount()
    render({ on: false, disabled: false }, () => undefined, ui)
    return rows()
  }

  it('offers Playback in Keep time and Follow input in Follow, and no Keep time switch', () => {
    expect(show({ mode: 'listen' })).toEqual(['Note names', 'Metronome', 'Show keys'])
    expect(show({ mode: 'wait' })).toEqual(['Note names', 'Metronome', 'Show keys'])
    expect(show({ mode: 'time' })).toEqual(['Note names', 'Playback', 'Metronome', 'Show keys'])
    expect(show({ mode: 'follow' })).toEqual(['Note names', 'Follow input', 'Metronome', 'Show keys'])
    // Keep time cannot run without a piano, and a browser without a microphone has no choice of input.
    expect(show({ mode: 'time', pianoConnected: false })).toEqual(['Note names', 'Metronome', 'Show keys'])
    expect(show({ mode: 'follow', micSupported: false })).toEqual(['Note names', 'Metronome', 'Show keys'])
  })

  it('offers the Note names rules in Conditional only (U143)', () => {
    const onNoteRules = vi.fn()
    render({ on: false, disabled: false }, () => undefined, {}, {}, 'all', onNoteRules)
    const link = () => byText(view!.container, 'Choose which notes')!
    expect(link().closest('[inert]')).not.toBeNull()
    view?.unmount()
    render({ on: false, disabled: false }, () => undefined, {}, {}, 'conditional', onNoteRules)
    expect(link().closest('[inert]')).toBeNull()
    click(link())
    expect(onNoteRules).toHaveBeenCalledOnce()
  })

  it('chooses what Follow follows; without a piano only the microphone', () => {
    show({ mode: 'follow' })
    const input = $$(view!.container, '[aria-label="Follow input"]')[0]!
    const option = (name: string) =>
      $$(input, '[role="radio"]').find((el) => el.textContent === name) as HTMLButtonElement
    expect(option('Piano').getAttribute('aria-checked')).toBe('true')
    click(option('Microphone'))
    expect(settings.value.mic.follow).toBe(true)
    show({ mode: 'follow', follow: 'mic', pianoConnected: false })
    const only = $$(view!.container, '[aria-label="Follow input"]')[0]!
    const piano = $$(only, '[role="radio"]').find((el) => el.textContent === 'Piano') as HTMLButtonElement
    expect([piano.disabled, piano.title]).toEqual([true, 'Piano not connected'])
  })
})
