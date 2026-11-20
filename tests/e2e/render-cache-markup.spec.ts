/**
 * Cached layout markup in a real browser (`isSafeSvgMarkup`, which decides whether a layout read
 * back from storage may be mounted with innerHTML): the segments and sticky glyphs of real prepared
 * layouts pass, and every mutated variant of real markup it accepts parses, with the browser's own
 * HTML parser, into allow-listed elements and attributes with no unsafe value.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '../browser-test'
import { REFERENCE_PIECE, openHarness, referencePresent } from './render-helpers'

/** The sanitizer's allow-lists (`ELEMENTS`, `ATTRIBUTES`, `UNSAFE_VALUE` in src/render/sanitize.ts). */
const ELEMENTS = ['svg', 'g', 'path', 'rect', 'text', 'tspan', 'line', 'circle', 'ellipse', 'polygon', 'polyline']
const ATTRIBUTES = [
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
]
const UNSAFE_VALUE = String.raw`url\s*\(|javascript:|expression\s*\(`

/** Engraved text the old regular-expression check took for attributes or unsafe values. */
const WORDS = ['Tempo I = 72', 'Swing (2 eighths = triplet)', "Verse 2: 'Tis = so", 'url (x)', 'curl(up)']

/** An importer fixture whose tempo words are replaced by `WORDS`. */
function wordsScore(): string {
  const xml = readFileSync(new URL('../fixtures/scores/tempo-changes.musicxml', import.meta.url), 'utf8')
  const words = WORDS.join(' / ').replace("'", '&apos;')
  return xml.replace(/<words>[^<]*<\/words>/, `<words>${words}</words>`)
}

interface Case {
  readonly name: string
  readonly room?: 'all' | 'hints'
  readonly page?: boolean
  readonly xml?: string
}

const CASES: Case[] = [
  ...['basic', 'ottava', 'voices', 'changes', 'scores/tempo-changes.musicxml'].flatMap((name) => [
    { name },
    { name, room: 'hints' as const },
  ]),
  { name: 'changes', page: true },
  { name: 'words.musicxml', xml: 'words' },
  { name: 'words.musicxml', xml: 'words', page: true },
  ...(referencePresent
    ? [
        { name: REFERENCE_PIECE },
        { name: REFERENCE_PIECE, room: 'hints' as const },
        { name: REFERENCE_PIECE, page: true },
      ]
    : []),
]

/** Prepares a case in the page; returns its markup (segments and sticky glyphs). */
async function prepare(page: Page, c: Case): Promise<{ segments: string[]; glyphs: string[]; valid: boolean }> {
  const xml = c.xml === 'words' ? wordsScore() : undefined
  return page.evaluate(
    async ({ c, xml }) => {
      const h = window.harness
      const opts = { ...(c.room ? { room: c.room } : {}), ...(c.page ? { mode: 'page' as const, pageWidth: 565 } : {}) }
      if (xml) await h.prepareXml(c.name, xml, 3, opts)
      else await h.prepare(c.name, 3, opts)
      const l = h.layout()!
      return {
        segments: l.segments.map((s) => s.svg),
        glyphs: l.contexts.flatMap((ctx) => ctx.staves.map((st) => st.glyph.svg)),
        valid: h.isPreparedLayout(l),
      }
    },
    { c, xml },
  )
}

