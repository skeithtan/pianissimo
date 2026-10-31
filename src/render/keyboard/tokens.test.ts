import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const moduleCss = read('./KeyboardGuide.module.css')
const globalCss = read('../../ui/global.css')

const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/gu)].map((m) => m[1]))
const used = (css: string) => new Set([...css.matchAll(/var\((--[\w-]+)/gu)].map((m) => m[1]))

describe('KeyboardGuide.module.css', () => {
  it('only uses custom properties that global.css or the module itself defines', () => {
    const known = new Set([...defined(globalCss), ...defined(moduleCss)])
    const unknown = [...used(moduleCss)].filter((name) => !known.has(name))
    expect(unknown).toEqual([])
  })

  it('takes the part, accepted and wrong colors from the shared tokens', () => {
    for (const token of ['--color-left-hand', '--color-right-hand', '--color-accepted', '--color-wrong']) {
      expect(used(moduleCss)).toContain(token)
    }
  })

  it('has no literal colors', () => {
    const literals = moduleCss.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/giu) ?? []
    expect(literals).toEqual([])
  })
})
