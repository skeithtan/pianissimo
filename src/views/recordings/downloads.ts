import type { RecordingFiles, RecordingInfo } from '../../core/recording/records'

/**
 * When a take began, in ISO 8601, then its piece: files sort by time. Local time with its UTC offset (Z
 * for a take that stored none). Colons, which file systems refuse, are hyphens.
 */
export function recordingName(info: Pick<RecordingInfo, 'createdAt' | 'title' | 'startUtcOffsetMinutes'>): string {
  const title =
    info.title
      .replace(/[^\p{L}\p{N} ._-]/gu, ' ')
      .trim()
      .slice(0, 80) || 'Pianissimo'
  const offset = info.startUtcOffsetMinutes ?? 0
  const local = new Date(info.createdAt + offset * 60_000).toISOString().slice(0, 19).replaceAll(':', '-')
  const twoDigits = (value: number) => String(value).padStart(2, '0')
  const absolute = Math.abs(offset)
  const zone = (offset < 0 ? '-' : '+') + twoDigits(Math.floor(absolute / 60)) + twoDigits(absolute % 60)
  return local + (offset === 0 ? 'Z' : zone) + ' ' + title
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crcUpdate(crc: number, data: Uint8Array): number {
  let c = crc
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return c
}

/** CRC-32 of a Blob, reading it 1 MiB at a time. */
async function blobCrc(blob: Blob, signal: AbortSignal): Promise<number> {
  let crc = 0xffffffff
  for (let at = 0; at < blob.size; at += 1 << 20) {
    signal.throwIfAborted()
    crc = crcUpdate(crc, new Uint8Array(await blob.slice(at, at + (1 << 20)).arrayBuffer()))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS time and date of a local wall-clock instant (zip timestamps carry no zone). */
function dosTime(at: number): { time: number; date: number } {
  const d = new Date(Math.min(Math.max(at, Date.UTC(1980, 0, 2)), Date.UTC(2107, 11, 31)))
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

/**
 * Store both files in one ZIP without copying them: the archive Blob refers to the take's own
 * Blobs between small headers, so a long take is never held twice. Each file is read once, in
 * 1 MiB slices, for its CRC-32. `localTime` is the take's start in its own local time.
 */
export async function downloadPair(
  files: RecordingFiles,
  name: string,
  signal: AbortSignal,
  localTime = Date.now(),
): Promise<Blob> {
  const encoder = new TextEncoder()
  const { time, date } = dosTime(localTime)
  const parts: BlobPart[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const [ext, blob] of [
    ['mid', files.midi],
    ['wav', files.audio],
  ] as const) {
    const fileName = encoder.encode(name + '.' + ext)
    const crc = await blobCrc(blob, signal)
    if (offset + blob.size + 30 + fileName.length > 0xffffffff)
      throw new RangeError('The recording is too large to zip.')
    const fields = (header: DataView, at: number) => {
      header.setUint16(at, 20, true) // version needed: 2.0
      header.setUint16(at + 2, 0x800, true) // UTF-8 names
      header.setUint16(at + 4, 0, true) // stored
      header.setUint16(at + 6, time, true)
      header.setUint16(at + 8, date, true)
      header.setUint32(at + 10, crc, true)
      header.setUint32(at + 14, blob.size, true)
      header.setUint32(at + 18, blob.size, true)
      header.setUint16(at + 22, fileName.length, true)
      header.setUint16(at + 24, 0, true)
    }
    const local = new Uint8Array(30 + fileName.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    fields(localView, 4)
    local.set(fileName, 30)
    const central = new Uint8Array(46 + fileName.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true) // made by: 2.0
    fields(centralView, 6)
    centralView.setUint32(42, offset, true)
    central.set(fileName, 46)
    directory.push(central)
    parts.push(local, blob)
    offset += local.length + blob.size
  }
  const directorySize = directory.reduce((sum, entry) => sum + entry.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, directory.length, true)
  endView.setUint16(10, directory.length, true)
  endView.setUint32(12, directorySize, true)
  endView.setUint32(16, offset, true)
  return new Blob([...parts, ...directory, end] as BlobPart[], { type: 'application/zip' })
}

/** Save a Blob as a file. The object URL lives long enough for Safari to start the download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
