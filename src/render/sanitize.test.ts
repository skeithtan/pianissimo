// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { isSafeSvgMarkup, roundNumbers, sanitizeSvgTree } from './sanitize'

function parse(svg: string): Element {
  const xml = svg.includes('xmlns=') ? svg : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  return new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement
}

describe('sanitizeSvgTree', () => {
  it('removes scripts, foreignObject, event handlers and external references', () => {
    const root = parse(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
        '<script>alert(1)</script>' +
        '<foreignObject><div>x</div></foreignObject>' +
        '<a href="https://example.com"><path d="M0 0"/></a>' +
        '<image href="https://example.com/x.png"/>' +
        '<use href="#x"/>' +
        '<g onclick="x()" style="fill:url(https://e.com)" fill="url(https://e.com/p)"><path d="M1 1" onmouseover="y()"/></g>' +
        '</svg>',
    )
    sanitizeSvgTree(root)
    const html = root.outerHTML
    for (const bad of [
      'script',
      'foreignObject',
      'onload',
      'onclick',
      'onmouseover',
      'https:',
      'image',
      '<use',
      '<a',
      'style',
    ]) {
      expect(html).not.toContain(bad)
    }
    expect(root.querySelectorAll('path')).toHaveLength(1)
  })

  it('keeps notation attributes and our data tags, rounding geometry', () => {
    const root = parse(
      '<svg><g class="vf-notehead" data-n="3 4"><path stroke-width="0.3" fill="#000000" stroke="none" d="M1084.9295735999997 164.00000000000003L2 3" stroke-dasharray="none"/>' +
        '<rect x="10.123456" width="1" stroke="#000000" stroke-width="0.3" fill="#ff0000"/></g></svg>',
    )
    sanitizeSvgTree(root)
    const path = root.querySelector('path')!
    expect(path.getAttribute('d')).toBe('M1084.9 164L2 3')
    for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray']) expect(path.hasAttribute(a)).toBe(false)
    const rect = root.querySelector('rect')!
    expect(rect.getAttribute('x')).toBe('10.12')
    expect(rect.getAttribute('stroke-width')).toBe('0.3')
    expect(rect.getAttribute('stroke')).toBe('currentColor')
    expect(rect.getAttribute('fill')).toBe('#ff0000')
    expect(root.querySelector('g')!.getAttribute('data-n')).toBe('3 4')
  })
})

describe('roundNumbers', () => {
  it('rounds long decimals and leaves short ones', () => {
    expect(roundNumbers('M1.5 2.25 3.14159 -0.0001')).toBe('M1.5 2.25 3.14 0')
    expect(roundNumbers('M1.25 3.14159', 1)).toBe('M1.3 3.1')
  })
})

