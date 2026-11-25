import 'fake-indexeddb/auto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { freshName, importPiece, attemptFor, openFresh } from './testkit'
import { midiFile, waveFile } from '../recording/performance'
import type { RecordingInfo } from '../recording/records'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from './backupFormat'
import type { BackupManifest } from './backupFormat'
import { exportBackup, restoreBackup } from './backup'
import { BackupError } from './errors'
import { ABANDONED_WRITE_MS, DISCARDED_KEEP_MS, RECORDING_BLOCK_BYTES, blockRange, writeTake } from './recordings'
import type { RecordingFilesMeta } from './recordings'
import { openPianissimoDb } from './schema'
import type { Db } from './schema'
import { openStorage } from './storage'
import type { PianissimoStorage } from './storage'
import { MAX_TOTAL_BYTES } from './zipio'

const open: Array<{ close(): void }> = []
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})
async function storage(name = freshName(), options: Parameters<typeof openStorage>[1] = {}) {
  const s = await openStorage(name, options)
  open.push(s)
  return s
}
async function raw(name: string): Promise<Db> {
  const db = await openPianissimoDb(name)
  open.push(db)
  return db
}

function take(id: string, extra: Partial<RecordingInfo> = {}): RecordingInfo {
  return {
    id,
    pieceId: 'p',
    title: `Take ${id}`,
    context: JSON.stringify(['p', 'v1', 'h', 'both', '0-3']),
    passage: 'Whole piece',
    passageRange: null,
    hands: 'both',
    createdAt: 12,
    startUtcOffsetMinutes: -210,
    durationMs: 40,
    input: 'Piano',
    score: { expected: 1, matched: 1, played: 1 },
    interrupted: false,
    ...extra,
  }
}

/** Deterministic bytes, different for each seed. */
function pattern(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 7 + (i >> 13)) & 0xff
  return out
}

function files(audioBytes: number, seed: number) {
  return {
    midi: new Blob([pattern(100 + seed, seed + 1)], { type: 'audio/midi' }),
    audio: new Blob([pattern(audioBytes, seed)], { type: 'audio/wav' }),
  }
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** Byte-for-byte equality (a deep equal over megabytes is far too slow). */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length)
  expect(
    Buffer.from(actual.buffer, actual.byteOffset, actual.length).equals(
      Buffer.from(expected.buffer, expected.byteOffset, expected.length),
    ),
  ).toBe(true)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function blockSizes(db: Db, id: string): Promise<number[]> {
  return (await db.getAll('recordingBlocks', blockRange(id))).map((b) => b.byteLength)
}

it('keeps recording metadata and both files together through backup, restore, deletion and repeated restore', async () => {
  const info: RecordingInfo = {
    id: 'one',
    pieceId: 'p',
    title: 'Piece',
    context: 'both',
    passage: 'Whole piece',
    hands: 'both',
    createdAt: 12,
    startUtcOffsetMinutes: -210,
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
    await b.discardRecordings([info.id])
    await b.removeDiscardedRecordings([info.id])
    expect(await b.listRecordings()).toEqual([])
    expect(await b.getRecordingFiles(info.id)).toBeUndefined()
  } finally {
    a.close()
    b.close()
  }
})

