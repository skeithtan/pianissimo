import { msg } from '../../i18n/messages'
/**
 * Thin zip layer for backups.
 *
 * - `ZipWriter` streams entries through fflate and keeps the archive as a list of Blob parts, so
 *   no array of the whole archive ever exists and a block handed to it can be released as soon
 *   as it is added. It counts entries and bytes against the reader's limits.
 * - `ZipReader` reads the central directory of a Blob (a picked file) or a byte array itself and
 *   reads entries by slicing the source, so a large backup file is never loaded whole. Deflated
 *   entries are inflated by fflate under size limits.
 */
import { Zip, ZipDeflate, ZipPassThrough, inflateSync, strFromU8, strToU8 } from 'fflate'
import { BackupError } from './errors'

const CHUNK_BYTES = 1 << 20
/** The writer gathers small chunks into Blob parts of about this size. */
const PART_BYTES = 1 << 20
const ZIP_EPOCH_MIN = Date.UTC(1980, 0, 2)
const ZIP_EPOCH_MAX = Date.UTC(2099, 11, 30)
/** Reader limits: a backup is user-supplied input (spec: validate compressed input with size limits). */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_ENTRIES = 50_000
/** Larger than any central directory of `MAX_ENTRIES` entries with ordinary names. */
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** The archive would break a reader limit (`MAX_ENTRY_BYTES`, `MAX_TOTAL_BYTES`, `MAX_ENTRIES`). */
export class ZipLimitError extends Error {
  constructor(name: string) {
    super(`${name} does not fit the backup size limits`)
    this.name = 'ZipLimitError'
  }
}

export class ZipWriter {
  readonly #parts: Blob[] = []
  #pending: Uint8Array[] = []
  #pendingBytes = 0
  readonly #zip: Zip
  readonly #mtime: number
  #error: Error | null = null
  #entries = 0
  #bytes = 0

  constructor(mtime: number) {
    // Zip timestamps only span 1980-2099; a wrong device clock must not make the export fail.
    this.#mtime = Math.min(Math.max(mtime, ZIP_EPOCH_MIN), ZIP_EPOCH_MAX)
    this.#zip = new Zip((err, chunk) => {
      if (err) {
        this.#error = err
        return
      }
      this.#pending.push(chunk)
      this.#pendingBytes += chunk.length
      if (this.#pendingBytes >= PART_BYTES) this.#flush()
    })
  }

  /** Entries added so far. */
  get entries(): number {
    return this.#entries
  }

  /** Uncompressed bytes added so far: what the reader's total limit counts. */
  get bytes(): number {
    return this.#bytes
  }

  /** Whether `count` more entries holding `bytes` in all still fit the reader's limits. */
  fits(bytes: number, count = 1): boolean {
    return this.#entries + count <= MAX_ENTRIES && this.#bytes + bytes <= MAX_TOTAL_BYTES
  }

  /**
   * Add an entry. `compress: false` stores it (for data that is already compressed, and audio).
   * Throws `ZipLimitError`, adding nothing, when it would break a reader limit.
   */
  async add(name: string, data: Uint8Array, compress = true): Promise<void> {
    if (data.length > MAX_ENTRY_BYTES || !this.fits(data.length)) throw new ZipLimitError(name)
    this.#entries += 1
    this.#bytes += data.length
    const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
    file.mtime = this.#mtime
    this.#zip.add(file)
    if (data.length === 0) {
      file.push(data, true)
    } else {
      for (let at = 0; at < data.length; at += CHUNK_BYTES) {
        const end = Math.min(data.length, at + CHUNK_BYTES)
        file.push(data.subarray(at, end), end >= data.length)
        if (data.length > CHUNK_BYTES) await yieldToEventLoop()
      }
    }
    if (this.#error) throw this.#error
  }

  addJson(name: string, value: unknown): Promise<void> {
    return this.add(name, strToU8(JSON.stringify(value)))
  }

  /** The finished archive, assembled from its parts (no copy of the whole). */
  finish(): Blob {
    this.#zip.end()
    if (this.#error) throw this.#error
    this.#flush()
    return new Blob(this.#parts, { type: 'application/zip' })
  }

  /** Copy the pending chunks into one Blob part and let go of them. */
  #flush(): void {
    if (this.#pending.length === 0) return
    this.#parts.push(new Blob(this.#pending as Uint8Array<ArrayBuffer>[]))
    this.#pending = []
    this.#pendingBytes = 0
  }
}

/** What a backup is read from: a picked file (sliced, never read whole) or bytes in memory. */
export type ZipSource = Blob | Uint8Array

function sourceSize(source: ZipSource): number {
  return source instanceof Uint8Array ? source.length : source.size
}

async function readRange(source: ZipSource, start: number, end: number): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source.subarray(start, end)
  return new Uint8Array(await source.slice(start, end).arrayBuffer())
}

/** Zip local-file or end-of-central-directory signature ("PK") at the start of the source. */
export async function looksLikeZip(source: ZipSource): Promise<boolean> {
  if (sourceSize(source) < 22) return false
  const head = await readRange(source, 0, 4)
  return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)
}

