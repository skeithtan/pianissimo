/**
 * Safe, order-preserving XML layer (worker-safe: no DOMParser).
 *
 * Spec: "Preserve MusicXML child order when parsing because backup, forward, and chord elements
 * determine timing" and "Disable external entity resolution and external file or network
 * references". fast-xml-parser runs with `preserveOrder: true` and entity processing disabled;
 * DOCTYPE internal ENTITY declarations are refused outright, external DTDs are never fetched.
 *
 * Text and attribute values are kept *raw* (still escaped) in the tree so serialization is
 * lossless; read them through `textOf` / `attr`, which decode the predefined and numeric
 * character references.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { ImportError } from './errors'
import type { ImportLimits } from './limits'

export interface XmlElement {
  readonly name: string
  /** Raw (escaped) attribute values. */
  readonly attrs: Readonly<Record<string, string>>
  /** Child elements and raw (escaped) text runs, in document order. */
  readonly children: XmlNode[]
}

export type XmlNode = XmlElement | string

export function isElement(n: XmlNode): n is XmlElement {
  return typeof n !== 'string'
}

const PREDEFINED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decode predefined and numeric character references. Unknown named references stay literal. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes('&')) return raw
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (m, ref: string) => {
    if (ref.startsWith('#')) {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return PREDEFINED[ref] ?? m
  })
}

export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const BAD_AMP = /&(?!(?:#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);)/g

/** Re-escape a raw text run so it is well-formed even if it held an undefined entity. */
function safeRawText(raw: string): string {
  return raw.includes('&') ? raw.replace(BAD_AMP, '&amp;') : raw
}

function safeRawAttr(raw: string): string {
  let s = raw.includes('&') ? raw.replace(BAD_AMP, '&amp;') : raw
  if (s.includes('"')) s = s.replace(/"/g, '&quot;')
  if (s.includes('<')) s = s.replace(/</g, '&lt;')
  return s
}

// ---------------------------------------------------------------------------------------------
// Prolog scan: root element name and DOCTYPE, without parsing the whole document.

export interface PrologInfo {
  /** Local name of the root element (namespace prefix stripped), or null if none found. */
  readonly root: string | null
  readonly doctype: string | null
  readonly internalSubset: string | null
}

export function scanProlog(text: string, maxScan = 1 << 20): PrologInfo {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const n = Math.min(text.length, maxScan)
  let doctype: string | null = null
  let internalSubset: string | null = null
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      i++
      continue
    }
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2)
      if (e < 0) break
      i = e + 2
      continue
    }
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4)
      if (e < 0) break
      i = e + 3
      continue
    }
    if (text.startsWith('<!DOCTYPE', i)) {
      let j = i + 9
      let quote = ''
      let subsetStart = -1
      let subsetEnd = -1
      let depth = 0
      for (; j < text.length; j++) {
        const ch = text[j]
        if (quote) {
          if (ch === quote) quote = ''
          continue
        }
        if (ch === '"' || ch === "'") quote = ch
        else if (ch === '[') {
          if (depth === 0) subsetStart = j + 1
          depth++
        } else if (ch === ']') {
          depth--
          if (depth === 0) subsetEnd = j
        } else if (ch === '>' && depth === 0) break
      }
      doctype = text.slice(i, j + 1)
      if (subsetStart >= 0) internalSubset = text.slice(subsetStart, subsetEnd >= 0 ? subsetEnd : j)
      i = j + 1
      continue
    }
    if (c === 0x3c) {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 256))
      const name = m?.[1] ?? null
      return {
        root: name ? (name.includes(':') ? name.slice(name.indexOf(':') + 1) : name) : null,
        doctype,
        internalSubset,
      }
    }
    break
  }
  return { root: null, doctype, internalSubset }
}

// ---------------------------------------------------------------------------------------------
// Parsing

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  trimValues: true,
  cdataPropName: '#cdata',
  commentPropName: false,
  maxNestedTags: 200,
})

type FxpNode = Record<string, unknown>

function cdataText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return ''
  let s = ''
  for (const n of nodes as FxpNode[]) {
    const t = n['#text']
    if (t !== undefined) s += String(t)
  }
  return s
}

