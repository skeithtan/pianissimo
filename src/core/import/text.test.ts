import { describe, expect, it } from 'vitest'
import { decodeXmlBytes, extensionOf } from './text'

describe('text decoding', () => {
  it('decodes UTF-8 with and without a BOM', () => {
    const body = '<a>é</a>'
    expect(decodeXmlBytes(new TextEncoder().encode(body))).toBe(body)
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)])
    expect(decodeXmlBytes(bom).replace('﻿', '')).toBe(body)
  })

  it('decodes UTF-16 by its byte-order mark', () => {
    const s = '<?xml version="1.0" encoding="UTF-16"?><a>ō</a>'
    const le = new Uint8Array(2 + s.length * 2)
    le[0] = 0xff
    le[1] = 0xfe
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      le[2 + i * 2] = c & 0xff
      le[3 + i * 2] = c >> 8
    }
    expect(decodeXmlBytes(le).replace('﻿', '')).toBe(s)
  })

  it('honors a declared single-byte encoding', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><a>'),
      0xe9,
      ...new TextEncoder().encode('</a>'),
    ])
    expect(decodeXmlBytes(bytes)).toContain('<a>é</a>')
  })

  it('rejects invalid UTF-8 and unknown encodings with a readable message', () => {
    expect(() => decodeXmlBytes(new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0xfe, 0xfd]))).toThrow(
      expect.objectContaining({ code: 'xml-encoding' }),
    )
    const unknown = new TextEncoder().encode('<?xml version="1.0" encoding="x-made-up"?><a/>')
    expect(() => decodeXmlBytes(unknown)).toThrow(/x-made-up/)
  })

  it('extracts lowercased extensions', () => {
    expect(extensionOf('Song.MXL')).toBe('mxl')
    expect(extensionOf('dir.v2/score')).toBe('')
    expect(extensionOf('.hidden')).toBe('')
  })
})