const u16 = (d: Uint8Array, o: number): number => (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8)
const u32 = (d: Uint8Array, o: number): number => (u16(d, o) | (u16(d, o + 2) << 16)) >>> 0

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

interface ZipEntry {
  readonly name: string
  readonly flags: number
  readonly method: number
  readonly compressedSize: number
  readonly size: number
  /** Offset of the local header. */
  readonly offset: number
  /** Local header length as the central directory predicts it (the real one is read). */
  readonly headerGuess: number
}

function damaged(name?: string): BackupError {
  const where = name === undefined ? '' : msg(' while reading {0}', name)
  return new BackupError('damaged', msg('The backup file is damaged or is not a zip archive{0}.', where))
}

async function readDirectory(source: ZipSource): Promise<Map<string, ZipEntry>> {
  const size = sourceSize(source)
  const tailStart = Math.max(0, size - (22 + 0xffff))
  const tail = await readRange(source, tailStart, size)
  let e = tail.length - 22
  while (e >= 0 && u32(tail, e) !== EOCD) e--
  if (e < 0) throw damaged()
  const count = u16(tail, e + 10)
  const directorySize = u32(tail, e + 12)
  const directoryOffset = u32(tail, e + 16)
  // Zip64 markers: backups never need them, and an archive that does is beyond the limits.
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new BackupError('too-large', msg('The backup is too large to restore.'))
  }
  if (directoryOffset + directorySize > tailStart + e) throw damaged()
  if (directorySize > MAX_DIRECTORY_BYTES) throw new BackupError('too-large', msg('The backup has too many files.'))
  const directory = await readRange(source, directoryOffset, directoryOffset + directorySize)
  const entries = new Map<string, ZipEntry>()
  let total = 0
  let o = 0
  for (let i = 0; i < count; i++) {
    if (o + 46 > directory.length || u32(directory, o) !== CENTRAL) throw damaged()
    const flags = u16(directory, o + 8)
    const nameLength = u16(directory, o + 28)
    const extraLength = u16(directory, o + 30)
    const commentLength = u16(directory, o + 32)
    if (o + 46 + nameLength > directory.length) throw damaged()
    const raw = directory.subarray(o + 46, o + 46 + nameLength)
    const name = flags & 0x800 ? strFromU8(raw) : strFromU8(raw, true)
    const entry: ZipEntry = {
      name,
      flags,
      method: u16(directory, o + 10),
      compressedSize: u32(directory, o + 20),
      size: u32(directory, o + 24),
      offset: u32(directory, o + 42),
      headerGuess: 30 + nameLength + extraLength,
    }
    o += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (entries.size >= MAX_ENTRIES) throw new BackupError('too-large', msg('The backup has too many files.'))
    if (entry.size > MAX_ENTRY_BYTES) {
      throw new BackupError('too-large', msg('{0} is too large to restore ({1} bytes).', name, entry.size))
    }
    total += entry.size
    if (total > MAX_TOTAL_BYTES) throw new BackupError('too-large', msg('The backup is too large to restore.'))
    entries.set(name, entry)
  }
  return entries
}

/** The entry's data after decompression, checked against the declared size. */
function decode(entry: ZipEntry, raw: Uint8Array): Uint8Array {
  if (entry.flags & 1) throw damaged(entry.name)
  let data: Uint8Array
  try {
    if (entry.method === 0) data = raw
    else if (entry.method === 8) data = inflateSync(raw, { out: new Uint8Array(entry.size) })
    else throw damaged(entry.name)
  } catch (error) {
    throw asBackupError(error, entry.name)
  }
  if (data.length !== entry.size) throw damaged(entry.name)
  return data
}

/** Random access to a zip's entries; only what is asked for is read and decompressed. */
export class ZipReader {
  readonly #source: ZipSource
  readonly #entries: ReadonlyMap<string, ZipEntry>
  /** Stored (still compressed) data of the entries loaded by `load`. */
  readonly #loaded = new Map<string, Uint8Array>()

  private constructor(source: ZipSource, entries: ReadonlyMap<string, ZipEntry>) {
    this.#source = source
    this.#entries = entries
  }

