/**
 * Compressed MusicXML (.mxl) reading with fflate.
 *
 * Spec: validate compressed input with size and expansion limits. Declared sizes are checked
 * against the limits *before* anything is inflated, only the container and the referenced
 * rootfiles are expanded, and each expanded entry is verified against its CRC-32 so a damaged
 * archive produces a clear message instead of silently truncated XML.
 */
import { unzipSync } from 'fflate'
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

/** CRC-32 per entry name from the central directory (fflate does not verify CRCs). */
function centralDirectoryCrcs(d: Uint8Array): Map<string, number> {
  const crcs = new Map<string, number>()
  const u16 = (o: number) => (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8)
  const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0
  let e = d.length - 22
  while (e >= 0 && u32(e) !== 0x06054b50) {
    if (d.length - e > 65558) return crcs
    e--
  }
  if (e < 0) return crcs
  let count = u16(e + 10)
  let o = u32(e + 16)
  const z64 = e >= 20 ? u32(e - 20) === 0x07064b50 : false
  if (z64) {
    const ze = u32(e - 12)
    if (u32(ze) === 0x06064b50) {
      count = u32(ze + 32)
      o = u32(ze + 48)
    }
  }
  for (let i = 0; i < count && o + 46 <= d.length; i++) {
    if (u32(o) !== 0x02014b50) break
    const flags = u16(o + 8)
    const crc = u32(o + 16)
    const nameLen = u16(o + 28)
    const extraLen = u16(o + 30)
    const commentLen = u16(o + 32)
    const raw = d.subarray(o + 46, o + 46 + nameLen)
    const name = flags & 0x800 ? new TextDecoder().decode(raw) : Array.from(raw, (b) => String.fromCharCode(b)).join('')
    crcs.set(name, crc)
    o += 46 + nameLen + extraLen + commentLen
  }
  return crcs
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
            `The compressed file lists more than ${limits.maxZipEntries} entries; refusing to open it.`,
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
  private crcs: Map<string, number> | undefined
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
        `“${name}” has a suspicious compression ratio (${Math.round(info.size / Math.max(1, info.compressedSize))}:1); refusing to expand it.`,
      )
    }
    let out: Uint8Array | undefined
    try {
      out = unzipSync(this.zip, { filter: (f) => f.name === name })[name]
    } catch (e) {
      throw damaged(e instanceof Error ? `${name}: ${e.message}` : name)
    }
    if (!out || out.length !== info.size) throw damaged(`“${name}” has the wrong length`)
    this.crcs ??= centralDirectoryCrcs(this.zip)
    const expected = this.crcs.get(name)
    if (expected !== undefined && crc32(out) !== expected) throw damaged(`checksum mismatch in “${name}”`)
    this.expandedTotal += info.size
    return out
  }
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
        `The compressed file has no META-INF/container.xml; using its only score “${fallback[0]}”.`,
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
