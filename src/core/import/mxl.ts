/**
 * Compressed MusicXML (.mxl) reading with fflate.
 *
 * Spec: validate compressed input with size and expansion limits. Declared sizes are checked
 * against the limits *before* anything is inflated, only the container and the referenced
 * rootfiles are expanded, and each expanded entry is verified against its CRC-32 so a damaged
 * archive produces a clear message instead of silently truncated XML.
 */
import { Inflate, unzipSync } from 'fflate'
import { ImportError } from './errors'
import type { ImportLimits } from './limits'
import { decodeXmlBytes } from './text'
import { attr, childrenNamed, child, parseXmlDocument } from './xml'
import type { DiagnosticSink } from './diagnostics'

export interface ZipEntryInfo {
  readonly name: string
  readonly compressedSize: number
  readonly size: number
  readonly compression: number
}

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06)
  )
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = -1
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

interface CentralEntry {
  readonly crc: number
  readonly compressedSize: number
  readonly size: number
  readonly localOffset: number
}

function u16At(d: Uint8Array, o: number): number {
  return (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8)
}

function u32At(d: Uint8Array, o: number): number {
  return (u16At(d, o) | (u16At(d, o + 2) << 16)) >>> 0
}

function u64At(d: Uint8Array, o: number): number {
  return u32At(d, o) + u32At(d, o + 4) * 0x1_0000_0000
}

