import 'fake-indexeddb/auto'
import { unwrap } from 'idb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordingInfo } from '../recording/records'
import { RECORDING_BLOCK_BYTES, blockRange, convertLegacyTakes } from './recordings'
import type { RecordingFilesMeta } from './recordings'
import { DB_VERSION, INITIAL_LIBRARY_KEY, openPianissimoDb } from './schema'
import type { Db } from './schema'
import { openStorage } from './storage'
import { attemptFor, freshName, makePackage, makePiece } from './testkit'

const opened: Array<{ close(): void }> = []
afterEach(() => {
  for (const c of opened.splice(0)) c.close()
  vi.restoreAllMocks()
})

function done(request: IDBRequest | IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    if (request instanceof IDBTransaction) {
      request.oncomplete = () => resolve()
      request.onerror = () => reject(request.error)
    } else {
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    }
  })
}

/** Schema 3, created the way that version's upgrade created it. */
function openVersion3(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      const pieces = db.createObjectStore('pieces', { keyPath: 'id' })
      pieces.createIndex('lastOpenedAt', 'lastOpenedAt')
      pieces.createIndex('scoreVersionId', 'scoreVersionId')
      db.createObjectStore('sources')
      db.createObjectStore('packages')
      db.createObjectStore('settings')
      const attempts = db.createObjectStore('attempts', { keyPath: 'id' })
      attempts.createIndex('pieceId', 'pieceId')
      attempts.createIndex('contextKey', 'contextKey')
      db.createObjectStore('measureHistory').createIndex('pieceId', 'pieceId')
      db.createObjectStore('suggestionState', { keyPath: 'pieceId' })
      db.createObjectStore('abandonEvents').createIndex('pieceId', 'pieceId')
      db.createObjectStore('layoutCache', { keyPath: 'key' })
      const meta = db.createObjectStore('layoutMeta', { keyPath: 'key' })
      meta.createIndex('scoreVersionId', 'scoreVersionId')
      meta.createIndex('lastUsedAt', 'lastUsedAt')
      db.createObjectStore('recordings', { keyPath: 'id' })
      db.createObjectStore('recordingFiles')
      db.createObjectStore('libraryState').put('complete', INITIAL_LIBRARY_KEY)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function pattern(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 13 + seed) & 0xff
  return out
}

function info(id: string): RecordingInfo {
  return {
    id,
    pieceId: 'piece-v1',
    title: `Take ${id}`,
    context: '[]',
    passage: 'Whole piece',
    hands: 'both',
    createdAt: 1,
    durationMs: 1,
    input: 'Piano',
    score: { expected: 1, played: 1, matched: 1 },
    interrupted: false,
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length &&
  Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length))

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A schema 3 library: one piece with a result, and takes in the schema 3 shape. */
async function version3Library(name: string) {
  const db = await openVersion3(name)
  const pkg = makePackage('v1')
  const piece = makePiece(pkg)
  const attempt = attemptFor(piece.id, [[1, 'clean']])
  const long = [pattern(RECORDING_BLOCK_BYTES, 1), pattern(RECORDING_BLOCK_BYTES, 2), pattern(777, 3)]
  const short = [pattern(5000, 4)]
  const tx = db.transaction(['pieces', 'packages', 'attempts', 'recordings', 'recordingFiles'], 'readwrite')
  tx.objectStore('pieces').put(piece)
  tx.objectStore('packages').put(pkg, 'v1')
  tx.objectStore('attempts').put(attempt)
  for (const id of ['long', 'short', 'silent']) tx.objectStore('recordings').put(info(id))
  const files = tx.objectStore('recordingFiles')
  files.put({ midi: pattern(40, 5).buffer, audio: long.map((p) => p.buffer) }, 'long')
  files.put({ midi: pattern(30, 6).buffer, audio: short.map((p) => p.buffer) }, 'short')
  files.put({ midi: pattern(20, 7).buffer, audio: [] }, 'silent')
  await done(tx)
  return { db, piece, pkg, attempt, long, short }
}

