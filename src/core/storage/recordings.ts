/**
 * Recorded takes in IndexedDB (schema 4). A take is stored as:
 *
 *   recordings[id]               RecordingInfo: the only store that lists read (`discardedAt`: see markTakes)
 *   recordingFiles[id]           { midi, type, blocks, bytes }: the MIDI file and what to expect below
 *   recordingBlocks[[id, i]]     the WAV file's bytes, block i, at most RECORDING_BLOCK_BYTES
 *   pendingRecordings[id]        { startedAt } while the blocks of a take are being written
 *
 * Takes written by schema 3 kept every block inline: `recordingFiles[id] = { midi, audio: [...] }`.
 * The version 4 upgrade converts them; one it could not convert keeps that shape, and every
 * reader here accepts both.
 *
 * Chrome refuses any single stored value above about 127 MiB, so a long take can only be stored
 * in blocks. Blocks are written one transaction at a time, reading the source one block at a
 * time, so no more than one block of a take is held in memory. The take becomes visible
 * (listed, readable) only in the last transaction, which also checks that every block is there.
 */
import type { RecordingFiles, RecordingInfo } from '../recording/records'
import type { Db } from './schema'
import { runTx } from './tx'

/**
 * Audio bytes per stored block: 4 MiB. Far below Chrome's 127 MiB per-value limit, small enough
 * that one block in memory is nothing on a 4 GB tablet, and large enough that an hour of 48 kHz
 * stereo audio (about 690 MB) is under 200 records. It is also the block size schema 3 used, so
 * converted takes and older backups keep their blocks as they are.
 */
export const RECORDING_BLOCK_BYTES = 4 * 1024 * 1024
export const RECORDING_AUDIO_TYPE = 'audio/wav'
/** A take whose blocks were still being written this long ago was abandoned (a closed page). */
export const ABANDONED_WRITE_MS = 60 * 60_000
/** A discarded take can be brought back this long at least. A later open removes it. */
export const DISCARDED_KEEP_MS = 10 * 60_000
/** Blocks read per key-range request when a take is read back. */
const BLOCKS_PER_READ = 2

/** Schema 3 shape: the whole WAV file inline. Read, never written. */
export interface LegacyRecordingFiles {
  readonly midi: ArrayBuffer
  readonly audio: readonly ArrayBuffer[]
}

/** Schema 4 shape: the WAV file is `blocks` records in `recordingBlocks`, `bytes` in total. */
export interface RecordingFilesMeta {
  readonly midi: ArrayBuffer
  readonly type: string
  readonly blocks: number
  readonly bytes: number
}

export type RecordingFilesRecord = LegacyRecordingFiles | RecordingFilesMeta

export interface PendingRecording {
  readonly startedAt: number
}

export interface RecordingsSummary {
  /** Takes on this device. */
  readonly count: number
  /** Their MIDI and WAV bytes: about what they add to a backup. */
  readonly bytes: number
}

export function isLegacyFiles(record: RecordingFilesRecord): record is LegacyRecordingFiles {
  return Array.isArray((record as LegacyRecordingFiles).audio)
}

/** Every block key of one take. */
export function blockRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Infinity])
}

/** MIDI plus WAV bytes of a stored take. */
export function filesBytes(record: RecordingFilesRecord): number {
  const audio = isLegacyFiles(record) ? record.audio.reduce((sum, block) => sum + block.byteLength, 0) : record.bytes
  return record.midi.byteLength + audio
}

/** An ArrayBuffer holding exactly these bytes (copied only when the view is part of a larger one). */
function ownBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer) {
    return view.buffer
  }
  return view.slice().buffer
}

/** A Blob's bytes one block at a time, read by slicing it. */
export async function* blobBlocks(blob: Blob): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < blob.size; at += RECORDING_BLOCK_BYTES) {
    yield new Uint8Array(await blob.slice(at, at + RECORDING_BLOCK_BYTES).arrayBuffer())
  }
}

export interface TakeWrite {
  readonly info: RecordingInfo
  readonly midi: ArrayBuffer
  readonly type: string
  /** The WAV file in order. Each chunk becomes one block or, above the block size, several. */
  readonly audio: AsyncIterable<Uint8Array>
  /** The expected WAV size when known: a different total fails the write. */
  readonly bytes?: number
}

/**
 * Store a take. A `pendingRecordings` marker names it while its blocks are written; a write that
 * fails removes what it wrote, and one cut short by a closed page is removed by
 * `discardAbandonedWrites` on a later open. Resolves false, writing nothing, when a take with
 * this id is already stored. A discarded one gives way to it.
 */
