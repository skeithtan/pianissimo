// @vitest-environment happy-dom
import type { ComponentProps } from 'preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PracticeSession, SessionUi } from '../../app/session'
import { resetAppStateForTests } from '../../app/state'
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
  recording: Partial<ComponentProps<typeof PracticeMenuItems>> = {},
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
      {...recording}
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
      (row) => row.textContent?.match(/Note names|Playback|Metronome|Show keys|Record performance|Keep time/)?.[0],
    )
  const show = (ui: Partial<SessionUi>) => {
    view?.unmount()
    render({ on: false, disabled: false }, () => undefined, ui)
    return rows()
  }

  it('offers Playback in Keep time only, and no choice of input in Follow (P37)', () => {
    expect(show({ mode: 'listen' })).toEqual(['Note names', 'Metronome', 'Show keys'])
    expect(show({ mode: 'wait' })).toEqual(['Note names', 'Metronome', 'Show keys'])
    expect(show({ mode: 'time' })).toEqual(['Note names', 'Playback', 'Metronome', 'Show keys'])
    expect(show({ mode: 'follow' })).toEqual(['Note names', 'Metronome', 'Show keys'])
    // Keep time cannot run without a piano.
    expect(show({ mode: 'time', pianoConnected: false })).toEqual(['Note names', 'Metronome', 'Show keys'])
  })

  it('offers Recordings beside Record performance, and Stop and Discard in their place during a take', () => {
    const recordings = vi.fn()
    render({ on: false, disabled: false }, () => undefined, {}, {}, 'off', undefined, {
      onRecord: () => undefined,
      onRecordings: recordings,
    })
    click(byText(view!.container, 'Recordings'))
    expect(recordings).toHaveBeenCalledOnce()
    expect(byText(view!.container, 'Discard recording')).toBeNull()
    view?.unmount()

    const stop = vi.fn()
    const discard = vi.fn()
    render({ on: false, disabled: false }, () => undefined, {}, {}, 'off', undefined, {
      onRecord: () => undefined,
      recordDisabled: true,
      onStopRecording: stop,
      onDiscardRecording: discard,
    })
    expect(byText(view!.container, 'Record performance')).toBeNull()
    expect(byText(view!.container, 'Recordings')).toBeNull()
    click(byText(view!.container, 'Stop recording'))
    expect(stop).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
    click(byText(view!.container, 'Discard recording'))
    expect(discard).toHaveBeenCalledOnce()
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
})