describe('upgrade from schema 3', () => {
  it('moves every take to blocks, byte for byte, and keeps the library and results', async () => {
    const name = freshName()
    const old = await version3Library(name)
    old.db.close()

    const storage = await openStorage(name)
    opened.push(storage)
    const db = await openPianissimoDb(name)
    opened.push(db)
    expect(db.version).toBe(DB_VERSION)

    expect((await storage.listRecordings()).map((r) => r.id).sort()).toEqual(['long', 'short', 'silent'])
    expect(await db.get('recordingFiles', 'long')).toMatchObject({
      type: 'audio/wav',
      blocks: 3,
      bytes: 2 * RECORDING_BLOCK_BYTES + 777,
    })
    expect('audio' in (await db.get('recordingFiles', 'long'))!).toBe(false)
    expect((await db.getAll('recordingBlocks', blockRange('long'))).map((b) => b.byteLength)).toEqual([
      RECORDING_BLOCK_BYTES,
      RECORDING_BLOCK_BYTES,
      777,
    ])
    const long = await storage.getRecordingFiles('long')
    expect(sameBytes(new Uint8Array(await long!.audio.arrayBuffer()), concat(old.long))).toBe(true)
    expect(sameBytes(new Uint8Array(await long!.midi.arrayBuffer()), pattern(40, 5))).toBe(true)
    const short = await storage.getRecordingFiles('short')
    expect(sameBytes(new Uint8Array(await short!.audio.arrayBuffer()), old.short[0]!)).toBe(true)

    // A take with no audio converts to zero blocks.
    expect(await db.get('recordingFiles', 'silent')).toMatchObject({ blocks: 0, bytes: 0 })
    expect((await storage.getRecordingFiles('silent'))!.audio.size).toBe(0)

    expect(await storage.getPiece(old.piece.id)).toEqual(old.piece)
    expect(await storage.getPackage('v1')).toEqual(old.pkg)
    expect(await storage.getAttempt(old.attempt.id)).toEqual(old.attempt)
  })

  it('converting again changes nothing', async () => {
    const name = freshName()
    ;(await version3Library(name)).db.close()
    const db: Db = await openPianissimoDb(name)
    opened.push(db)
    const before = {
      files: await db.getAll('recordingFiles'),
      blocks: await db.getAll('recordingBlocks'),
    }
    const tx = db.transaction(['recordingFiles', 'recordingBlocks'], 'readwrite')
    await convertLegacyTakes(unwrap(tx))
    await tx.done
    expect(await db.getAll('recordingFiles')).toEqual(before.files)
    expect((await db.getAll('recordingBlocks')).map((b) => b.byteLength)).toEqual(
      before.blocks.map((b) => b.byteLength),
    )
  })

  it('keeps a take it cannot convert readable in the schema 3 shape and converts the others', async () => {
    const name = freshName()
    const old = await version3Library(name)
    old.db.close()
    // The second block of "long" fails to store (asynchronously, as a quota error would).
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'recordingBlocks' && Array.isArray(key) && key[0] === 'long' && key[1] === 1) {
        this.add(value, key)
        return this.add(value, key) // fails: the key exists
      }
      return put.call(this, value, key)
    })
    const db = await openPianissimoDb(name)
    opened.push(db)
    vi.restoreAllMocks()
    expect(db.version).toBe(DB_VERSION)
    expect('audio' in (await db.get('recordingFiles', 'long'))!).toBe(true)
    expect(await db.count('recordingBlocks', blockRange('long'))).toBe(0)
    expect((await db.get('recordingFiles', 'short')) as RecordingFilesMeta).toMatchObject({ blocks: 1 })
    db.close()

    const storage = await openStorage(name)
    opened.push(storage)
    const long = await storage.getRecordingFiles('long')
    expect(sameBytes(new Uint8Array(await long!.audio.arrayBuffer()), concat(old.long))).toBe(true)
    expect((await storage.listRecordings()).length).toBe(3)
  })

  it('opens without converting when the upgrade fails as a whole, keeping every take readable', async () => {
    const name = freshName()
    const old = await version3Library(name)
    old.db.close()
    const put = IDBObjectStore.prototype.put
    let aborted = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'recordingBlocks' && !aborted) {
        aborted = true
        this.transaction.abort()
      }
      return put.call(this, value, key)
    })
    const storage = await openStorage(name)
    opened.push(storage)
    vi.restoreAllMocks()
    expect(aborted).toBe(true)
    const db = await openPianissimoDb(name)
    opened.push(db)
    expect(db.version).toBe(DB_VERSION)
    expect([...db.objectStoreNames]).toContain('recordingBlocks')
    expect('audio' in (await db.get('recordingFiles', 'long'))!).toBe(true)
    const long = await storage.getRecordingFiles('long')
    expect(sameBytes(new Uint8Array(await long!.audio.arrayBuffer()), concat(old.long))).toBe(true)
    expect(await storage.getPiece(old.piece.id)).toEqual(old.piece)
  })
})

describe('other tabs', () => {
  it('reports a blocked upgrade and opens once the old tab lets go', async () => {
    const name = freshName()
    // An old tab that never reacts to the upgrade request (a frozen tab, an older app version).
    const old = await openVersion3(name)
    const onBlocked = vi.fn()
    let settled = false
    const opening = openStorage(name, { onBlocked }).then((s) => {
      settled = true
      return s
    })
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    old.close()
    const storage = await opening
    opened.push(storage)
    expect(await storage.listRecordings()).toEqual([])
  })

  it('closes its own connection when a newer version asks, so that upgrade is not blocked', async () => {
    const name = freshName()
    const db = await openPianissimoDb(name)
    const blocked = vi.fn()
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION + 1)
      request.onblocked = blocked
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    newer.close()
    expect(blocked).not.toHaveBeenCalled()
    await expect(db.get('settings', 'app')).rejects.toThrow()
  })
})