export async function writeTake(db: Db, take: TakeWrite, now: () => number): Promise<boolean> {
  const id = take.info.id
  const begin = db.transaction(['recordings', 'recordingFiles', 'recordingBlocks', 'pendingRecordings'], 'readwrite')
  const exists = await runTx(begin, async () => {
    const stored = await begin.objectStore('recordings').get(id)
    if (stored && stored.discardedAt === undefined) return true
    await begin.objectStore('recordings').delete(id)
    await begin.objectStore('recordingFiles').delete(id)
    await begin.objectStore('recordingBlocks').delete(blockRange(id))
    await begin.objectStore('pendingRecordings').put({ startedAt: now() }, id)
    return false
  })
  if (exists) return false
  try {
    let blocks = 0
    let bytes = 0
    for await (const chunk of take.audio) {
      for (let at = 0; at < chunk.byteLength; at += RECORDING_BLOCK_BYTES) {
        const block = chunk.byteLength <= RECORDING_BLOCK_BYTES ? chunk : chunk.subarray(at, at + RECORDING_BLOCK_BYTES)
        await db.put('recordingBlocks', ownBuffer(block), [id, blocks])
        blocks += 1
        bytes += block.byteLength
      }
    }
    if (take.bytes !== undefined && bytes !== take.bytes) {
      throw new Error(`Recording ${id}: expected ${take.bytes} audio bytes, read ${bytes}.`)
    }
    const finish = db.transaction(['recordings', 'recordingFiles', 'recordingBlocks', 'pendingRecordings'], 'readwrite')
    await runTx(finish, async () => {
      const [marker, stored] = await Promise.all([
        finish.objectStore('pendingRecordings').get(id),
        finish.objectStore('recordingBlocks').count(blockRange(id)),
      ])
      if (!marker || stored !== blocks) throw new Error(`Recording ${id} lost blocks while it was being written.`)
      const meta: RecordingFilesMeta = { midi: take.midi, type: take.type, blocks, bytes }
      await finish.objectStore('recordingFiles').put(meta, id)
      await finish.objectStore('recordings').put(take.info)
      await finish.objectStore('pendingRecordings').delete(id)
    })
    return true
  } catch (error) {
    await discardWrite(db, id).catch(() => undefined)
    throw error
  }
}

/** Remove what an unfinished write of take `id` left; a take that became visible is kept. */
async function discardWrite(db: Db, id: string): Promise<void> {
  const tx = db.transaction(['recordings', 'recordingBlocks', 'pendingRecordings'], 'readwrite')
  await runTx(tx, async () => {
    if ((await tx.objectStore('recordings').getKey(id)) === undefined) {
      await tx.objectStore('recordingBlocks').delete(blockRange(id))
    }
    await tx.objectStore('pendingRecordings').delete(id)
  })
}

/**
 * Remove the blocks of takes whose write started more than `ABANDONED_WRITE_MS` ago (or that
 * many in the future, after a clock change) and never finished. A write still running in another
 * tab is younger than that; were it removed anyway, its last transaction would see the missing
 * blocks and fail instead of listing a broken take.
 */
export async function discardAbandonedWrites(db: Db, now: number): Promise<number> {
  const tx = db.transaction('pendingRecordings', 'readonly')
  const [ids, markers] = await runTx(tx, () => Promise.all([tx.store.getAllKeys(), tx.store.getAll()]))
  let removed = 0
  for (const [i, id] of ids.entries()) {
    const startedAt = markers[i]?.startedAt
    if (typeof startedAt === 'number' && Math.abs(now - startedAt) <= ABANDONED_WRITE_MS) continue
    await discardWrite(db, id)
    removed += 1
  }
  return removed
}

/** A stored take whose blocks do not match its files record (a block is missing or resized). */
export class DamagedTakeError extends Error {
  constructor(id: string) {
    super(`Recording ${id} is missing audio blocks.`)
    this.name = 'DamagedTakeError'
  }
}

/**
 * A take's WAV bytes in order, read by key range a couple of blocks at a time, so a caller never
 * holds more than that in memory. Throws `DamagedTakeError` when the blocks do not add up.
 */
export async function* readBlocks(db: Db, id: string, meta: RecordingFilesMeta): AsyncGenerator<ArrayBuffer> {
  let bytes = 0
  for (let first = 0; first < meta.blocks; first += BLOCKS_PER_READ) {
    const last = Math.min(meta.blocks, first + BLOCKS_PER_READ) - 1
    const blocks = await db.getAll('recordingBlocks', IDBKeyRange.bound([id, first], [id, last]))
    if (blocks.length !== last - first + 1) throw new DamagedTakeError(id)
    for (const block of blocks) {
      bytes += block.byteLength
      yield block
    }
  }
  if (bytes !== meta.bytes) throw new DamagedTakeError(id)
}

/**
 * The MIDI and WAV files of a take as Blobs. The WAV Blob is assembled from one Blob per block,
 * so building it copies each block once and keeps no ArrayBuffer of the whole file.
 */
export async function readTakeFiles(db: Db, id: string): Promise<RecordingFiles | undefined> {
  const record = await db.get('recordingFiles', id)
  if (!record) return undefined
  const midi = new Blob([record.midi], { type: 'audio/midi' })
  if (isLegacyFiles(record)) return { midi, audio: new Blob([...record.audio], { type: RECORDING_AUDIO_TYPE }) }
  const parts: Blob[] = []
  for await (const block of readBlocks(db, id, record)) parts.push(new Blob([block]))
  return { midi, audio: new Blob(parts, { type: record.type }) }
}

