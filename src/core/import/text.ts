/**
 * Bytes → text for XML documents: BOM first, then the XML declaration's encoding, else UTF-8.
 * Decoding is strict so a binary or mis-declared file yields a clear message, not mojibake.
 */
import { ImportError } from './errors'

function sniffEncoding(bytes: Uint8Array): string {
  const b0 = bytes[0]
  const b1 = bytes[1]
  const b2 = bytes[2]
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return 'utf-8'
  if (b0 === 0xff && b1 === 0xfe) return 'utf-16le'
  if (b0 === 0xfe && b1 === 0xff) return 'utf-16be'
  if (b0 === 0x3c && b1 === 0x00) return 'utf-16le'
  if (b0 === 0x00 && b1 === 0x3c) return 'utf-16be'
  let head = ''
  const n = Math.min(bytes.length, 256)
  for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i] ?? 0)
  const m = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)
  const declared = m?.[1]?.toLowerCase()
  if (!declared || declared === 'utf8' || declared.startsWith('utf-16')) return 'utf-8'
  return declared
}

export function decodeXmlBytes(bytes: Uint8Array, what = 'The file'): string {
  const encoding = sniffEncoding(bytes)
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(encoding, { fatal: true })
  } catch {
    throw new ImportError(
      'xml-encoding',
      `${what} declares the text encoding “${encoding}”, which this browser cannot read.`,
    )
  }
  try {
    return decoder.decode(bytes)
  } catch {
    throw new ImportError(
      'xml-encoding',
      `${what} is not valid ${encoding.toUpperCase()} text. It may be damaged or not an XML file.`,
    )
  }
}

/** Lowercased extension without the dot ("" when none). */
export function extensionOf(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}