describe('isSafeSvgMarkup', () => {
  it('accepts sanitized markup', () => {
    expect(
      isSafeSvgMarkup(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g class="vf-notehead" data-n="3 4"><path d="M1 1h2"></path></g><text>A &amp; B&nbsp;&lt;1&gt;</text></svg>',
      ),
    ).toBe(true)
  })

  it('finds attributes after a quoted value or a slash, not only after whitespace', () => {
    expect(isSafeSvgMarkup('<svg><g class="pn-corr"onanimationstart="alert(1)"></g></svg>')).toBe(false)
    expect(isSafeSvgMarkup("<svg><g class='pn-corr'onanimationstart='alert(1)'></g></svg>")).toBe(false)
    expect(isSafeSvgMarkup('<svg/onload="alert(1)"></svg>')).toBe(false)
  })

  it('rejects character references that could spell an unsafe value', () => {
    expect(isSafeSvgMarkup('<svg><path fill="&#117;rl(https://e.com/x)"></path></svg>')).toBe(false)
    expect(isSafeSvgMarkup('<svg><path fill="&#x75;rl(https://e.com/x)"></path></svg>')).toBe(false)
    expect(isSafeSvgMarkup('<svg><path fill="javascript&colon;x"></path></svg>')).toBe(false)
  })

  const inText = (text: string): string =>
    `<svg viewBox="0 0 10 10"><g class="x"><text x="1" y="2" font-size="12">${text}</text></g></svg>`

  it.each([
    'Tempo I = 72',
    'Swing (2 eighths = triplet)',
    "Verse 2: 'Tis = so",
    'url (x)',
    'curl(up)',
    'a tempo (M.M. = 60)',
    'q = 72',
    '= 120',
    'x=1',
    'A = 440 Hz',
    'Allegro',
    'url(https://e.com/x) javascript:alert(1) expression(x) onload="alert(1)"',
    'quotes " and \' and &gt; > and &nbsp;',
  ])('accepts engraved text %j: text between tags is inert', (text) => {
    expect(isSafeSvgMarkup(inText(text))).toBe(true)
  })

  const rejected: [string, string][] = [
    // Markup the HTML tokenizer reads as something other than a tag.
    ['a comment', '<svg><!-- x --></svg>'],
    ['a comment hiding a tag from a naive scan', '<svg><!--<g class="-->"><path onload="x()"></path></svg>'],
    ['a doctype', '<!DOCTYPE html><svg></svg>'],
    ['a CDATA section', '<svg><text><![CDATA[<path onload="x()">]]></text></svg>'],
    ['a processing instruction', '<svg><?xml version="1.0"?></svg>'],
    ['a bogus comment from an end tag without a name', '<svg></ g></svg>'],
    ['an empty end tag', '<svg><g></></g></svg>'],
    ['a lone less-than sign in text', '<svg><text>1 < 2</text></svg>'],
    // Tag syntax outside the canonical form.
    ['an end tag with an attribute', '<svg><g></g class="x"></svg>'],
    ['an end tag with a space', '<svg><g></g ></svg>'],
    ['an end tag with a slash', '<svg><g></g/></svg>'],
    ['a self-closing tag', '<svg><path d="M0 0"/></svg>'],
    ['a self-closing tag after a space', '<svg><path d="M0 0" /></svg>'],
    ['a slash between attributes', '<svg class="x"/viewBox="0 0 1 1"></svg>'],
    ['an unquoted value', '<svg><path d=M0></path></svg>'],
    ['a single-quoted value', "<svg><path d='M0'></path></svg>"],
    ['an attribute without a value', '<svg><path class></path></svg>'],
    ['a space before the equals sign', '<svg><path d ="M0"></path></svg>'],
    ['a space after the equals sign', '<svg><path d= "M0"></path></svg>'],
    ['an attribute right after a quote', '<svg><g class="a"onload="x()"></g></svg>'],
    ['a trailing space in a tag', '<svg><g class="a" ></g></svg>'],
    ['two spaces between attributes', '<svg><g class="a"  fill="red"></g></svg>'],
    ['an unterminated value', '<svg><g class="a></g></svg>'],
    ['an unterminated tag', '<svg><g'],
    ['a quote inside a value closing it early', '<svg><g class="a"b"></g></svg>'],
    // Names: the tokenizer lowercases them, so only the exact allowed spelling is accepted.
    ['an uppercase element', '<SVG></SVG>'],
    ['a mixed-case element', '<svg><Path d="M0"></Path></svg>'],
    ['an uppercase attribute', '<svg CLASS="x"></svg>'],
    ['viewBox in lowercase', '<svg viewbox="0 0 1 1"></svg>'],
    ['viewBox outside an svg (the HTML parser would lowercase it)', '<g viewBox="0 0 1 1"></g>'],
    ['an element outside the allow-list', '<svg><image href="x"></image></svg>'],
    ['an attribute outside the allow-list', '<svg><path d="M0" onclick="x()"></path></svg>'],
    ['a namespaced attribute', '<svg><g xlink:href="#x"></g></svg>'],
    ['a name with a NUL', '<svg><path\0 d="M0"></path\0></svg>'],
    // Elements the HTML parser treats specially (none of them is allowed).
    ['script', '<svg><script>alert(1)</script></svg>'],
    ['style', '<svg><style>g{fill:url(#x)}</style></svg>'],
    ['title', '<svg><title>x</title></svg>'],
    ['foreignObject', '<svg><foreignObject><div>x</div></foreignObject></svg>'],
    ['textarea', '<svg><textarea>x</textarea></svg>'],
    ['noscript', '<noscript><svg></svg></noscript>'],
    // Control characters and whitespace other than one space between attributes.
    ['a NUL in a value', '<svg><path d="M0\0"></path></svg>'],
    ['a NUL in text', '<svg><text>a\0b</text></svg>'],
    ['a form feed between attributes', '<svg\fclass="x"></svg>'],
    ['a tab between attributes', '<svg\tclass="x"></svg>'],
    ['a newline between attributes', '<svg\nclass="x"></svg>'],
    ['a carriage return in text', '<svg><text>a\rb</text></svg>'],
    ['a form feed in text', '<svg><text>a\fb</text></svg>'],
    ['a newline in a value', '<svg><path d="M0\n1"></path></svg>'],
    ['a no-break space between attributes', '<svg class="x"></svg>'],
    // Character references: anything but the ones outerHTML writes could spell an unsafe value.
    ['a decimal reference in a value', '<svg><path fill="&#117;rl(#x)"></path></svg>'],
    ['a hexadecimal reference in a value', '<svg><path fill="&#x75;rl(#x)"></path></svg>'],
    ['a named reference in a value', '<svg><path fill="javascript&colon;x"></path></svg>'],
    ['a reference without a semicolon', '<svg><path class="&amp"></path></svg>'],
    ['a bare ampersand in a value', '<svg><path class="a&b"></path></svg>'],
    [
      'a no-break space reference in a value (it would decode to whitespace)',
      '<svg><path fill="url&nbsp;(#x)"></path></svg>',
    ],
    ['a numeric reference in text', '<svg><text>&#60;script&#62;</text></svg>'],
    ['a named reference in text', '<svg><text>&lpar;</text></svg>'],
    ['a bare ampersand in text', '<svg><text>a & b</text></svg>'],
    // Unsafe attribute values.
    ['url( in a value', '<svg><path fill="url(#x)"></path></svg>'],
    ['url ( with a space in a value', '<svg><path fill="URL (#x)"></path></svg>'],
    ['javascript: in a value', '<svg><g class="javascript:x"></g></svg>'],
    ['expression( in a value', '<svg><g font-family="expression(x)"></g></svg>'],
    ['url( after a no-break space in a value', '<svg><path fill="url (#x)"></path></svg>'],
    // Structure: the scanner and the parser must agree on which element is open.
    ['an unclosed element', '<svg><g></g>'],
    ['a stray end tag', '<svg></svg></svg>'],
    ['an end tag that does not match', '<svg><g></path></svg>'],
    ['misnested tags', '<svg><g><text></g></text></svg>'],
    ['an end tag closing an outer element first', '<svg><g></svg><g viewBox="0 0 1 1"></g></g>'],
    ['text before the root', 'x<svg></svg>'],
    ['text after the root', '<svg></svg>x'],
    ['whitespace after the root', '<svg></svg>\n'],
    ['nesting deeper than 256 elements', '<g>'.repeat(257) + '</g>'.repeat(257)],
  ]

  it.each(rejected)('rejects %s', (_, markup) => {
    expect(isSafeSvgMarkup(markup)).toBe(false)
  })

  it('accepts the canonical forms that browsers serialize', () => {
    // Several roots (sticky glyphs), `<`, `>` and a raw no-break space in values (older serializers
    // leave them unescaped), the value references, transforms and the svg namespace.
    expect(isSafeSvgMarkup('<g transform="translate(1 2)"><path d="M0 0"></path></g><g class="b"></g>')).toBe(true)
    expect(isSafeSvgMarkup('<svg><g class="a<b>c d &amp;&quot;&lt;&gt;"></g></svg>')).toBe(true)
    expect(isSafeSvgMarkup('<svg><g><svg viewBox="0 0 1 1"></svg></g></svg>')).toBe(true)
    expect(isSafeSvgMarkup('<g><svg><g viewBox="0 0 1 1"></g></svg></g>')).toBe(true)
    expect(isSafeSvgMarkup('<g>' + '<g>'.repeat(255) + '</g>'.repeat(256))).toBe(true)
    expect(isSafeSvgMarkup('')).toBe(true)
  })

  it('accepts duplicate attributes only when each one is safe (the parser keeps the first)', () => {
    expect(isSafeSvgMarkup('<svg><g class="a" class="b"></g></svg>')).toBe(true)
    expect(isSafeSvgMarkup('<svg><g fill="red" fill="url(#x)"></g></svg>')).toBe(false)
  })

  it('accepts sanitized trees serialized with outerHTML (round trip)', () => {
    // happy-dom's parser drops everything after a `<script>` inside an svg, so the script and
    // style elements are added with the DOM instead.
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()">',
      '<foreignObject><div>x</div></foreignObject>',
      '<g class=\'a"b&amp;c<d> e\' style="fill:url(#x)" data-n="1 2">',
      '<path d="M1.23456 2L3 4" fill="url(#p)" stroke="#000"/><image href="x"/>',
      '<text x="1" font-family="Times New Roman">Tempo I = 72 &lt;q&gt; &amp; " \'   url(x)</text>',
      '<a href="javascript:x()"><rect width="1"/></a><use href="#x"/>',
      '</g><g transform="translate(1 2)"><svg viewBox="0 0 1 1"><circle r="1"></circle></svg></g></svg>',
    ].join('')
    const host = document.createElement('div')
    host.innerHTML = hostile
    const root = host.firstElementChild!
    for (const name of ['script', 'style']) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', name)
      el.textContent = '</g>alert(1)'
      root.querySelector('g')!.append(el)
    }
    expect(root.querySelectorAll('text, script, style, rect')).toHaveLength(4)
    for (const round of [true, false]) {
      const copy = root.cloneNode(true) as Element
      sanitizeSvgTree(copy, round)
      expect(copy.outerHTML).toContain('Tempo I = 72')
      expect(isSafeSvgMarkup(copy.outerHTML)).toBe(true)
      for (const g of copy.querySelectorAll('g')) expect(isSafeSvgMarkup(g.outerHTML)).toBe(true)
    }
  })
})
