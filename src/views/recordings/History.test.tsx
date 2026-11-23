// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import type { RecordingInfo } from '../../core/recording/records'
import type { PianissimoStorage } from '../../core/storage'
import { $, $$, click, mount, type Mounted } from '../shared/testing'

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

const { RecordingHistory } = await import('./History')

let view: Mounted | null = null
beforeEach(() => {
  zips.built = 0
  zips.saved = []
})
afterEach(() => {
  view?.unmount()
  view = null
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

  const download = $$(document.body, 'button').find((b) => b.textContent?.includes('Download MIDI and WAV (.zip)'))
  click(download)
  await settle()
  expect(zips.built).toBe(1)
  expect(zips.saved).toEqual(['Etude - 2026-11-01 00-00-00.000 UTC+0000.zip'])
})
