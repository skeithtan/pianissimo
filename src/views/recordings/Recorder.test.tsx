// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { RecordingError, type OpenInputOptions, type PerformanceInput } from '../../app/audio/performanceInput'
import { notices, resetAppStateForTests, setConnectionStatus, settings, updateSettings } from '../../app/state'
import type { RecordingInfo } from '../../core/recording/records'
import { $, $$, byLabel, click, flush, mount, type Mounted } from '../shared/testing'
import type { TakeTarget } from './take'
import type { SavedTake } from './unsaved'
import type { OneTap, TakePhase } from './useRecordingDialog'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  begin: vi.fn(),
  list: { initialId: undefined as string | undefined },
}))
vi.mock('../../app/audio/performanceInput', async (original) => ({
  ...(await original<typeof import('../../app/audio/performanceInput')>()),
  openPerformanceInput: mocks.open,
}))
vi.mock('./take', () => ({ beginTake: mocks.begin }))
vi.mock('./History', () => ({
  handName: () => 'Both hands',
  RecordingHistory: ({ initialId, onClose }: { initialId?: string; onClose: () => void }) => {
    mocks.list.initialId = initialId
    return (
      <div data-testid="list">
        <button aria-label="Close the list" onClick={onClose} />
      </div>
    )
  },
}))

const { Recorder } = await import('./Recorder')
const { discarded, resetDiscardForTests } = await import('./discard')

type Opening = {
  id: string
  onLost: () => void
  signal: AbortSignal
  options: OpenInputOptions
  resolve: (input: PerformanceInput) => void
  reject: (error: unknown) => void
}

class FakeAudio {
  static all: FakeAudio[] = []
  paused = true
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  onended: (() => void) | null = null
  constructor(public src: string) {
    FakeAudio.all.push(this)
  }
  async play() {
    if (failPlay) throw Object.assign(new Error(), { name: failPlay })
    this.paused = false
    this.onplay?.()
  }
  pause() {
    if (this.paused) return
    this.paused = true
    this.onpause?.()
  }
  removeAttribute() {
    this.src = ''
  }
  load() {}
}

let openings: Opening[] = []
let takes: {
  stop: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
  target: TakeTarget
  onLost: () => void
}[] = []
const keep = vi.fn()
let stopped: Promise<SavedTake>
let urls: string[] = []
let failPlay = ''
let phases: TakePhase[] = []
let view: Mounted | null = null
let host: HTMLElement
const onClose = vi.fn()

function fakeInput(deviceId = 'usb', deviceLabel = 'Fake Piano') {
  return {
    label: deviceLabel || 'System audio input',
    deviceLabel,
    deviceId,
    devices: [],
    level: () => 0,
    start: () => undefined,
    stop: async () => new Blob(),
    close: vi.fn(),
  }
}

const info = (patch: Partial<RecordingInfo> = {}): RecordingInfo => ({
  id: 'take-1',
  pieceId: 'p',
  title: 'Etude',
  context: '[]',
  passage: 'Whole piece',
  hands: 'both',
  createdAt: 0,
  durationMs: 4000,
  input: 'Fake Piano',
  score: { expected: 10, played: 10, matched: 9 },
  interrupted: false,
  ...patch,
})
const savedTake = (patch?: Partial<RecordingInfo>): SavedTake => ({
  info: info(patch),
  files: { midi: new Blob(['m']), audio: new Blob(['RIFF']) },
})

const TARGET = {
  pieceId: 'p',
  title: 'Etude',
  model: { measures: [], occurrences: [], scoreVersionId: 'v' },
  range: null,
  hands: 'both',
  env: { storage: async () => ({}) },
} as unknown as TakeTarget
const REMEMBERED: OneTap = {
  input: { inputId: 'usb', inputLabel: 'Fake Piano' },
  context: undefined,
}