/** The takes of this device, without the discarded ones. */
export async function listTakes(db: Db): Promise<RecordingInfo[]> {
  return (await db.getAll('recordings')).filter((info) => info.discardedAt === undefined)
}

/** The MIDI file of a take, without reading its audio. */
export async function readTakeMidi(db: Db, id: string): Promise<ArrayBuffer | undefined> {
  return (await db.get('recordingFiles', id))?.midi
}

/**
 * Discard takes, or bring discarded ones back (`discardedAt` null): one transaction over their
 * infos, however large their files, so that it is done at once and survives a closed page.
 */
export async function markTakes(db: Db, ids: readonly string[], discardedAt: number | null): Promise<void> {
  const tx = db.transaction('recordings', 'readwrite')
  await runTx(tx, async () => {
    for (const id of ids) {
      const stored = await tx.store.get(id)
      if (!stored) continue
      const { discardedAt: _, ...info } = stored
      await tx.store.put(discardedAt === null ? info : { ...info, discardedAt })
    }
  })
}

/**
 * Remove a discarded take for good: its info, files record, every block and any unfinished-write
 * marker. One that was brought back, or restored from a backup, meanwhile is left alone.
 */
export async function removeDiscarded(db: Db, id: string): Promise<void> {
  const tx = db.transaction(['recordings', 'recordingFiles', 'recordingBlocks', 'pendingRecordings'], 'readwrite')
  await runTx(tx, async () => {
    if ((await tx.objectStore('recordings').get(id))?.discardedAt === undefined) return
    await tx.objectStore('recordings').delete(id)
    await tx.objectStore('recordingFiles').delete(id)
    await tx.objectStore('recordingBlocks').delete(blockRange(id))
    await tx.objectStore('pendingRecordings').delete(id)
  })
}

/** Remove the takes a page discarded and did not live to remove. Another tab's Undo is younger than that. */
export async function removeLongDiscarded(db: Db, now: number): Promise<void> {
  for (const { id, discardedAt } of await db.getAll('recordings'))
    if (discardedAt !== undefined && Math.abs(now - discardedAt) > DISCARDED_KEEP_MS) await removeDiscarded(db, id)
}

/** The number of listed takes and their file sizes. Reads only small records for converted takes. */
export async function summarizeTakes(db: Db): Promise<RecordingsSummary> {
  const tx = db.transaction(['recordings', 'recordingFiles'], 'readonly')
  return runTx(tx, async () => {
    const infos = await tx.objectStore('recordings').getAll()
    const listed = new Set(infos.filter((info) => info.discardedAt === undefined).map((info) => info.id))
    let count = 0
    let bytes = 0
    let cursor = await tx.objectStore('recordingFiles').openCursor()
    while (cursor) {
      if (listed.has(cursor.key)) {
        count += 1
        bytes += filesBytes(cursor.value)
      }
      cursor = await cursor.continue()
    }
    return { count, bytes }
  })
}

/** Resolve or reject with an IndexedDB request. `tolerate` keeps a failure from aborting the transaction. */
function request<T>(req: IDBRequest<T>, tolerate = false): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = (event) => {
      if (tolerate) {
        event.preventDefault()
        event.stopPropagation()
      }
      reject(req.error)
    }
  })
}

function convertible(record: unknown): record is LegacyRecordingFiles {
  if (typeof record !== 'object' || record === null) return false
  const { midi, audio } = record as Partial<LegacyRecordingFiles>
  return midi instanceof ArrayBuffer && Array.isArray(audio) && audio.every((block) => block instanceof ArrayBuffer)
}

/**
 * Move every schema 3 take to blocks inside the version 4 upgrade transaction (raw IndexedDB, so
 * a failed write can be kept from aborting the upgrade). Takes are read one at a time. Already
 * converted takes are skipped, so it is safe to run again. A take that cannot be converted keeps
 * its schema 3 record and loses only the blocks written for it here.
 */
export async function convertLegacyTakes(tx: IDBTransaction): Promise<void> {
  const files = tx.objectStore('recordingFiles')
  const blocks = tx.objectStore('recordingBlocks')
  const ids = (await request(files.getAllKeys())) as string[]
  for (const id of ids) {
    const record: unknown = await request(files.get(id))
    if (!convertible(record)) continue
    try {
      let index = 0
      let bytes = 0
      for (const buffer of record.audio) {
        for (let at = 0; at < buffer.byteLength; at += RECORDING_BLOCK_BYTES) {
          const block =
            buffer.byteLength <= RECORDING_BLOCK_BYTES ? buffer : buffer.slice(at, at + RECORDING_BLOCK_BYTES)
          await request(blocks.put(block, [id, index]), true)
          index += 1
          bytes += block.byteLength
        }
      }
      const meta: RecordingFilesMeta = { midi: record.midi, type: RECORDING_AUDIO_TYPE, blocks: index, bytes }
      await request(files.put(meta, id), true)
    } catch {
      await request(blocks.delete(blockRange(id)), true).catch(() => undefined)
    }
  }
}