test.describe('cached layout markup check', () => {
  test.beforeEach(async ({ page }) => {
    await openHarness(page)
  })

  test('every segment and sticky glyph of real layouts passes', async ({ page }) => {
    const counts: string[] = []
    for (const c of CASES) {
      const label = `${c.name} ${c.room ?? 'all'} ${c.page ? 'page' : 'strip'}`
      const r = await prepare(page, c)
      const failed = await page.evaluate(
        (all) => all.filter((s) => !window.harness.isSafeSvgMarkup(s)).map((s) => s.slice(0, 300)),
        [...r.segments, ...r.glyphs],
      )
      expect(failed, label).toEqual([])
      expect(r.valid, label).toBe(true)
      expect(r.segments.length, label).toBeGreaterThan(0)
      if (c.xml === 'words') {
        const all = r.segments.join('')
        for (const w of WORDS) expect(all, `${label}: ${w}`).toContain(w)
      }
      counts.push(`${label}: ${r.segments.length} segments, ${r.glyphs.length} glyphs`)
    }
    test.info().annotations.push({ type: 'layouts', description: counts.join('; ') })
  })

  test('mutated markup the check accepts parses into allow-listed nodes only (differential)', async ({ page }) => {
    const bases: string[] = []
    for (const c of [{ name: 'changes' }, { name: 'words.musicxml', xml: 'words' }] as Case[]) {
      const r = await prepare(page, c)
      bases.push(...r.segments, ...r.glyphs)
    }
    const result = await page.evaluate(
      ({ bases, elements, attributes, unsafe }) => {
        const ELEMENTS = new Set(elements)
        const ATTRIBUTES = new Set(attributes)
        const UNSAFE = new RegExp(unsafe, 'i')
        const tpl = document.createElement('template')

        /** Violations of the property in the tree the HTML parser builds from `markup`. */
        const violations = (markup: string): string[] => {
          tpl.innerHTML = markup
          const out: string[] = []
          for (const el of tpl.content.querySelectorAll('*')) {
            if (!ELEMENTS.has(el.localName)) out.push(`element ${el.localName}`)
            for (const a of el.attributes) {
              if (!ATTRIBUTES.has(a.name)) out.push(`attribute ${a.name} on ${el.localName}`)
              if (UNSAFE.test(a.value)) out.push(`value ${a.name}="${a.value}"`)
            }
          }
          tpl.content.replaceChildren()
          return out
        }

        // The oracle itself must see the attacks it is meant to catch.
        const selfCheck = [
          '<svg onload="x()"></svg>',
          '<svg><script>x()</script></svg>',
          '<svg><path fill="&#x75;rl(#x)"></path></svg>',
          '<g viewBox="0 0 1 1"></g>',
        ].map((m) => violations(m).length > 0)

        // Short bases too: each segment's top-level groups, so mutations hit structure more often.
        const pieces = [...bases]
        for (const s of bases) {
          tpl.innerHTML = s
          const svg = tpl.content.firstElementChild
          for (const child of svg ? [...svg.children].slice(0, 12) : []) pieces.push(child.outerHTML)
          tpl.content.replaceChildren()
        }
        const usable = pieces.filter((p) => p.length <= 40_000)

        let seed = 0x5eed
        const random = (): number => {
          seed = (seed + 0x6d2b79f5) | 0
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
        const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!

        const FRAGMENTS = [
          '<script>alert(1)</script>',
          '<img src onerror="alert(1)">',
          '<img src=x onerror=alert(1)>',
          ' onload="alert(1)"',
          ' onload=alert(1)',
          ' ONLOAD="alert(1)"',
          '/onload="alert(1)"',
          ' href="javascript:alert(1)"',
          ' style="fill:url(#x)"',
          ' fill="url(#x)"',
          ' fill="u&#x72;l(#x)"',
          ' class="javascript&colon;x"',
          '<!--',
          '-->',
          '<!---->',
          '<![CDATA[',
          ']]>',
          '<?',
          '?>',
          '<!DOCTYPE html>',
          '</path x>',
          '</path>',
          '</g>',
          '<g>',
          '</svg>',
          '<svg>',
          '</ x>',
          '"',
          "'",
          '>',
          '<',
          '/',
          '/>',
          '=',
          ' ',
          '&',
          '&#x75;rl(',
          '&#117;',
          '&amp;',
          '&nbsp;',
          '&quot;',
          '&lt;',
          'url(',
          'url&nbsp;(',
          'javascript:',
          'expression(',
          '\0',
          '\t',
          '\n',
          '\r',
          '\f',
          '\u000b',
          ' ',
          ' ',
          '﻿',
          ' class="x"',
          ' class=x',
          " class='x'",
          ' class',
          ' VIEWBOX="0 0 1 1"',
          ' viewBox="0 0 1 1"',
          ' viewbox="0 0 1 1"',
          ' xlink:href="#x"',
          ' data-n="1"',
          '<text>a = b</text>',
          '<g viewBox="0 0 1 1"></g>',
          '</svg><g viewBox="0 0 1 1"></g><svg>',
          '<foreignObject><div onclick="x()">x</div></foreignObject>',
          '<style>*{fill:url(#x)}</style>',
          '<title>',
          '<textarea>',
          '<noscript>',
          '<math><mi>x</mi></math>',
          '<table><tr><td>x</td></tr></table>',
          '<p>',
          '<font color="red">',
          '<G>',
          '<PATH d="M0">',
          '</G>',
          '<use href="#a"></use>',
          '<a href="javascript:x()">',
        ]
        const CHARS = ['"', "'", '<', '>', '/', '=', ' ', '&', '\0', '\t', '\n', '\f', '\r', ' ', 'A', '(', ':']
        const STRUCTURAL = '<>"= /'

        /** Mostly at or next to tag syntax (between tags, after a name, around quotes), else anywhere. */
        const offset = (s: string): number => {
          if (random() < 0.7) {
            for (let tries = 0; tries < 40; tries++) {
              const i = Math.floor(random() * s.length)
              if (!STRUCTURAL.includes(s[i]!)) continue
              if (random() < 0.5) return s[i] === '>' ? i + 1 : i
              return Math.min(s.length, Math.max(0, i + Math.floor(random() * 5) - 2))
            }
          }
          return Math.floor(random() * (s.length + 1))
        }
        const mutate = (s: string): string => {
          const ops = 1 + Math.floor(random() * 3)
          for (let k = 0; k < ops; k++) {
            const i = offset(s)
            const op = random()
            if (op < 0.5) s = s.slice(0, i) + pick(FRAGMENTS) + s.slice(i)
            else if (op < 0.65) s = s.slice(0, i) + pick(CHARS) + s.slice(i)
            else if (op < 0.8) s = s.slice(0, i) + s.slice(i + 1 + Math.floor(random() * 8))
            else if (op < 0.9) {
              const j = i + 1 + Math.floor(random() * 12)
              s = s.slice(0, i) + s.slice(i, j).toUpperCase() + s.slice(j)
            } else {
              const j = i + 1 + Math.floor(random() * 30)
              s = s.slice(0, j) + s.slice(i, j) + s.slice(j)
            }
          }
          return s
        }

        const check = window.harness.isSafeSvgMarkup
        const VARIANTS = 6000
        let accepted = 0
        let acceptedChanged = 0
        const failures: { markup: string; violations: string[] }[] = []
        for (let v = 0; v < VARIANTS; v++) {
          const base = pick(usable)
          const markup = mutate(base)
          if (!check(markup)) continue
          accepted++
          if (markup !== base) acceptedChanged++
          const found = violations(markup)
          if (found.length > 0 && failures.length < 5)
            failures.push({ markup: markup.slice(0, 400), violations: found })
        }
        const baseViolations = usable.filter((b) => violations(b).length > 0).length
        return {
          bases: usable.length,
          generated: VARIANTS,
          accepted,
          acceptedChanged,
          failures,
          baseViolations,
          selfCheck,
        }
      },
      { bases, elements: ELEMENTS, attributes: ATTRIBUTES, unsafe: UNSAFE_VALUE },
    )
    test.info().annotations.push({
      type: 'differential',
      description:
        `${result.generated} variants of ${result.bases} real markup pieces, ${result.accepted} accepted ` +
        `(${result.acceptedChanged} changed by the mutation), ${result.failures.length} violated the property`,
    })
    console.log(`differential: ${test.info().annotations.at(-1)!.description}`)
    expect(result.selfCheck).toEqual([true, true, true, true])
    expect(result.baseViolations).toBe(0)
    expect(result.failures).toEqual([])
    expect(result.accepted).toBeGreaterThan(200)
  })
})