describe('discarded takes', () => {
  it('leave every list, summary and backup at once, and come back whole', async () => {
    const s = await storage()
    await s.saveRecording(take('a'), files(5000, 1))
    await s.saveRecording(take('b'), files(6000, 2))
    const before = await s.recordingsSummary()
    await s.discardRecordings(['a', 'gone'])
    expect(await s.listRecordings()).toEqual([take('b')])
    expect((await s.recordingsSummary()).count).toBe(1)
    const entries = unzipSync(await bytesOf(await s.exportAll()))
    expect(JSON.parse(strFromU8(entries['recordings.json']!))).toEqual([take('b')])

    await s.restoreRecordings(['a', 'gone'])
    expect(await s.listRecordings()).toEqual([take('a'), take('b')])
    expect(await s.recordingsSummary()).toEqual(before)
    expectSameBytes(await bytesOf((await s.getRecordingFiles('a'))!.audio), await bytesOf(files(5000, 1).audio))
    // Brought back: the removal that was due leaves it alone.
    await s.removeDiscardedRecordings(['a'])
    expect((await s.listRecordings()).length).toBe(2)
  })

  it('that a page did not live to remove go on a later open', async () => {
    const name = freshName()
    let now = 1000
    const s = await storage(name, { now: () => now })
    await s.saveRecording(take('a'), files(5000, 1))
    await s.discardRecordings(['a'])
    await storage(name, { now: () => now + DISCARDED_KEEP_MS })
    const db = await raw(name)
    expect(await db.count('recordings')).toBe(1)
    now += DISCARDED_KEEP_MS + 1
    await storage(name, { now: () => now })
    expect([await db.count('recordings'), await db.count('recordingFiles'), await db.count('recordingBlocks')]).toEqual(
      [0, 0, 0],
    )
  })

  it('give way to the same take from a backup', async () => {
    const s = await storage()
    await s.saveRecording(take('a'), files(5000, 1))
    const backup = await s.exportAll()
    await s.discardRecordings(['a'])
    expect((await s.restore(backup)).recordings).toEqual({ added: 1, skipped: 0, failed: 0 })
    await s.removeDiscardedRecordings(['a'])
    expect(await s.listRecordings()).toEqual([take('a')])
    expectSameBytes(await bytesOf((await s.getRecordingFiles('a'))!.audio), await bytesOf(files(5000, 1).audio))
  })
})

