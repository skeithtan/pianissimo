/**
 * SVG sanitization (spec "Common score model and import pipeline": sanitize generated SVG before
 * display). Allow-list based: unknown elements are removed with their content; attributes outside
 * the list are dropped, which removes event handlers, external `href`s and inline styles. Also
 * rounds geometry attributes so serialized segments stay compact, and turns engraver black into
 * `currentColor` so the strip's theme decides the ink (cached layouts stay theme-independent).
 */
const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'text',
  'tspan',
  'line',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
])

const ATTRIBUTES = new Set([
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'points',
  'viewBox',
  'transform',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'class',
  'xmlns',
  'data-n',
  'data-h',
  'data-o',
])

/** Attributes whose numbers are rounded (path data to 0.1 px, the rest to 0.01 px). */
const NUMERIC = new Set(['d', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points', 'transform'])

/** Values that would fetch or run something even inside an allowed attribute. */
const UNSAFE_VALUE = /url\s*\(|javascript:|expression\s*\(/i

const NUMBER = /-?\d+\.\d{2,}/g

export function roundNumbers(value: string, digits = 2): string {
  const f = 10 ** digits
  return value.replace(NUMBER, (m) => {
    const r = Math.round(Number(m) * f) / f
    return Object.is(r, -0) ? '0' : String(r)
  })
}

/** Engraver black: fills are dropped (they inherit `fill: currentColor`), strokes become currentColor. */
const BLACK = new Set(['#000000', '#000', 'black', 'rgb(0,0,0)', 'rgb(0, 0, 0)'])

/**
 * Presentation attributes equal to SVG defaults or to engraver black (VexFlow writes them on every
 * glyph). Black fill is removed so the theme's ink (CSS `fill: currentColor` on the strip) applies.
 */
function isDefault(name: string, value: string, strokeNone: boolean): boolean {
  switch (name) {
    case 'stroke-dasharray':
      return value === 'none'
    case 'fill':
      return BLACK.has(value.toLowerCase())
    case 'stroke':
      return value === 'none'
    case 'stroke-width':
      return strokeNone
    default:
      return false
  }
}

/**
 * Sanitizes `root` in place. Returns the number of removed elements (for diagnostics).
 * `round` also rounds geometry and drops default-valued attributes.
 */
export function sanitizeSvgTree(root: Element, round = true): number {
  let removed = 0
  const visit = (el: Element): void => {
    for (const child of [...el.children]) {
      if (!ELEMENTS.has(child.localName)) {
        child.remove()
        removed++
        continue
      }
      visit(child)
    }
    const strokeNone = el.getAttribute('stroke') === 'none'
    for (const attr of [...el.attributes]) {
      const name = attr.name
      if (!ATTRIBUTES.has(name) || UNSAFE_VALUE.test(attr.value)) {
        el.removeAttribute(name)
      } else if (round && NUMERIC.has(name)) {
        el.setAttribute(name, roundNumbers(attr.value, name === 'd' ? 1 : 2))
      } else if (round && isDefault(name, attr.value, strokeNone)) {
        el.removeAttribute(name)
      } else if (round && name === 'stroke' && BLACK.has(attr.value.toLowerCase())) {
        el.setAttribute(name, 'currentColor')
      }
    }
  }
  if (!ELEMENTS.has(root.localName)) {
    root.remove()
    return 1
  }
  visit(root)
  return removed
}

const ELEMENT_NAMES = [...ELEMENTS]
const ELEMENT_INDEX = new Map(ELEMENT_NAMES.map((name, k) => [name, k]))
const SVG = ELEMENT_INDEX.get('svg')!
const MAX_DEPTH = 256
/** The open elements of the markup being checked, as indexes into `ELEMENT_NAMES`. */
const open = new Uint8Array(MAX_DEPTH)

/** A run of value characters that need no further look (not `"`, `&`, `(`, `:` or a control). */
const PLAIN_VALUE = /[^"&(:\0-\x1f\x7f]*/y
/** A run of text characters that need no further look (not `<`, `&` or a control but tab and LF). */
const PLAIN_TEXT = /[^<&\0-\x08\x0b-\x1f\x7f]*/y

const QUOTE = 0x22
const AMP = 0x26
const LPAREN = 0x28
const SLASH = 0x2f
const COLON = 0x3a
const LT = 0x3c
const EQUALS = 0x3d
const GT = 0x3e
const SPACE = 0x20

/** ASCII letter, digit or `-`: every character of every allowed name. */
function isNameChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2d
}

/**
 * The length of the character reference at `s[i]` (an `&`) if it is one `outerHTML` writes, else 0.
 * In attribute values only the references for `&`, `"`, `<` and `>` are allowed: none of those
 * characters can be part of an `UNSAFE_VALUE` match, so testing the value undecoded is enough.
 * `&nbsp;` decodes to a character `\s` matches (`url&nbsp;(`), so it is allowed in text only.
 */
function referenceLength(s: string, i: number, inValue: boolean): number {
  if (s.startsWith('&amp;', i)) return 5
  if (s.startsWith('&quot;', i)) return 6
  if (s.startsWith('&lt;', i) || s.startsWith('&gt;', i)) return 4
  if (!inValue && s.startsWith('&nbsp;', i)) return 6
  return 0
}

/**
 * Strict check of serialized markup (no DOM), used to reject cached layouts that did not come from
 * this sanitizer (e.g. written by another page on the same origin). It accepts only the form
 * `outerHTML` gives a sanitized tree, and rejects everything else:
 *
 *   markup  = element*
 *   element = "<" NAME (" " ATTR "=" '"' value '"')* ">" (element | text)* "</" NAME ">"
 *   value   = any character but `"`, `&` and controls, or `&amp;` `&quot;` `&lt;` `&gt;`
 *   text    = any character but `<`, `&` and controls other than tab and line feed, or those
 *             references and `&nbsp;`
 *
 * NAME is in `ELEMENTS` and ATTR in `ATTRIBUTES`, spelled exactly (the HTML parser lowercases
 * names; `viewBox` is allowed only on or inside an `svg`, where the parser restores its case). An
 * end tag closes the innermost open element, and nesting is at most `MAX_DEPTH` deep. A value
 * containing `(` or `:` must not match `UNSAFE_VALUE`. With no comments, doctypes, CDATA, processing
 * instructions, unquoted or single-quoted values, self-closing tags or other whitespace, the HTML
 * parser splits accepted markup into the same tags, attributes and values as this scanner and builds
 * the same tree. Text between tags is inert, so it may contain `=`, quotes or `url(`.
 */
export function isSafeSvgMarkup(markup: string): boolean {
  const n = markup.length
  let depth = 0
  let svgDepth = 0
  let i = 0
  while (i < n) {
    const c = markup.charCodeAt(i)
    if (c === LT && markup.charCodeAt(i + 1) === SLASH) {
      // An end tag: the name of the innermost open element, then ">".
      const start = i + 2
      let j = start
      while (j < n && isNameChar(markup.charCodeAt(j))) j++
      if (depth === 0 || markup.charCodeAt(j) !== GT) return false
      const element = open[--depth]!
      const name = ELEMENT_NAMES[element]!
      if (j - start !== name.length || !markup.startsWith(name, start)) return false
      if (element === SVG) svgDepth--
      i = j + 1
    } else if (c === LT) {
      // A start tag: an allowed name, then ` name="value"` for each attribute, then ">".
      let j = i + 1
      while (j < n && isNameChar(markup.charCodeAt(j))) j++
      // Slicing short names and looking them up measured faster than comparing without a substring.
      const element = ELEMENT_INDEX.get(markup.slice(i + 1, j))
      if (element === undefined || depth === MAX_DEPTH) return false
      const inSvg = element === SVG || svgDepth > 0
      while (markup.charCodeAt(j) === SPACE) {
        const start = j + 1
        let k = start
        while (k < n && isNameChar(markup.charCodeAt(k))) k++
        const name = markup.slice(start, k)
        if (!ATTRIBUTES.has(name) || (name === 'viewBox' && !inSvg)) return false
        if (markup.charCodeAt(k) !== EQUALS || markup.charCodeAt(k + 1) !== QUOTE) return false
        const value = k + 2
        let e = value
        let suspect = false
        for (;;) {
          PLAIN_VALUE.lastIndex = e
          PLAIN_VALUE.test(markup)
          e = PLAIN_VALUE.lastIndex
          const v = markup.charCodeAt(e)
          if (v === QUOTE) break
          if (v === AMP) {
            const length = referenceLength(markup, e, true)
            if (length === 0) return false
            e += length
          } else if (v === LPAREN || v === COLON) {
            suspect = true
            e++
          } else {
            return false // a control character, or the end of the markup
          }
        }
        // Every `UNSAFE_VALUE` match contains "(" or ":".
        if (suspect && UNSAFE_VALUE.test(markup.slice(value, e))) return false
        j = e + 1
      }
      if (markup.charCodeAt(j) !== GT) return false
      open[depth++] = element
      if (element === SVG) svgDepth++
      i = j + 1
    } else if (depth === 0) {
      return false
    } else if (c === AMP) {
      const length = referenceLength(markup, i, false)
      if (length === 0) return false
      i += length
    } else {
      PLAIN_TEXT.lastIndex = i
      PLAIN_TEXT.test(markup)
      if (PLAIN_TEXT.lastIndex === i) return false // a control character
      i = PLAIN_TEXT.lastIndex
    }
  }
  return depth === 0
}