/** Central-directory metadata per entry name (CRC-32, sizes, and local-header offset). */
function centralDirectoryEntries(d: Uint8Array): Map<string, CentralEntry> {
  const out = new Map<string, CentralEntry>()
  let e = d.length - 22
  while (e >= 0 && u32At(d, e) !== 0x06054b50) {
    if (d.length - e > 65558) return out
    e--
  }
  if (e < 0) return out
  let count = u16At(d, e + 10)
  let o = u32At(d, e + 16)
  const z64 = e >= 20 ? u32At(d, e - 20) === 0x07064b50 : false
  if (z64) {
    const ze = u32At(d, e - 12)
    if (u32At(d, ze) === 0x06064b50) {
      count = u32At(d, ze + 32)
      o = u64At(d, ze + 48)
    }
  }
  for (let i = 0; i < count && o + 46 <= d.length; i++) {
    if (u32At(d, o) !== 0x02014b50) break
    const flags = u16At(d, o + 8)
    const crc = u32At(d, o + 16)
    let compressedSize = u32At(d, o + 20)
    let size = u32At(d, o + 24)
    const nameLen = u16At(d, o + 28)
    const extraLen = u16At(d, o + 30)
    const commentLen = u16At(d, o + 32)
    let localOffset = u32At(d, o + 42)
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let eo = o + 46 + nameLen
      const eEnd = eo + extraLen
      while (eo + 4 <= eEnd && eo + 4 <= d.length) {
        const headerId = u16At(d, eo)
        const fieldSize = u16At(d, eo + 2)
        if (headerId === 0x0001) {
          let p = eo + 4
          if (size === 0xffffffff && p + 8 <= eEnd) {
            size = u64At(d, p)
            p += 8
          }
          if (compressedSize === 0xffffffff && p + 8 <= eEnd) {
            compressedSize = u64At(d, p)
            p += 8
          }
          if (localOffset === 0xffffffff && p + 8 <= eEnd) localOffset = u64At(d, p)
          break
        }
        eo += 4 + fieldSize
      }
    }
    const raw = d.subarray(o + 46, o + 46 + nameLen)
    const name = flags & 0x800 ? new TextDecoder().decode(raw) : Array.from(raw, (b) => String.fromCharCode(b)).join('')
    out.set(name, { crc, compressedSize, size, localOffset })
    o += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function damaged(detail: string): ImportError {
  return new ImportError('mxl-damaged', `The compressed MusicXML file is damaged or incomplete (${detail}).`)
}

export function listZipEntries(zip: Uint8Array, limits: ImportLimits): ZipEntryInfo[] {
  const entries: ZipEntryInfo[] = []
  try {
    unzipSync(zip, {
      filter: (f) => {
        entries.push({ name: f.name, compressedSize: f.size, size: f.originalSize, compression: f.compression })
        if (entries.length > limits.maxZipEntries) {
          throw new ImportError(
            'mxl-limits',
            `The compressed file lists more than ${limits.maxZipEntries} entries. It cannot be opened.`,
          )
        }
        return false
      },
    })
  } catch (e) {
    if (e instanceof ImportError) throw e
    throw damaged(e instanceof Error ? e.message : 'unreadable archive')
  }
  return entries
}

/** Expand selected entries after checking declared sizes, ratios and CRCs. */
export class ZipReader {
  private readonly zip: Uint8Array
  private readonly limits: ImportLimits
  readonly entries: ReadonlyMap<string, ZipEntryInfo>
  private meta: Map<string, CentralEntry> | undefined
  private expandedTotal = 0

  constructor(zip: Uint8Array, limits: ImportLimits) {
    this.zip = zip
    this.limits = limits
    this.entries = new Map(listZipEntries(zip, limits).map((e) => [e.name, e]))
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  read(name: string): Uint8Array {
    const info = this.entries.get(name)
    if (!info) throw new ImportError('mxl-rootfile-missing', `The compressed file does not contain “${name}”.`)
    const { limits } = this
    if (info.compression !== 0 && info.compression !== 8) {
      throw damaged(`“${name}” uses unsupported compression method ${info.compression}`)
    }
    if (info.size > limits.maxZipEntryBytes) {
      throw new ImportError(
        'mxl-limits',
        `“${name}” expands to ${Math.round(info.size / 1e6)} MB, above the ${Math.round(limits.maxZipEntryBytes / 1e6)} MB limit.`,
      )
    }
    if (this.expandedTotal + info.size > limits.maxZipTotalBytes) {
      throw new ImportError('mxl-limits', 'The compressed file expands beyond the total size limit.')
    }
    if (info.size >= limits.zipRatioMinBytes && info.size > limits.maxZipRatio * Math.max(1, info.compressedSize)) {
      throw new ImportError(
        'mxl-limits',
        `“${name}” has a suspicious compression ratio (${Math.round(info.size / Math.max(1, info.compressedSize))}:1). It cannot be expanded.`,
      )
    }
    this.meta ??= centralDirectoryEntries(this.zip)
    const central = this.meta.get(name)
    const out = central ? readCentralEntry(this.zip, info, central, limits, this.expandedTotal) : undefined
    if (!out || out.length !== info.size) throw damaged(`“${name}” has the wrong length`)
    if (crc32(out) !== central!.crc) throw damaged(`checksum mismatch in “${name}”`)
    this.expandedTotal += info.size
    return out
  }
}

/** Compressed slice size pushed per streaming step (bounds worst-case inflation per step). */
const STREAM_CHUNK_BYTES = 4096

/**
 * Extract one entry using its central-directory offset and compressed size (safe for archives
 * with data descriptors and embedded signatures), inflating incrementally so a forged
 * `originalSize` cannot force unbounded CPU work past the declared or configured limits.
 */
function readCentralEntry(
  zip: Uint8Array,
  info: ZipEntryInfo,
  central: CentralEntry,
  limits: ImportLimits,
  expandedTotal: number,
): Uint8Array | undefined {
  const lh = central.localOffset
  if (lh + 30 > zip.length || u32At(zip, lh) !== 0x04034b50) {
    throw damaged(`invalid local header for “${info.name}”`)
  }
  const dataStart = lh + 30 + u16At(zip, lh + 26) + u16At(zip, lh + 28)
  const dataEnd = dataStart + central.compressedSize
  if (dataStart > zip.length || dataEnd > zip.length) {
    throw damaged(`“${info.name}” extends past end of archive`)
  }
  const compressed = zip.subarray(dataStart, dataEnd)
  if (info.compression === 0) return compressed.slice()

  const maxBytes = Math.min(info.size, limits.maxZipEntryBytes, Math.max(0, limits.maxZipTotalBytes - expandedTotal))
  const chunks: Uint8Array[] = []
  let received = 0
  let finished = false
  let failure: Error | null = null

  const inflate = new Inflate((data, final) => {
    if (failure) return
    if (data.length > 0) {
      received += data.length
      if (received > maxBytes) {
        failure =
          received > limits.maxZipEntryBytes || expandedTotal + received > limits.maxZipTotalBytes
            ? new ImportError('mxl-limits', `“${info.name}” expands beyond the size limit.`)
            : damaged(`“${info.name}” has the wrong length`)
        return
      }
      chunks.push(data.slice())
    }
    if (final) finished = true
  })

  try {
    if (compressed.length === 0) {
      inflate.push(compressed, true)
    } else {
      for (let offset = 0; offset < compressed.length && !failure && !finished; offset += STREAM_CHUNK_BYTES) {
        const end = Math.min(offset + STREAM_CHUNK_BYTES, compressed.length)
        inflate.push(compressed.subarray(offset, end), end === compressed.length)
      }
    }
  } catch (e) {
    if (e instanceof ImportError) throw e
    throw damaged(e instanceof Error ? `${info.name}: ${e.message}` : info.name)
  }
  if (failure) throw failure
  if (!finished) return undefined
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(received)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

export interface MxlDocument {
  /** Path inside the archive. */
  readonly entry: string
  readonly text: string
}

const MUSICXML_MEDIA = /^application\/vnd\.recordare\.musicxml(\+xml)?$/i

/** Resolve an archive-relative reference against the directory of `base`. */
export function resolveEntryPath(base: string, href: string): string {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
  const parts = (href.startsWith('/') ? href.slice(1) : dir + href).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

/**
 * Rootfiles listed in `META-INF/container.xml` that carry MusicXML, in order. Falls back to a
 * single top-level MusicXML file (with a warning) when the container is missing.
 */
export function mxlRootfiles(zipReader: ZipReader, limits: ImportLimits, diag: DiagnosticSink): string[] {
  const containerName = 'META-INF/container.xml'
  if (!zipReader.has(containerName)) {
    const fallback = [...zipReader.entries.keys()].filter(
      (n) => !n.startsWith('META-INF/') && !n.includes('/') && /\.(musicxml|xml)$/i.test(n),
    )
    if (fallback.length === 1 && fallback[0]) {
      diag.warn(
        'mxl-no-container',
        `The compressed file has no META-INF/container.xml. Its only score, “${fallback[0]}”, is used.`,
      )
      return fallback
    }
    throw new ImportError(
      'mxl-no-container',
      'The compressed file has no META-INF/container.xml, so its score cannot be located. It may not be a MusicXML (.mxl) file.',
    )
  }
  const container = parseXmlDocument(
    decodeXmlBytes(zipReader.read(containerName), 'container.xml'),
    limits,
    'META-INF/container.xml',
  )
  const rootfiles = container.name === 'container' ? child(container, 'rootfiles') : undefined
  const list = rootfiles ? childrenNamed(rootfiles, 'rootfile') : []
  const paths: string[] = []
  for (const rf of list) {
    const path = attr(rf, 'full-path')
    if (!path) continue
    const media = attr(rf, 'media-type')
    if (media && !MUSICXML_MEDIA.test(media) && !/xml$/i.test(media)) {
      diag.info('mxl-rootfile-skipped', `Skipping “${path}” (${media}): not MusicXML.`)
      continue
    }
    paths.push(resolveEntryPath('', path))
  }
  if (paths.length === 0) {
    throw new ImportError('mxl-rootfile-missing', 'The compressed file’s container lists no MusicXML rootfile.')
  }
  const present = paths.filter((p) => zipReader.has(p))
  for (const p of paths) {
    if (!zipReader.has(p))
      diag.warn('mxl-rootfile-missing', `The container points to “${p}”, which is missing from the archive.`)
  }
  if (present.length === 0) {
    throw new ImportError(
      'mxl-rootfile-missing',
      `The compressed file’s container points to “${paths[0] ?? ''}”, which is missing from the archive.`,
    )
  }
  return present
}
