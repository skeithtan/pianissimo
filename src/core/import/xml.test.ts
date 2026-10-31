import { describe, expect, it } from 'vitest'
import { ImportError } from './errors'
import { DEFAULT_IMPORT_LIMITS, resolveLimits } from './limits'
import {
  attr,
  child,
  childText,
  decodeXmlText,
  elements,
  parseXmlDocument,
  scanProlog,
  serializeElement,
  textOf,
} from './xml'

const parse = (s: string) => parseXmlDocument(s, DEFAULT_IMPORT_LIMITS)

describe('XML layer', () => {
  it('preserves child order (backup/forward/chord timing depends on it)', () => {
    const root = parse('<m><note/><backup/><note/><forward/><direction/><note/></m>')
    expect(elements(root).map((e) => e.name)).toEqual(['note', 'backup', 'note', 'forward', 'direction', 'note'])
  })

  it('decodes predefined and numeric references in text and attributes', () => {
    const root = parse('<a t="x &amp; y &#x41;"><w>R&amp;B &lt;3 &#233;</w></a>')
    expect(attr(root, 't')).toBe('x & y A')
    expect(childText(root, 'w')).toBe('R&B <3 é')
    expect(decodeXmlText('&unknown; &#0;')).toBe('&unknown; &#0;')
  })

  it('keeps CDATA as escaped text', () => {
    const root = parse('<a><w><![CDATA[a <b> & c]]></w></a>')
    expect(textOf(child(root, 'w'))).toBe('a <b> & c')
  })

  it('round-trips through serialization as well-formed XML', () => {
    const src = '<a x="1 &amp; 2" y="&quot;q&quot;"><b>t &lt; u</b><c/><d><e>1</e></d></a>'
    const out: string[] = []
    serializeElement(parse(src), out)
    const again = parse(out.join(''))
    expect(attr(again, 'x')).toBe('1 & 2')
    expect(attr(again, 'y')).toBe('"q"')
    expect(childText(again, 'b')).toBe('t < u')
  })

  it('reports malformed XML with line and column', () => {
    try {
      parse('<a>\n  <b>\n</a>')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError)
      expect((e as ImportError).code).toBe('xml-malformed')
      expect((e as ImportError).message).toMatch(/line \d+, column \d+/)
    }
  })

  it('refuses internal entity declarations (no entity expansion)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "xxxxxxxx"><!ENTITY y "&x;&x;&x;">]><a>&y;</a>'
    expect(() => parse(bomb)).toThrow(expect.objectContaining({ code: 'xml-entity-declaration' }))
  })

  it('never resolves external DTDs or entities (the public DOCTYPE is ignored)', () => {
    const root = parse(
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD" "http://example.invalid/x.dtd"><score-partwise><x>&ext;</x></score-partwise>',
    )
    expect(root.name).toBe('score-partwise')
    expect(childText(root, 'x')).toBe('&ext;')
  })

  it('enforces character and element limits', () => {
    expect(() => parseXmlDocument('<a>' + 'x'.repeat(200) + '</a>', resolveLimits({ maxXmlChars: 100 }))).toThrow(
      expect.objectContaining({ code: 'xml-too-large' }),
    )
    expect(() => parseXmlDocument('<a><b/><b/><b/><b/></a>', resolveLimits({ maxElements: 3 }))).toThrow(
      expect.objectContaining({ code: 'xml-too-large' }),
    )
  })

  it('scans the prolog for the root element and doctype', () => {
    expect(
      scanProlog('﻿<?xml version="1.0"?>\n<!-- c --><!DOCTYPE x [ <!ELEMENT x ANY> ]><mx:score-partwise>').root,
    ).toBe('score-partwise')
    expect(scanProlog('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY e "v">]><a/>').internalSubset).toContain('ENTITY')
    expect(scanProlog('not xml').root).toBeNull()
  })
})