describe('takes stored in blocks', () => {
  it('saves, reads and deletes a multi-block take, never storing a value over the block size', async () => {
    const name = freshName()
    const s = await storage(name)
    const db = await raw(name)
    const size = 2 * RECORDING_BLOCK_BYTES + 12_345
    const input = files(size, 3)
    await s.saveRecording(take('long'), input)

    expect(await s.listRecordings()).toEqual([take('long')])
    const meta = (await db.get('recordingFiles', 'long')) as RecordingFilesMeta
    expect(meta).toMatchObject({ type: 'audio/wav', blocks: 3, bytes: size })
    expect('audio' in meta).toBe(false)
    expect(await blockSizes(db, 'long')).toEqual([RECORDING_BLOCK_BYTES, RECORDING_BLOCK_BYTES, 12_345])
    expect(Math.max(...(await db.getAll('recordingBlocks')).map((b) => b.byteLength))).toBeLessThanOrEqual(
      RECORDING_BLOCK_BYTES,
    )

    const read = await s.getRecordingFiles('long')
    expect(read!.audio.size).toBe(size)
    expect(read!.audio.type).toBe('audio/wav')
    expectSameBytes(await bytesOf(read!.audio), await bytesOf(input.audio))
    expectSameBytes(await bytesOf(read!.midi), await bytesOf(input.midi))
    expect(await s.recordingsSummary()).toEqual({ count: 1, bytes: size + 103 })

    await s.discardRecordings(['long'])
    await s.removeDiscardedRecordings(['long'])
    expect(await s.listRecordings()).toEqual([])
    expect(await db.count('recordingBlocks')).toBe(0)
    expect(await db.get('recordingFiles', 'long')).toBeUndefined()
    expect(await s.recordingsSummary()).toEqual({ count: 0, bytes: 0 })
  })

  it('a save that fails part-way lists nothing and leaves no blocks behind', async () => {
    const name = freshName()
    const s = await storage(name)
    const db = await raw(name)
    const audio = files(3 * RECORDING_BLOCK_BYTES, 1).audio
    let reads = 0
    const failing = new Proxy(audio, {
      get(target, prop) {
        if (prop === 'slice') {
          return (...args: [number, number]) => {
            reads += 1
            if (reads === 3) return { arrayBuffer: () => Promise.reject(new Error('read failed')) }
            return target.slice(...args)
          }
        }
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? (v as () => unknown).bind(target) : v
      },
    })
    await expect(
      s.saveRecording(take('cut'), { midi: new Blob([pattern(10, 1)]), audio: failing as Blob }),
    ).rejects.toThrow(/read failed/)
    expect(await s.listRecordings()).toEqual([])
    expect(await db.count('recordingBlocks')).toBe(0)
    expect(await db.count('pendingRecordings')).toBe(0)
    expect(await db.count('recordingFiles')).toBe(0)
    // Retry saving works.
    await s.saveRecording(take('cut'), files(3 * RECORDING_BLOCK_BYTES, 1))
    expect((await s.listRecordings()).map((r) => r.id)).toEqual(['cut'])
  })

  it('a take interrupted by a closed page is never listed and is cleaned up on a later open', async () => {
    const name = freshName()
    let clock = 1_000_000
    const s = await storage(name, { now: () => clock })
    const db = await raw(name)
    // Simulate a page that closed after writing two blocks: the marker and blocks stay behind.
    await db.put('pendingRecordings', { startedAt: clock }, 'orphan')
    await db.put('recordingBlocks', pattern(10, 1).buffer, ['orphan', 0])
    await db.put('recordingBlocks', pattern(10, 2).buffer, ['orphan', 1])
    // Another tab's write that is still young.
    await db.put('pendingRecordings', { startedAt: clock }, 'young')
    await db.put('recordingBlocks', pattern(10, 3).buffer, ['young', 0])
    await s.saveRecording(take('kept'), files(1000, 4))
    expect((await s.listRecordings()).map((r) => r.id)).toEqual(['kept'])
    s.close()

    clock += ABANDONED_WRITE_MS + 1
    await db.put('pendingRecordings', { startedAt: clock }, 'young')
    const later = await storage(name, { now: () => clock })
    expect((await later.listRecordings()).map((r) => r.id)).toEqual(['kept'])
    expect(await blockSizes(db, 'orphan')).toEqual([])
    expect(await db.get('pendingRecordings', 'orphan')).toBeUndefined()
    expect(await blockSizes(db, 'young')).toEqual([10])
    expect(await blockSizes(db, 'kept')).toEqual([1000])
  })

  it('a write whose blocks were removed by another tab fails instead of listing a broken take', async () => {
    const name = freshName()
    await storage(name)
    const db = await raw(name)
    const info = take('raced')
    async function* audio() {
      yield pattern(10, 1)
      // Another tab's open treats the write as abandoned and removes it.
      await db.delete('recordingBlocks', blockRange('raced'))
      await db.delete('pendingRecordings', 'raced')
      yield pattern(10, 2)
    }
    await expect(
      writeTake(db, { info, midi: new ArrayBuffer(1), type: 'audio/wav', audio: audio() }, () => 5),
    ).rejects.toThrow(/lost blocks/)
    expect(await db.getAll('recordings')).toEqual([])
    expect(await db.count('recordingBlocks')).toBe(0)
  })

  it('reads and backs up a take still in the schema 3 shape', async () => {
    const name = freshName()
    const s = await storage(name)
    const db = await raw(name)
    const parts = [pattern(RECORDING_BLOCK_BYTES, 1), pattern(500, 2)]
    await db.put('recordingFiles', { midi: pattern(20, 3).buffer, audio: parts.map((p) => p.buffer) }, 'old')
    await db.put('recordings', take('old'))
    const read = await s.getRecordingFiles('old')
    expectSameBytes(await bytesOf(read!.audio), concat(parts))
    expect(await s.recordingsSummary()).toEqual({ count: 1, bytes: RECORDING_BLOCK_BYTES + 520 })

    const target = await storage()
    const report = await target.restore(await s.exportAll())
    expect(report.recordings).toEqual({ added: 1, skipped: 0, failed: 0 })
    expectSameBytes(await bytesOf((await target.getRecordingFiles('old'))!.audio), await bytesOf(read!.audio))
  })
})

