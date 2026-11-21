import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { openFresh } from './testkit'
import { midiFile, waveFile } from '../recording/performance'
import type { RecordingInfo } from '../recording/records'

it('keeps recording metadata and both files together through backup, restore, deletion and repeated restore', async () => {
  const info: RecordingInfo = {
    id: 'one',
    pieceId: 'p',
    title: 'Piece',
    context: 'both',
    passage: 'Whole piece',
    hands: 'both',
    createdAt: 12,
    durationMs: 40,
    input: 'Piano',
    score: { expected: 1, matched: 1, played: 1 },
    interrupted: false,
  }
  const files = { midi: midiFile([], 0, 40), audio: waveFile([new Int16Array([3, 6]).buffer], 4, 2, 44100) }
  const a = await openFresh()
  const b = await openFresh()
  try {
    await a.saveRecording(info, files)
    const backup = await a.exportAll()
    await b.restore(backup)
    await b.restore(backup)
    expect(await b.listRecordings()).toEqual([info])
    const restored = await b.getRecordingFiles(info.id)
    expect(await restored!.audio.arrayBuffer()).toEqual(await files.audio.arrayBuffer())
    expect(await restored!.midi.arrayBuffer()).toEqual(await files.midi.arrayBuffer())
    await b.deleteRecording(info.id)
    expect(await b.listRecordings()).toEqual([])
    expect(await b.getRecordingFiles(info.id)).toBeUndefined()
  } finally {
    a.close()
    b.close()
  }
})
