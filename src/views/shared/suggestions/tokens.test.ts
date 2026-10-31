import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('suggestions.module.css', () => {
  it('uses theme tokens only (light and dark follow)', () => {
    const css = readFileSync(new URL('./suggestions.module.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/var\(--[\w-]+(?:,[^()]*)?\)/g, 'TOKEN')
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(|\b(?:white|black)\b(?![-\w])/gi)).toBeNull()
  })
})
