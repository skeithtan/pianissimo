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

const TAG = /<\/?([A-Za-z][\w:.-]*)/g
/**
 * An attribute name: the HTML parser also starts one right after a quoted value or a `/` inside
 * a tag (`<g class="a"onload=…>`, `<svg/onload=…>`), not only after whitespace.
 */
const ATTR = /[\s/"']([A-Za-z_:][\w:.-]*)\s*=/g
/**
 * Character references other than the ones `outerHTML` writes: numeric or named references could
 * spell a value `UNSAFE_VALUE` would catch (`&#117;rl(`, `javascript&colon;`).
 */
const ENTITY = /&(?!(?:amp|lt|gt|quot|nbsp);)/

/**
 * Strict allow-list check of serialized markup (no DOM): every tag and attribute name must be one
 * the sanitizer keeps and no value may reference script or external resources. Used to reject
 * cached layouts that did not come from this sanitizer (e.g. a tampered backup).
 */
export function isSafeSvgMarkup(markup: string): boolean {
  if (UNSAFE_VALUE.test(markup) || ENTITY.test(markup)) return false
  for (const m of markup.matchAll(TAG)) if (!ELEMENTS.has(m[1]!)) return false
  for (const m of markup.matchAll(ATTR)) if (!ATTRIBUTES.has(m[1]!)) return false
  return true
}