describe('recordings in backups', () => {
  async function library(s: PianissimoStorage) {
    const { piece } = await importPiece(s, 'v1')
    s.history.queueAttempt(attemptFor(piece.id, [[1, 'clean']]))
    await s.history.flush()
    const sizes = [2 * RECORDING_BLOCK_BYTES + 99, RECORDING_BLOCK_BYTES + 1, 4000]
    const all = sizes.map((size, i) => ({ info: take(`t${i}`, { createdAt: i }), files: files(size, i) }))
    for (const t of all) await s.saveRecording(t.info, t.files)
    return { piece, takes: all }
  }

  it('round-trips several multi-block takes as stored parts of at most one block', async () => {
    const source = await storage()
    const { takes } = await library(source)
    const archive = await source.exportAll()
    const entries = unzipSync(await bytesOf(archive))
    expect(
      Object.keys(entries)
        .filter((n) => n.startsWith('recordings/t0.'))
        .sort(),
    ).toEqual(['recordings/t0.mid', 'recordings/t0.wav.0', 'recordings/t0.wav.1', 'recordings/t0.wav.2'])
    for (const [name, data] of Object.entries(entries)) {
      if (name.startsWith('recordings/')) expect(data.length).toBeLessThanOrEqual(RECORDING_BLOCK_BYTES)
    }
    expect((JSON.parse(strFromU8(entries['manifest.json']!)) as BackupManifest).counts.recordings).toBe(3)

    const name = freshName()
    const target = await storage(name)
    const report = await target.restore(archive)
    expect(report.recordings).toEqual({ added: 3, skipped: 0, failed: 0 })
    expect(report.stores.pieces.added).toBe(1)
    for (const t of takes) {
      const read = await target.getRecordingFiles(t.info.id)
      expectSameBytes(await bytesOf(read!.audio), await bytesOf(t.files.audio))
      expectSameBytes(await bytesOf(read!.midi), await bytesOf(t.files.midi))
    }
    const db = await raw(name)
    expect(Math.max(...(await db.getAll('recordingBlocks')).map((b) => b.byteLength))).toBeLessThanOrEqual(
      RECORDING_BLOCK_BYTES,
    )
    expect((await target.restore(archive)).recordings).toEqual({ added: 0, skipped: 3, failed: 0 })
  })

  it('restores a backup written before takes were stored in blocks', async () => {
    const midi = pattern(64, 9)
    const parts = [pattern(RECORDING_BLOCK_BYTES, 5), pattern(RECORDING_BLOCK_BYTES, 6), pattern(1000, 7)]
    const info = take('legacy')
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: 'old',
      createdAt: 1,
      dbVersion: 3,
      counts: {
        recordings: 1,
        pieces: 0,
        packages: 0,
        sources: 0,
        attempts: 0,
        measureHistory: 0,
        suggestionState: 0,
        abandonEvents: 0,
        settings: 0,
      },
    }
    const json = (v: unknown) => strToU8(JSON.stringify(v))
    // The shape the schema 3 writer produced: JSON entries deflated, take files stored.
    const old = zipSync({
      'settings.json': json({ settings: null }),
      'pieces.json': json([]),
      'attempts.json': json([]),
      'measureHistory.json': json([]),
      'suggestionState.json': json([]),
      'abandonEvents.json': json([]),
      'sources.json': json([]),
      'recordings/legacy.mid': [midi, { level: 0 }],
      ...Object.fromEntries(parts.map((p, i) => [`recordings/legacy.wav.${i}`, [p, { level: 0 }] as const])),
      'recordings.json': json([info]),
      'manifest.json': json(manifest),
    })
    const target = await storage()
    const report = await target.restore(new Blob([old]))
    expect(report.recordings).toEqual({ added: 1, skipped: 0, failed: 0 })
    expect(await target.listRecordings()).toEqual([info])
    const read = await target.getRecordingFiles('legacy')
    expectSameBytes(await bytesOf(read!.audio), concat(parts))
    expectSameBytes(await bytesOf(read!.midi), midi)
  })

  it('a take the browser cannot store is reported and does not undo the rest of the restore', async () => {
    const source = await storage()
    const { piece } = await library(source)
    const archive = await source.exportAll()

    const name = freshName()
    const real = await raw(name)
    const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'put') {
          return (store: string, value: unknown, key?: unknown) =>
            store === 'recordingBlocks' && Array.isArray(key) && key[0] === 't1' && key[1] === 1
              ? Promise.reject(quota())
              : (target.put as (...a: unknown[]) => Promise<unknown>)(store, value, key)
        }
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    })
    const report = await restoreBackup(failing, archive)
    expect(report.recordings).toEqual({ added: 2, skipped: 0, failed: 1 })
    expect(report.warnings).toEqual([
      'The recording "Take t1" was not restored because this browser’s storage is full.',
    ])
    expect(report.stores.pieces.added).toBe(1)
    expect(report.stores.attempts.added).toBe(1)
    expect((await real.getAll('recordings')).map((r) => r.id).sort()).toEqual(['t0', 't2'])
    expect(await real.get('pieces', piece.id)).toBeDefined()
    expect(await real.count('recordingBlocks', blockRange('t1'))).toBe(0)
    expect(await real.count('pendingRecordings')).toBe(0)
  })

  it('refuses an export over the restore limit and suggests leaving recordings out', async () => {
    const name = freshName()
    const s = await storage(name)
    const db = await raw(name)
    await importPiece(s, 'v1')
    // A take whose files record says it holds more than a backup may.
    await db.put('recordings', take('huge'))
    await db.put(
      'recordingFiles',
      { midi: new ArrayBuffer(4), type: 'audio/wav', blocks: 600, bytes: MAX_TOTAL_BYTES },
      'huge',
    )
    const error = await s.exportAll().then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(BackupError)
    expect((error as BackupError).code).toBe('too-large')
    expect((error as BackupError).message).toBe(
      'The backup was not created because it would be too large to restore. Turn off “Include recordings” and export again.',
    )
    // Without recordings the same library exports.
    const without = await s.exportAll({ includeRecordings: false })
    expect(Object.keys(unzipSync(await bytesOf(without)))).toContain('packages/v1.json')
  })

  it('leaves a damaged take out of the backup and keeps the others restorable', async () => {
    const name = freshName()
    const s = await storage(name)
    const db = await raw(name)
    await s.saveRecording(take('whole'), files(100, 1))
    await s.saveRecording(take('broken'), files(RECORDING_BLOCK_BYTES + 10, 2))
    await db.delete('recordingBlocks', ['broken', 1])
    const archive = await s.exportAll()
    const entries = unzipSync(await bytesOf(archive))
    expect((JSON.parse(strFromU8(entries['recordings.json']!)) as RecordingInfo[]).map((r) => r.id)).toEqual(['whole'])
    const target = await storage()
    expect((await target.restore(archive)).recordings).toEqual({ added: 1, skipped: 0, failed: 0 })
  })

  it('with recordings left out the backup holds no recording data and its manifest says so', async () => {
    const source = await storage()
    await library(source)
    const archive = await source.exportAll({ includeRecordings: false })
    const entries = unzipSync(await bytesOf(archive))
    expect(Object.keys(entries).filter((n) => n.startsWith('recording'))).toEqual([])
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as BackupManifest
    expect(manifest.recordingsExcluded).toBe(true)
    expect(manifest.counts.recordings).toBeUndefined()

    const target = await storage()
    const report = await target.restore(archive)
    expect(report.manifest.recordingsExcluded).toBe(true)
    expect(report.recordings).toEqual({ added: 0, skipped: 0, failed: 0 })
    expect(report.warnings).toEqual([])
    expect(report.stores.pieces.added).toBe(1)
    expect(await target.listRecordings()).toEqual([])
  })

  it('reads a backup file by slices: exportBackup and restoreBackup work on Blobs end to end', async () => {
    const name = freshName()
    const s = await storage(name)
    await s.saveRecording(take('a'), files(RECORDING_BLOCK_BYTES + 5, 2))
    const db = await raw(name)
    const archive = await exportBackup(db, { now: 7 })
    expect(archive).toBeInstanceOf(Blob)
    let sliced = 0
    const watched = new Proxy(archive, {
      get(target, prop) {
        if (prop === 'slice') {
          return (...args: [number, number]) => {
            sliced += 1
            return target.slice(...args)
          }
        }
        if (prop === 'arrayBuffer') throw new Error('the whole file must not be read')
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? (v as () => unknown).bind(target) : v
      },
    })
    const target = await raw(freshName())
    const report = await restoreBackup(target, watched as Blob)
    expect(report.recordings.added).toBe(1)
    expect(sliced).toBeGreaterThan(2)
  })
})