  /** Read the central directory. Throws `BackupError` for a damaged archive or one over the limits. */
  static async open(source: ZipSource): Promise<ZipReader> {
    try {
      return new ZipReader(source, await readDirectory(source))
    } catch (error) {
      throw asBackupError(error)
    }
  }

  has(name: string): boolean {
    return this.#entries.has(name)
  }

  names(prefix: string): string[] {
    return [...this.#entries.keys()].filter((n) => n.startsWith(prefix))
  }

  size(name: string): number | undefined {
    return this.#entries.get(name)?.size
  }

  /**
   * Bring the stored data of the matching entries into memory, so `read` and `json` can return
   * them synchronously (inside a database transaction). Neighboring entries are read in one
   * slice of the source.
   */
  async load(filter: (name: string) => boolean): Promise<void> {
    const wanted = [...this.#entries.values()]
      .filter((e) => filter(e.name) && !this.#loaded.has(e.name))
      .sort((a, b) => a.offset - b.offset)
    const size = sourceSize(this.#source)
    const slack = 1024
    const reach = (e: ZipEntry): number => Math.min(size, e.offset + e.headerGuess + e.compressedSize + slack)
    try {
      for (let i = 0; i < wanted.length;) {
        const start = wanted[i]!.offset
        let end = reach(wanted[i]!)
        let j = i
        while (
          j + 1 < wanted.length &&
          wanted[j + 1]!.offset <= end + 64 * 1024 &&
          reach(wanted[j + 1]!) - start <= 16 << 20
        ) {
          j += 1
          end = Math.max(end, reach(wanted[j]!))
        }
        const run = await readRange(this.#source, start, end)
        for (let k = i; k <= j; k++) {
          const entry = wanted[k]!
          const at = entry.offset - start
          const local =
            at + 30 <= run.length && u32(run, at) === LOCAL ? at + 30 + u16(run, at + 26) + u16(run, at + 28) : -1
          this.#loaded.set(
            entry.name,
            local >= 0 && local + entry.compressedSize <= run.length
              ? run.subarray(local, local + entry.compressedSize)
              : await this.#stored(entry),
          )
        }
        i = j + 1
      }
    } catch (error) {
      throw asBackupError(error)
    }
  }

  /** A loaded entry, decompressed. */
  read(name: string): Uint8Array {
    const entry = this.#entries.get(name)
    const raw = this.#loaded.get(name)
    if (!entry || !raw) throw new BackupError('damaged', msg('The backup is missing {0}.', name))
    return decode(entry, raw)
  }

  json(name: string): unknown {
    const text = strFromU8(this.read(name))
    try {
      return JSON.parse(text)
    } catch {
      throw new BackupError('damaged', msg('{0} in the backup is not readable (invalid JSON).', name))
    }
  }

  /** Any entry, decompressed, read from the source now. */
  async fetch(name: string): Promise<Uint8Array> {
    const entry = this.#entry(name)
    return decode(entry, await this.#stored(entry))
  }

  /**
   * An entry in pieces of at most `max` bytes. A stored entry (as audio is) is sliced from the
   * source piece by piece, so it is never in memory whole.
   */
  async *pieces(name: string, max: number): AsyncGenerator<Uint8Array> {
    const entry = this.#entry(name)
    if (entry.method === 0 && !(entry.flags & 1)) {
      if (entry.compressedSize !== entry.size) throw damaged(name)
      const start = await this.#dataStart(entry)
      for (let at = 0; at < entry.size; at += max) {
        const piece = await readRange(this.#source, start + at, start + Math.min(entry.size, at + max))
        if (piece.length !== Math.min(max, entry.size - at)) throw damaged(name)
        yield piece
      }
      return
    }
    const data = await this.fetch(name)
    for (let at = 0; at < data.length; at += max) yield data.subarray(at, at + max)
  }

  #entry(name: string): ZipEntry {
    const entry = this.#entries.get(name)
    if (!entry) throw new BackupError('damaged', msg('The backup is missing {0}.', name))
    return entry
  }

  async #dataStart(entry: ZipEntry): Promise<number> {
    const header = await readRange(this.#source, entry.offset, entry.offset + 30)
    if (header.length < 30 || u32(header, 0) !== LOCAL) throw damaged(entry.name)
    const start = entry.offset + 30 + u16(header, 26) + u16(header, 28)
    if (start + entry.compressedSize > sourceSize(this.#source)) throw damaged(entry.name)
    return start
  }

  async #stored(entry: ZipEntry): Promise<Uint8Array> {
    const start = await this.#dataStart(entry)
    return readRange(this.#source, start, start + entry.compressedSize)
  }
}

function asBackupError(error: unknown, name?: string): BackupError {
  if (error instanceof BackupError) return error
  return damaged(name)
}
