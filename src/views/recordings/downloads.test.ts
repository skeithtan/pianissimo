import { unzipSync } from 'fflate'
import { expect, it } from 'vitest'
import { downloadPair, recordingName } from './downloads'

const take = { title: 'Prelude', createdAt: Date.UTC(2026, 10, 21, 2, 4, 56, 789) }

it('uses the local date and fractional-hour offset at the start of the take', () => {
  expect(recordingName({ ...take, startUtcOffsetMinutes: -210 })).toBe('2026-11-20T22-34-56-0330 Prelude')
})

it('uses the absolute start time for an older recording with no stored offset', () => {
  expect(recordingName(take)).toBe('2026-11-21T02-04-56Z Prelude')
})

it('zips both files around the take’s own Blobs into an archive any unzip tool reads', async () => {
  const audio = new Uint8Array(3 * (1 << 20) + 17).map((_, i) => (i * 7) & 0xff)
  const midi = new Uint8Array([77, 84, 104, 100, 1, 2, 3])
  const files = { midi: new Blob([midi]), audio: new Blob([audio]) }
  const name = 'Prélude – take'
  const zip = await downloadPair(files, name, new AbortController().signal, Date.UTC(2026, 10, 21, 22, 4, 56))
  expect(zip.type).toBe('application/zip')
  // Stored, not run through a compressor: the archive is the two files plus small headers
  // (a local and a central header per file, each with its name, and the end record).
  const nameBytes = new TextEncoder().encode(name + '.wav').length
  expect(zip.size).toBe(audio.length + midi.length + 2 * (30 + 46 + 2 * nameBytes) + 22)
  const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()))
  expect(Object.keys(entries)).toEqual([name + '.mid', name + '.wav'])
  expect(entries[name + '.mid']).toEqual(midi)
  expect(Buffer.from(entries[name + '.wav']!).equals(Buffer.from(audio))).toBe(true)
})

it('stops building when the download is abandoned', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(
    downloadPair({ midi: new Blob([new Uint8Array(1)]), audio: new Blob([new Uint8Array(10)]) }, 'x', abort.signal),
  ).rejects.toThrow()
})
