import type { RecordingFiles, RecordingInfo } from '../../core/recording/records'
import { Zip, ZipPassThrough } from 'fflate'

export function recordingName(info: Pick<RecordingInfo, 'createdAt' | 'title' | 'startUtcOffsetMinutes'>): string {
  const title =
    info.title
      .replace(/[^\p{L}\p{N} ._-]/gu, ' ')
      .trim()
      .slice(0, 80) || 'Pianissimo'
  const offset = info.startUtcOffsetMinutes ?? 0
  const local = new Date(info.createdAt + offset * 60_000)
    .toISOString()
    .slice(0, -1)
    .replace('T', ' ')
    .replaceAll(':', '-')
  const twoDigits = (value: number) => String(value).padStart(2, '0')
  const absolute = Math.abs(offset)
  const zone = 'UTC' + (offset < 0 ? '-' : '+') + twoDigits(Math.floor(absolute / 60)) + twoDigits(absolute % 60)
  return title + ' - ' + local + ' ' + zone
}

/** Store both files in a single ZIP. Read large WAV files in blocks on mobile. */
export async function downloadPair(files: RecordingFiles, name: string, signal: AbortSignal): Promise<Blob> {
  const parts: Blob[] = []
  const zip = new Zip((error, chunk) => {
    if (error) throw error
    parts.push(new Blob([new Uint8Array(chunk)]))
  })
  for (const [ext, blob] of [
    ['mid', files.midi],
    ['wav', files.audio],
  ] as const) {
    const entry = new ZipPassThrough(name + '.' + ext)
    zip.add(entry)
    for (let pos = 0; pos < blob.size; pos += 1024 * 1024) {
      signal.throwIfAborted()
      entry.push(new Uint8Array(await blob.slice(pos, pos + 1024 * 1024).arrayBuffer()))
    }
    entry.push(new Uint8Array(0), true)
  }
  zip.end()
  return new Blob(parts, { type: 'application/zip' })
}
