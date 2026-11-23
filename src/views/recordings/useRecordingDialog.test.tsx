// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { resetAppStateForTests, setConnectionStatus, updateSettings } from '../../app/state'
import type { PianissimoStorage } from '../../core/storage'
import { $, $$, mount, type Mounted } from '../shared/testing'
import type { TakeTarget } from './take'
import { useRecordingDialog, type OneTap, type TakePhase } from './useRecordingDialog'

interface RecorderProps {
  readonly target: TakeTarget
  readonly oneTap: OneTap | null
  readonly onClose: () => void
  readonly onPhase: (phase: TakePhase) => void
}
const shown = vi.hoisted(() => ({ recorder: null as unknown, unmounted: 0 }))
vi.mock('./History', () => ({ RecordingHistory: () => <div data-testid="history" /> }))
vi.mock('./Recorder', async () => {
  const { useEffect } = await import('preact/hooks')
  return {
    Recorder: (props: RecorderProps) => {
      shown.recorder = props
      useEffect(
        () => () => {
          shown.unmounted += 1
        },
        [],
      )
      return <div data-testid="recorder" />
    },
  }
})
const recorderProps = () => shown.recorder as RecorderProps

class FakeContext {
  static all: FakeContext[] = []
  state = 'suspended'
  constructor() {
    FakeContext.all.push(this)
  }
  async resume() {
    this.state = 'running'
  }
  async close() {
    this.state = 'closed'
  }
}

let view: Mounted | null = null
let recorder!: ReturnType<typeof useRecordingDialog>
beforeEach(() => {
  resetAppStateForTests()
  shown.recorder = null
  shown.unmounted = 0
  FakeContext.all = []
  vi.stubGlobal('AudioContext', FakeContext)
})
afterEach(() => {
  view?.unmount()
  view = null
  vi.unstubAllGlobals()
  resetAppStateForTests()
})

const storage = () => Promise.resolve({} as PianissimoStorage)
const TARGET = { pieceId: 'p', title: 'Etude' } as TakeTarget

function Screen({ playing = false, inHeader = true }: { playing?: boolean; inHeader?: boolean }) {
  recorder = useRecordingDialog(playing)
  return (
    <>
      <header>{recorder.controls(() => undefined, inHeader)}</header>
      {inHeader ? null : recorder.phoneFooter}
      {recorder.dialog}
    </>
  )
}
const screen = () => {
  view = mount(<Screen />)
}
const record = () => act(async () => recorder.open(storage, TARGET))
const phase = (next: TakePhase) => act(() => recorderProps().onPhase(next))
const flags = () => ({ busy: recorder.busy, isOpen: recorder.isOpen, showing: recorder.showing })
const remember = () => updateSettings({ recording: { inputId: 'usb', inputLabel: 'Fake Piano' } })
const connect = () => setConnectionStatus({ state: 'connected', inputName: 'Fake Piano' })

it('the header holds nothing of the recorder until it is opened, and never a Record button', async () => {
  screen()
  const header = $(view!.container, 'header')!
  expect(header.children).toHaveLength(0)

  await act(async () => {
    await recorder.open(storage)
  })
  // Open: the slot that receives a take's status and Stop, with nothing to focus by itself.
  const control = $(header, '[data-recording-control]')
  expect(control).not.toBeNull()
  expect($$(header, 'button')).toHaveLength(0)
  expect($(view!.container, '[data-testid="history"]')).not.toBeNull()
})

it('a portrait phone keeps the take in its footer, not the header', async () => {
  view = mount(<Screen inHeader={false} />)
  expect($(view.container, 'footer')).toBeNull()
  await act(async () => {
    await recorder.open(storage)
  })
  expect($(view.container, 'header')!.children).toHaveLength(0)
  expect($(view.container, 'footer')).not.toBeNull()
})

