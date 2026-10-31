// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { roundNumbers, sanitizeSvgTree } from './sanitize'

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