beforeEach(() => {
  resetAppStateForTests()
  setConnectionStatus({ state: 'connected', inputName: 'Fake Piano' })
  openings = []
  takes = []
  urls = []
  failPlay = ''
  phases = []
  onClose.mockReset()
  FakeAudio.all = []
  stopped = Promise.resolve(savedTake())
  mocks.open.mockImplementation(
    (id: string, onLost: () => void, signal: AbortSignal, options: OpenInputOptions) =>
      new Promise((resolve, reject) => openings.push({ id, onLost, signal, options, resolve, reject })),
  )
  mocks.begin.mockImplementation((target: TakeTarget, _input: PerformanceInput, onLost: () => void) => {
    const take = { stop: vi.fn(() => stopped), discard: vi.fn(() => keep), target, onLost }
    takes.push(take)
    return take
  })
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    urls.push(`blob:${urls.length}`)
    return urls.at(-1)!
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    urls = urls.filter((u) => u !== url)
  })
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => {
  view?.unmount()
  view = null
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDiscardForTests()
  resetAppStateForTests()
})

const element = (oneTap: OneTap | null, place: HTMLElement | null = host) => (
  <Recorder
    target={TARGET}
    oneTap={oneTap}
    onClose={onClose}
    onPhase={(phase) => phases.push(phase)}
    controlsHost={place}
  />
)
const start = (oneTap: OneTap | null = REMEMBERED) => {
  view = mount(element(oneTap))
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
const open = async (input = fakeInput()) => {
  openings.at(-1)!.resolve(input)
  await settle()
}
const fail = async (error: unknown) => {
  openings.at(-1)!.reject(error)
  await settle()
}
const stop = async () => {
  click(byLabel(host, 'Stop recording'))
  await settle()
}
const sheet = () => $(document.body, 'dialog[aria-label="Record performance"]')
const group = (name: string) => $$(host, '[role="group"]').find((g) => g.getAttribute('aria-label') === name) ?? null
const alert = () => $(document.body, '[role="alert"]')?.textContent ?? null

describe('Discard (U164)', () => {
  it('stops the take without saving it, and Undo saves it as Stop would have', async () => {
    start()
    await open()
    keep.mockReset().mockResolvedValue(undefined)
    click(byLabel(host, 'Discard recording'))
    expect(takes[0]!.discard).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    // The screen may go: the take is neither stopped again nor lost.
    view?.unmount()
    view = null
    expect(takes[0]!.stop).not.toHaveBeenCalled()
    expect(keep).not.toHaveBeenCalled()
    notices.value.find((n) => n.text === 'Recording discarded')!.action!.run()
    await settle()
    expect(keep).toHaveBeenCalledOnce()
    expect(notices.value.map((n) => n.text)).toEqual(['Recording restored'])
  })
})

describe('a one-tap take (D20)', () => {
  it('opens the remembered input, shows that it is opening, and records as soon as it is open', async () => {
    start()
    expect(openings).toHaveLength(1)
    expect(openings[0]!.options.remembered).toEqual(REMEMBERED.input)
    expect(group('Opening audio input…')?.getAttribute('aria-busy')).toBe('true')
    expect(sheet()).toBeNull()
    expect(mocks.begin).not.toHaveBeenCalled()
    await open()
    expect(takes).toHaveLength(1)
    expect(group('Recording')).not.toBeNull()
    expect($(host, '[role="timer"]')?.textContent).toBe('0:00')
    expect(phases).toEqual(['opening', 'recording'])
    // The choice was made on an earlier take: nothing to write.
    expect(settings.value.recording).toEqual({ inputId: null, inputLabel: null })
  })

  it('can be canceled while it opens: the input goes, and so does the recorder', async () => {
    start()
    click(byLabel(host, 'Cancel'))
    expect(openings[0]!.signal.aborted).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    const late = fakeInput()
    await open(late)
    expect(late.close).toHaveBeenCalled()
    expect(takes).toHaveLength(0)
  })

  it('opens the setup sheet with the reason when the remembered input is missing or another answers', async () => {
    start()
    await fail(new RecordingError('The selected audio input is not available. Choose another input or reconnect it.'))
    expect(sheet()).not.toBeNull()
    expect(alert()).toMatch(/^The selected audio input is not available/)
    expect(byLabel(sheet()!, 'Enable audio input')).not.toBeNull()
    expect(takes).toHaveLength(0)
    expect(phases).toEqual(['opening', 'setup'])
  })

  it('opens the setup sheet with the reason when permission is refused', async () => {
    start()
    await fail(Object.assign(new Error('raw'), { name: 'NotAllowedError' }))
    expect(sheet()).not.toBeNull()
    expect(alert()).toMatch(/^Pianissimo is not allowed to use audio input/)
    expect(takes).toHaveLength(0)
  })

  it('opens the setup sheet, with the input closed, when the take cannot start', async () => {
    mocks.begin.mockImplementation(() => {
      throw new RecordingError('This passage has no notes for the selected hands.')
    })
    start()
    const input = fakeInput()
    await open(input)
    expect(sheet()).not.toBeNull()
    expect(alert()).toBe('This passage has no notes for the selected hands.')
    expect(input.close).toHaveBeenCalled()
  })

  it('opens the setup sheet when the piano is gone by the time the input is open', async () => {
    start()
    setConnectionStatus({ state: 'disconnected' })
    const input = fakeInput()
    await open(input)
    expect(input.close).toHaveBeenCalled()
    expect(takes).toHaveLength(0)
    expect(sheet()?.textContent).toContain('Connect and select a MIDI piano to record a performance.')
  })

  it('opens the setup sheet when the page is hidden while the input opens', async () => {
    start()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    flush(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(openings[0]!.signal.aborted).toBe(true)
    expect(alert()).toBe('Audio input was interrupted.')
    expect(sheet()).not.toBeNull()
  })

  it('leaves no input open when the screen goes while it opens', async () => {
    start()
    view!.unmount()
    view = null
    expect(openings[0]!.signal.aborted).toBe(true)
  })
})

describe('the setup sheet', () => {
  it('remembers the input of a take that starts, not of one that does not', async () => {
    start(null)
    expect(openings).toHaveLength(0)
    expect(sheet()?.textContent).toContain('This choice is kept for next time.')
    click(byLabel(sheet()!, 'Enable audio input'))
    expect(openings[0]!.options).toEqual({ preferredName: 'Fake Piano' })
    await open()
    expect(settings.value.recording).toEqual({ inputId: null, inputLabel: null })
    click(byLabel(sheet()!, 'Start recording'))
    expect(takes).toHaveLength(1)
    expect(settings.value.recording).toEqual({ inputId: 'usb', inputLabel: 'Fake Piano' })
    expect(phases).toEqual(['setup', 'recording'])
  })

  it('remembers nothing when the take cannot start', async () => {
    updateSettings({ recording: { inputId: 'other', inputLabel: 'Other' } })
    mocks.begin.mockImplementation(() => {
      throw new RecordingError('Audio input was interrupted.')
    })
    start(null)
    click(byLabel(sheet()!, 'Enable audio input'))
    await open()
    click(byLabel(sheet()!, 'Start recording'))
    expect(alert()).toBe('Audio input was interrupted.')
    expect(settings.value.recording).toEqual({ inputId: 'other', inputLabel: 'Other' })
  })

  it('explains that a piano is needed, and opens nothing', () => {
    setConnectionStatus({ state: 'disconnected' })
    start(null)
    expect(sheet()?.textContent).toContain('Connect and select a MIDI piano to record a performance.')
    expect((byLabel(sheet()!, 'Enable audio input') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the pill after Stop', () => {
  const record = async () => {
    start()
    await open()
    await stop()
  }
  const listen = () => byLabel(host, 'Listen to recording')

  it('takes the place of Stop, says the score and announces itself politely; no list opens', async () => {
    start()
    const status = $(view!.container, '[role="status"]')!
    expect(status.textContent).toBe('')
    await open()
    await stop()
    expect(takes[0]!.stop).toHaveBeenCalledWith(false)
    const pill = group('Take saved')!
    expect(pill.textContent).toContain('Take saved')
    expect(pill.textContent).toContain('90%')
    expect($(document.body, '[data-testid="list"]')).toBeNull()
    expect(byLabel(host, 'Stop recording')).toBeNull()
    expect(status.isConnected).toBe(true)
    expect(status.textContent).toBe('Take saved · 90%')
    expect(phases).toEqual(['opening', 'recording', 'saving', 'saved'])
  })

  it('says that a take was interrupted', async () => {
    stopped = Promise.resolve(savedTake({ interrupted: true }))
    start()
    await open()
    flush(() => takes[0]!.onLost())
    await settle()
    expect(takes[0]!.stop).toHaveBeenCalledWith(true)
    expect(group('Take saved')!.textContent).toContain('Interrupted')
    expect($(view!.container, '[role="status"]')!.textContent).toBe('Take saved · Interrupted · 90%')
  })

  it('plays and pauses the take’s own audio, and holds no URL before the first Listen', async () => {
    await record()
    expect(urls).toEqual([])
    click(listen())
    expect(urls).toHaveLength(1)
    expect(FakeAudio.all).toHaveLength(1)
    expect(FakeAudio.all[0]!.paused).toBe(false)
    const pause = byLabel(host, 'Pause')
    expect(pause).not.toBeNull()
    click(pause)
    expect(FakeAudio.all[0]!.paused).toBe(true)
    click(listen())
    expect(FakeAudio.all).toHaveLength(1)
    flush(() => FakeAudio.all[0]!.onended?.())
    expect(listen()).not.toBeNull()
  })

  it('keeps playing while a phone turns (its place changes)', async () => {
    await record()
    click(listen())
    const footer = document.createElement('footer')
    document.body.appendChild(footer)
    view!.rerender(element(REMEMBERED, null))
    view!.rerender(element(REMEMBERED, footer))
    expect(FakeAudio.all[0]!.paused).toBe(false)
    expect(byLabel(footer, 'Pause')).not.toBeNull()
    expect(urls).toHaveLength(1)
    footer.remove()
  })

  it('stops the audio and releases its URL when it goes', async () => {
    await record()
    click(listen())
    click(byLabel(host, 'Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    view!.unmount()
    view = null
    expect(FakeAudio.all[0]!.paused).toBe(true)
    expect(FakeAudio.all[0]!.src).toBe('')
    expect(urls).toEqual([])
  })

  it('says when the audio cannot be played, but not when a pause came first', async () => {
    await record()
    failPlay = 'AbortError'
    click(listen())
    await settle()
    expect(notices.value).toEqual([])
    failPlay = 'NotSupportedError'
    click(listen())
    await settle()
    expect(notices.value.map((n) => n.text)).toEqual(['Could not open this recording.'])
  })

  it('opens Recordings at the take, pauses its audio, and stays when the list closes', async () => {
    await record()
    click(listen())
    click(byLabel(host, 'Recordings'))
    expect($(document.body, '[data-testid="list"]')).not.toBeNull()
    expect(mocks.list.initialId).toBe('take-1')
    expect(FakeAudio.all[0]!.paused).toBe(true)
    expect(phases.at(-1)).toBe('list')
    click(byLabel(document.body, 'Close the list'))
    expect($(document.body, '[data-testid="list"]')).toBeNull()
    expect(group('Take saved')).not.toBeNull()
    expect(document.activeElement).toBe(byLabel(host, 'Recordings'))
    expect(phases.at(-1)).toBe('saved')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('goes with the list when its take was deleted there', async () => {
    await record()
    click(byLabel(host, 'Recordings'))
    await act(async () => {
      discarded.value = new Set(['another', 'take-1'])
    })
    expect(onClose).not.toHaveBeenCalled()
    click(byLabel(document.body, 'Close the list'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays when Undo brought its take back before the list closed', async () => {
    await record()
    click(byLabel(host, 'Recordings'))
    await act(async () => {
      discarded.value = new Set(['take-1'])
    })
    await act(async () => {
      discarded.value = new Set()
    })
    click(byLabel(document.body, 'Close the list'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('moves the keyboard’s focus from Stop to Listen, and takes no focus otherwise', async () => {
    start()
    await open()
    byLabel(host, 'Stop recording')!.focus()
    await stop()
    expect(document.activeElement).toBe(listen())
    view!.unmount()
    view = null
    ;(document.activeElement as HTMLElement | null)?.blur()
    await record()
    expect(document.activeElement).not.toBe(listen())
  })

  it('gives way to the notice and the list when saving failed: the take is in memory only', async () => {
    stopped = Promise.reject(new Error('full'))
    stopped.catch(() => undefined)
    await record()
    expect(group('Take saved')).toBeNull()
    expect($(document.body, '[data-testid="list"]')).not.toBeNull()
    expect(notices.value.map((n) => n.text)).toEqual([
      'Recording could not be saved. Open Recordings to download it or retry.',
    ])
    click(byLabel(document.body, 'Close the list'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