function convert(nodes: unknown, budget: { left: number }): XmlNode[] {
  const out: XmlNode[] = []
  if (!Array.isArray(nodes)) return out
  for (const n of nodes as FxpNode[]) {
    for (const k in n) {
      if (k === ':@') continue
      const v = n[k]
      if (k === '#text') {
        out.push(String(v))
        continue
      }
      if (k === '#cdata') {
        out.push(escapeXmlText(cdataText(v)))
        continue
      }
      if (--budget.left < 0) {
        throw new ImportError('xml-too-large', 'The score has too many XML elements to import safely.')
      }
      const rawAttrs = n[':@'] as Record<string, unknown> | undefined
      const attrs: Record<string, string> = {}
      if (rawAttrs) for (const a in rawAttrs) attrs[a] = String(rawAttrs[a])
      out.push({ name: k, attrs, children: convert(v, budget) })
    }
  }
  return out
}

/**
 * Parse one XML document into an order-preserving element tree.
 * Throws `ImportError` with line/column for malformed XML and refuses internal ENTITY
 * declarations (entity expansion is never performed).
 */
export function parseXmlDocument(text: string, limits: ImportLimits, what = 'The file'): XmlElement {
  if (text.length > limits.maxXmlChars) {
    throw new ImportError(
      'xml-too-large',
      `${what} is too large to import (${Math.round(text.length / 1e6)} million characters; the limit is ${Math.round(limits.maxXmlChars / 1e6)} million).`,
    )
  }
  const prolog = scanProlog(text)
  if (prolog.internalSubset !== null && /<!ENTITY/i.test(prolog.internalSubset)) {
    throw new ImportError(
      'xml-entity-declaration',
      `${what} declares XML entities in its DOCTYPE. Entity declarations are refused for safety; re-export the score from your notation program.`,
    )
  }
  const valid = XMLValidator.validate(text)
  if (valid !== true) {
    const { line, col, msg } = valid.err
    throw new ImportError('xml-malformed', `${what} is not well-formed XML (line ${line}, column ${col}): ${msg}`)
  }
  let parsed: unknown
  try {
    parsed = parser.parse(text)
  } catch (e) {
    throw new ImportError(
      'xml-malformed',
      `${what} could not be parsed as XML: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const nodes = convert(parsed, { left: limits.maxElements })
  const root = nodes.find(isElement)
  if (!root) throw new ImportError('xml-malformed', `${what} contains no XML root element.`)
  return root
}

// ---------------------------------------------------------------------------------------------
// Accessors

export function child(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) if (typeof c !== 'string' && c.name === name) return c
  return undefined
}

export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = []
  for (const c of el.children) if (typeof c !== 'string' && c.name === name) out.push(c)
  return out
}

export function elements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  for (const c of el.children) if (typeof c !== 'string') out.push(c)
  return out
}

/** Decoded concatenated direct text content. */
export function textOf(el: XmlElement | undefined): string {
  if (!el) return ''
  let s = ''
  for (const c of el.children) if (typeof c === 'string') s += c
  return decodeXmlText(s).trim()
}

export function childText(el: XmlElement, name: string): string | undefined {
  const c = child(el, name)
  return c ? textOf(c) : undefined
}

export function attr(el: XmlElement, name: string): string | undefined {
  const v = el.attrs[name]
  return v === undefined ? undefined : decodeXmlText(v)
}

export function toInt(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s.trim())
  return Number.isFinite(n) ? Math.round(n) : undefined
}

export function toNum(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s.trim())
  return Number.isFinite(n) ? n : undefined
}

// ---------------------------------------------------------------------------------------------
// Serialization

/**
 * Per-element rewrite hook for serialization: return `null` to drop the element, a different
 * element to substitute it, or `undefined` to keep it unchanged.
 */
export type SerializeHook = (el: XmlElement) => XmlElement | null | undefined

export function serializeElement(el: XmlElement, out: string[], hook?: SerializeHook): void {
  let e: XmlElement = el
  if (hook) {
    const r = hook(el)
    if (r === null) return
    if (r !== undefined) e = r
  }
  out.push('<', e.name)
  for (const a in e.attrs) out.push(' ', a, '="', safeRawAttr(e.attrs[a] ?? ''), '"')
  if (e.children.length === 0) {
    out.push('/>')
    return
  }
  out.push('>')
  for (const c of e.children) {
    if (typeof c === 'string') out.push(safeRawText(c))
    else serializeElement(c, out, hook)
  }
  out.push('</', e.name, '>')
}

export function el(name: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlElement {
  return { name, attrs, children }
}

/** Text element helper for synthesized markup (value is escaped). */
export function textEl(name: string, value: string | number, attrs: Record<string, string> = {}): XmlElement {
  return { name, attrs, children: [escapeXmlText(String(value))] }
}
