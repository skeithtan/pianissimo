// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { notices, resetAppStateForTests } from '../../app/state'
import type { RecordingInfo } from '../../core/recording/records'
import type { PianissimoStorage } from '../../core/storage'
import { $, $$, byLabel, click, mount, type Mounted } from '../shared/testing'

const zips = vi.hoisted(() => ({ built: 0, saved: [] as string[] }))
vi.mock('./downloads', async (original) => ({
  ...(await original<typeof import('./downloads')>()),
  downloadPair: vi.fn(async () => {
    zips.built += 1
    return new Blob(['zip'])
  }),
  saveBlob: vi.fn((_blob: Blob, name: string) => {
    zips.saved.push(name)
  }),
}))

const { RecordingHistory, RecordingList } = await import('./History')
const { resetDiscardForTests } = await import('./discard')

let view: Mounted | null = null
beforeEach(() => {
  zips.built = 0
  zips.saved = []
})
afterEach(() => {
  view?.unmount()
  view = null
  resetDiscardForTests()
  resetAppStateForTests()
})

const info: RecordingInfo = {
  id: 'take-1',
  pieceId: 'p',
  title: 'Etude',
  context: JSON.stringify(['p', 'v1', 'h', 'both', '0-3']),
  passage: 'Whole piece',
  passageRange: null,
  hands: 'both',
  createdAt: Date.UTC(2026, 10, 1),
  durationMs: 4000,
  input: 'Piano',
  score: { expected: 4, played: 4, matched: 4 },
  interrupted: false,
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

it('opening a take plays it without building the download; Download builds the ZIP once', async () => {
  const getRecordingFiles = vi.fn(async () => ({ midi: new Blob(['m']), audio: new Blob(['RIFF']) }))
  const storage = {
    listRecordings: async () => [info],
    getRecordingFiles,
    getPackage: async () => undefined,
  } as unknown as PianissimoStorage
  view = mount(<RecordingHistory storage={() => Promise.resolve(storage)} onClose={() => {}} />)
  await settle()
  const row = $$(document.body, 'button').find((b) => b.getAttribute('aria-expanded') === 'false')
  expect(row?.textContent).toContain('Whole piece')
  click(row)
  await settle()
  expect(getRecordingFiles).toHaveBeenCalledWith('take-1')
  expect($(document.body, 'audio')).not.toBeNull()
  expect(zips.built).toBe(0)

  click(byLabel(document.body, 'Download MIDI and WAV (.zip)'))
  await settle()
  expect(zips.built).toBe(1)
  expect(zips.saved).toEqual(['2026-11-01T00-00-00Z Etude.zip'])
})

/** The list of piece `p`, over a store that discards and restores as the real one does. */
function listed(infos: RecordingInfo[]) {
  const gone = new Set<string>()
  const storage = {
    listRecordings: async () => infos.filter((i) => !gone.has(i.id)),
    discardRecordings: vi.fn(async (ids: string[]) => ids.forEach((id) => gone.add(id))),
    restoreRecordings: vi.fn(async (ids: string[]) => ids.forEach((id) => gone.delete(id))),
    getRecordingFiles: async () => ({ midi: new Blob(['m']), audio: new Blob(['RIFF']) }),
    getRecordingMidi: async () => undefined,
    getPackage: async () => undefined,
  }
  view = mount(<RecordingList storage={async () => storage as unknown as PianissimoStorage} pieceId="p" />)
  return storage
}
const shown = () => $$(document.body, '[data-take]').map((row) => row.getAttribute('data-take'))
const button = (text: string) => $$(document.body, 'button').find((b) => b.textContent?.trim() === text)
const undo = async () => {
  notices.value.find((n) => n.action)!.action!.run()
  await settle()
}

it('deletes the open take without asking, and Undo brings it back in its place', async () => {
  const storage = listed([
    { ...info, id: 'b', createdAt: info.createdAt + 1 },
    { ...info, id: 'a' },
  ])
  await settle()
  click($(document.body, '[data-take="b"] button'))
  await settle()
  click(byLabel(document.body, 'Delete recording'))
  await settle()
  expect(storage.discardRecordings).toHaveBeenCalledWith(['b'])
  expect(shown()).toEqual(['a'])
  await undo()
  expect(shown()).toEqual(['b', 'a'])
})

it('Delete incomplete takes only what was not played through; one that cannot be told counts if interrupted', async () => {
  const storage = listed([
    { ...info, id: 'whole', playedThrough: true },
    { ...info, id: 'part', playedThrough: false },
    { ...info, id: 'whole-interrupted', playedThrough: true, interrupted: true },
    { ...info, id: 'unknown' },
    { ...info, id: 'unknown-interrupted', interrupted: true },
  ])
  await settle()
  click(button('Delete incomplete (2)'))
  await settle()
  expect(storage.discardRecordings).not.toHaveBeenCalled()
  click(button('Delete 2 recordings'))
  await settle()
  expect(storage.discardRecordings).toHaveBeenCalledWith(['part', 'unknown-interrupted'])
  expect(shown()).toEqual(['whole', 'whole-interrupted', 'unknown'])
  expect($$(document.body, 'button').some((b) => b.textContent?.startsWith('Delete incomplete'))).toBe(false)
  await undo()
  expect(shown()).toHaveLength(5)
})

it('asks before the incomplete takes go, with each one’s time and length, and keeps those that are tapped', async () => {
  const storage = listed([
    { ...info, id: 'b', createdAt: new Date(2026, 10, 25, 18, 58).getTime(), durationMs: 21_000, playedThrough: false },
    { ...info, id: 'a', createdAt: new Date(2026, 10, 22, 9, 5).getTime(), durationMs: 72_000, playedThrough: false },
  ])
  await settle()
  const sheet = () => $(document.body, 'dialog[aria-label="Delete incomplete recordings?"]')!
  const choices = () => $$(sheet(), '[aria-pressed]')
  const open = async () => {
    click(button('Delete incomplete (2)'))
    await settle()
  }
  await open()
  expect(choices().map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'true'])
  expect(choices()[0]!.textContent).toContain('18:58 21 s')
  expect(choices()[0]!.textContent).toContain('Wed 25 Nov 2026')
  expect(choices()[1]!.textContent).toContain('09:05 1 min 12 s')
  // Nothing chosen, nothing to delete.
  click(choices()[0])
  click(choices()[1])
  expect((button('Delete 0 recordings') as HTMLButtonElement).disabled).toBe(true)
  click(button('Cancel'))
  await settle()
  expect(storage.discardRecordings).not.toHaveBeenCalled()
  // Asked again, all are chosen again.
  await open()
  expect(choices().map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'true'])
  click(choices()[0])
  expect(choices()[0]!.textContent).toContain('Keep')
  click(button('Delete 1 recording'))
  await settle()
  expect(storage.discardRecordings).toHaveBeenCalledWith(['a'])
  expect(shown()).toEqual(['b'])
})

it('Clear all takes the takes of this piece, and an incomplete take is never the best', async () => {
  const storage = listed([
    { ...info, id: 'whole', playedThrough: true, score: { expected: 4, played: 4, matched: 2 } },
    { ...info, id: 'part', playedThrough: false, score: { expected: 4, played: 3, matched: 3 } },
    { ...info, id: 'other', pieceId: 'another piece' },
  ])
  await settle()
  const standing = (id: string) => $(document.body, `[data-take="${id}"] [data-standing]`)?.textContent
  expect([standing('whole'), standing('part')]).toEqual(['Best take', 'Incomplete'])
  click(button('Clear all'))
  await settle()
  expect(storage.discardRecordings).toHaveBeenCalledWith(['whole', 'part'])
  expect(shown()).toEqual([])
  expect(document.body.textContent).toContain('No recordings yet.')
})
