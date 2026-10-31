/**
 * Score identity. `scoreVersionId` = SHA-256 over the source bytes' hash, the chosen archive
 * entry, the selected parts and `IMPORTER_VERSION` (spec: compare results only within one score
 * version). Uses Web Crypto, available in workers, browsers and Node 22.
 */
import { IMPORTER_VERSION } from '../model/score'

function hex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, '0')
  return s
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  let view: Uint8Array<ArrayBuffer>
  if (bytes.buffer instanceof ArrayBuffer) {
    view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  } else {
    view = new Uint8Array(bytes.byteLength)
    view.set(bytes)
  }
  return hex(await crypto.subtle.digest('SHA-256', view))
}

export async function scoreVersionId(
  sourceSha256: string,
  entry: string | undefined,
  partIds: readonly string[],
): Promise<string> {
  return sha256Hex(['pianissimo-score', sourceSha256, entry ?? '', partIds.join(','), IMPORTER_VERSION].join('\n'))
}
