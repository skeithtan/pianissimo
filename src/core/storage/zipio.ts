/**
 * Thin zip layer over fflate for backups: a streaming writer that lets the event loop breathe
 * between chunks, and a reader that decompresses one entry at a time under size limits.
 */
import { Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8, unzipSync } from 'fflate'
import type { UnzipFileInfo } from 'fflate'
import { BackupError } from './errors'

const CHUNK_BYTES = 1 << 20
const ZIP_EPOCH_MIN = Date.UTC(1980, 0, 2)
const ZIP_EPOCH_MAX = Date.UTC(2099, 11, 30)
/** Reader limits: a backup is user-supplied input (spec: validate compressed input with size limits). */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_ENTRIES = 50_000

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class ZipWriter {
  readonly #chunks: Uint8Array[] = []
  readonly #zip: Zip
  readonly #mtime: number
  #error: Error | null = null

  constructor(mtime: number) {
    // Zip timestamps only span 1980-2099; a wrong device clock must not make the export fail.
    this.#mtime = Math.min(Math.max(mtime, ZIP_EPOCH_MIN), ZIP_EPOCH_MAX)
    this.#zip = new Zip((err, chunk) => {
      if (err) this.#error = err
      else this.#chunks.push(chunk)
    })
  }

  /** Add an entry. `compress: false` stores it (for data that is already compressed). */
  async add(name: string, data: Uint8Array, compress = true): Promise<void> {
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

  finish(): Uint8Array {
    this.#zip.end()
    if (this.#error) throw this.#error
    let total = 0
    for (const c of this.#chunks) total += c.length
    const out = new Uint8Array(total)
    let at = 0
    for (const c of this.#chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }
}

/** Zip local-file or end-of-central-directory signature ("PK"). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)
}

/** Random access to a zip's entries; each read decompresses only the requested entry. */
export class ZipReader {
  readonly entries: ReadonlyMap<string, UnzipFileInfo>
  readonly #bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    const entries = new Map<string, UnzipFileInfo>()
    let total = 0
    try {
      unzipSync(bytes, {
        filter(info) {
          if (info.name.endsWith('/')) return false
          if (entries.size >= MAX_ENTRIES) throw new BackupError('too-large', 'The backup has too many files.')
          if (info.originalSize > MAX_ENTRY_BYTES) {
            throw new BackupError('too-large', `${info.name} is too large to restore (${info.originalSize} bytes).`)
          }
          total += info.originalSize
          if (total > MAX_TOTAL_BYTES) throw new BackupError('too-large', 'The backup is too large to restore.')
          entries.set(info.name, { ...info })
          return false
        },
      })
    } catch (error) {
      throw asBackupError(error)
    }
    this.entries = entries
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  names(prefix: string): string[] {
    return [...this.entries.keys()].filter((n) => n.startsWith(prefix))
  }

  size(name: string): number | undefined {
    return this.entries.get(name)?.originalSize
  }

  read(name: string): Uint8Array {
    try {
      const out = unzipSync(this.#bytes, { filter: (info) => info.name === name })
      const data = out[name]
      if (!data) throw new BackupError('damaged', `The backup is missing ${name}.`)
      return data
    } catch (error) {
      throw asBackupError(error, name)
    }
  }

  json(name: string): unknown {
    const text = strFromU8(this.read(name))
    try {
      return JSON.parse(text)
    } catch {
      throw new BackupError('damaged', `${name} in the backup is not readable (invalid JSON).`)
    }
  }
}

function asBackupError(error: unknown, name?: string): BackupError {
  if (error instanceof BackupError) return error
  const where = name === undefined ? '' : ` while reading ${name}`
  return new BackupError('damaged', `The backup file is damaged or is not a zip archive${where}.`)
}