describe('one tap (D20)', () => {
  it('starts from the remembered input, with a context resumed inside the tap', async () => {
    remember()
    connect()
    screen()
    let resumed = ''
    await act(async () => {
      const opening = recorder.open(storage, TARGET)
      resumed = FakeContext.all.map((c) => c.state).join()
      await opening
    })
    expect(resumed).toBe('running')
    expect(recorderProps().oneTap).toEqual({
      input: { inputId: 'usb', inputLabel: 'Fake Piano' },
      context: FakeContext.all[0],
    })
  })

  it('opens the setup sheet when nothing is remembered', async () => {
    connect()
    screen()
    await record()
    expect(recorderProps().oneTap).toBeNull()
    expect(FakeContext.all).toHaveLength(0)
  })

  it('opens the setup sheet without a connected piano', async () => {
    remember()
    screen()
    await record()
    expect(recorderProps().oneTap).toBeNull()
    expect(FakeContext.all).toHaveLength(0)
  })

  it('closes the context of a tap whose screen went before the recorder arrived', async () => {
    remember()
    connect()
    screen()
    await act(async () => {
      const opening = recorder.open(storage, TARGET)
      view!.unmount()
      view = null
      await opening
    })
    expect(shown.recorder).toBeNull()
    expect(FakeContext.all[0]!.state).toBe('closed')
  })
})

describe('busy, mounted and showing', () => {
  it('is busy only while a take opens, records or is saved', async () => {
    remember()
    connect()
    screen()
    expect(flags()).toEqual({ busy: false, isOpen: false, showing: false })
    await record()
    phase('opening')
    expect(flags()).toEqual({ busy: true, isOpen: true, showing: true })
    phase('recording')
    expect(flags()).toEqual({ busy: true, isOpen: true, showing: true })
    phase('saving')
    expect(flags()).toEqual({ busy: true, isOpen: true, showing: true })
    phase('saved')
    expect(flags()).toEqual({ busy: false, isOpen: false, showing: true })
    phase('list')
    expect(flags()).toEqual({ busy: false, isOpen: true, showing: false })
    act(() => recorderProps().onClose())
    expect(flags()).toEqual({ busy: false, isOpen: false, showing: false })
    expect($(view!.container, '[data-recording-control]')).toBeNull()
  })

  it('is not busy under the setup sheet, which closes the menu all the same', async () => {
    connect()
    screen()
    await record()
    phase('setup')
    expect(flags()).toEqual({ busy: false, isOpen: true, showing: false })
  })

  it('marks the header’s place while words show in it', async () => {
    remember()
    connect()
    screen()
    await record()
    const words = () => $(view!.container, '[data-recording-control]')!.hasAttribute('data-words')
    phase('opening')
    expect(words()).toBe(true)
    phase('recording')
    expect(words()).toBe(false)
    phase('saved')
    expect(words()).toBe(true)
  })

  it('starts the next take at once while the pill shows, and replaces the pill', async () => {
    remember()
    connect()
    screen()
    await record()
    phase('saved')
    const first = recorderProps().oneTap
    await record()
    expect(recorderProps().oneTap).not.toBe(first)
    expect(shown.unmounted).toBe(1)
    expect(recorder.busy).toBe(true)
  })

  it('ignores another Record while a take is going', async () => {
    remember()
    connect()
    screen()
    await record()
    phase('recording')
    const first = recorderProps().oneTap
    await record()
    expect(recorderProps().oneTap).toBe(first)
    expect(FakeContext.all).toHaveLength(1)
    expect(shown.unmounted).toBe(0)
  })
})

describe('the saved pill and the score', () => {
  const play = (playing: boolean) => view!.rerender(<Screen playing={playing} />)
  const pill = async () => {
    remember()
    connect()
    screen()
    await record()
    phase('saved')
  }

  it('goes when the score starts playing', async () => {
    await pill()
    play(true)
    expect(shown.unmounted).toBe(1)
    expect(flags()).toEqual({ busy: false, isOpen: false, showing: false })
  })

  it('stays when the take stopped while the score was playing, until it starts again', async () => {
    remember()
    connect()
    view = mount(<Screen playing />)
    await record()
    phase('recording')
    phase('saved')
    expect(recorder.showing).toBe(true)
    play(false)
    expect(recorder.showing).toBe(true)
    play(true)
    expect(shown.unmounted).toBe(1)
  })

  it('a take keeps going when the score starts', async () => {
    remember()
    connect()
    screen()
    await record()
    phase('recording')
    play(true)
    expect(shown.unmounted).toBe(0)
    expect(recorder.busy).toBe(true)
  })

  it('goes with the screen', async () => {
    await pill()
    view!.unmount()
    view = null
    expect(shown.unmounted).toBe(1)
  })
})
