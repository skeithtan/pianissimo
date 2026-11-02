import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { maxLabelWidthChars } from '../../core/naming'
import type { NamingSettings } from '../../core/model/settings'
import {
  canvasMeasurer,
  estimateMeasurer,
  LABEL_FONT_FAMILY,
  LABEL_FONT_PX,
  LABEL_FONT_WEIGHT,
  labelBoxSize,
  labelCandidates,
  loadLabelFont,
  numberBoxWidth,
  type TextMeasurer,
} from './metrics'

/** Deterministic fake font: 7 px per character, 10 px for "m", 5 px for accidentals, × px/12. */
const fake: TextMeasurer = {
  width(text, font) {
    const px = Number(/(\d+)px/.exec(font)?.[1] ?? 12)
    let w = 0
    for (const ch of Array.from(text)) w += ch === 'm' ? 10 : /[♯♭♮\u{1D12A}\u{1D12B}]/u.test(ch) ? 5 : 7
    return (w * px) / 12
  },
}

const naming = (p: Partial<NamingSettings>): NamingSettings => ({
  system: 'letter',
  seventh: 'si',
  showOctave: false,
  alwaysShowEffectiveAccidentals: true,
  simplifyEnharmonics: false,
  ...p,
})

describe('label candidates per naming family', () => {
  it('letters, with and without octave', () => {
    expect(labelCandidates(maxLabelWidthChars(naming({})))).toHaveLength(7 * 6)
    const withOctave = labelCandidates(maxLabelWidthChars(naming({ showOctave: true })))
    expect(withOctave).toHaveLength(7 * 6 * 9)
    expect(withOctave).toContain('G\u{1D12B}8')
  })

  it('fixed do includes both si and ti', () => {
    const c = labelCandidates(maxLabelWidthChars(naming({ system: 'fixed-do', showOctave: true })))
    expect(c).toContain('sol♯8')
    expect(c).toContain('si♭0')
    expect(c).toContain('ti♮4')
  })

  it('is empty for a width no naming family produces', () => {
    expect(labelCandidates(9)).toEqual([])
  })
})

describe('label box size', () => {
  it('keeps the 0.62 em estimate without a measurer', () => {
    expect(labelBoxSize(3, 12)).toEqual({ w: 25, h: 14 })
    expect(labelBoxSize(5, 16)).toEqual({ w: 52, h: 19 })
  })

  it('defaults to 13.5 px labels (about 12 % above the former 12 px)', () => {
    expect(LABEL_FONT_PX).toBe(13.5)
    expect(labelBoxSize(3, LABEL_FONT_PX)).toEqual({ w: 28, h: 16 })
  })

  it('uses the widest measured candidate plus 1 px each side', () => {
    // Letters + octave: widest = letter 7 + accidental 5 + digit 7 = 19.
    expect(labelBoxSize(3, 12, fake)).toEqual({ w: 21, h: 14 })
    // Fixed do + octave: "sol" (21) + 5 + 7 = 33 beats "mi" (17) + 12.
    expect(labelBoxSize(5, 12, fake).w).toBe(35)
    // Scaled with the font size.
    expect(labelBoxSize(3, 24, fake).w).toBe(40)
  })

  it('falls back to maxChars × the widest glyph for an unknown width', () => {
    expect(labelBoxSize(9, 12, { width: (t) => (t === 'm' ? 11 : 4) }).w).toBe(101)
  })
})

describe('measure number width', () => {
  it('estimates 6.4 px per character without a measurer', () => {
    expect(numberBoxWidth('12')).toBe(15)
    expect(numberBoxWidth('12 (pass 2)')).toBe(73)
  })

  it('measures in the 11 px number font', () => {
    const seen: string[] = []
    expect(numberBoxWidth('12', { width: (t, f) => (seen.push(f), t.length * 6) }, 'Inter, sans-serif')).toBe(14)
    expect(seen).toEqual(['500 11px Inter, sans-serif'])
  })
})

describe('canvas measurer', () => {
  it('returns null without a 2D context', () => {
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Document
    expect(canvasMeasurer(doc)).toBeNull()
  })

  it('measures each text once and falls back to the estimate for a rejected font', () => {
    let calls = 0
    const ctx = {
      font: '10px sans-serif',
      measureText: (t: string) => {
        calls++
        return { width: t.length * 3 }
      },
    }
    const accept = (f: string) => {
      if (!f.includes('bogus')) ctx.font = f
    }
    const proxy = new Proxy(ctx, {
      set(target, prop, value) {
        if (prop === 'font') accept(value as string)
        else (target as Record<string | symbol, unknown>)[prop] = value
        return true
      },
    })
    const doc = { createElement: () => ({ getContext: () => proxy }) } as unknown as Document
    const m = canvasMeasurer(doc)!
    expect(m.width('abc', '600 12px test-font-a')).toBe(9)
    expect(m.width('abc', '600 12px test-font-a')).toBe(9)
    expect(calls).toBe(1)
    expect(m.width('ab', '600 13px bogus')).toBeCloseTo(estimateMeasurer.width('ab', '13px'))
    expect(calls).toBe(1)
  })
})

describe('label font (R14)', () => {
  const css = readFileSync(new URL('../strip/strip.css', import.meta.url), 'utf8')

  it('draws labels in exactly the family and weight that are measured, the bundled font first', () => {
    expect(css).toContain(`--pn-label-font: ${LABEL_FONT_FAMILY};`)
    expect(css).toMatch(/\.pn-label \{\s*font-family: var\(--pn-label-font\);\s*font-weight: 700;/)
    expect(LABEL_FONT_FAMILY.startsWith('"Pianissimo Label"')).toBe(true)
    expect(LABEL_FONT_WEIGHT).toBe(700)
  })

  it('declares both faces at the label weight (Chromium joins unicode-range faces only then)', () => {
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]!)
    expect(faces).toHaveLength(2)
    for (const face of faces) expect(face).toContain(`font-weight: ${LABEL_FONT_WEIGHT};`)
  })

  it('self-hosts both faces with a license, accidentals by unicode-range', () => {
    for (const file of ['inter-700-labels.woff2', 'noto-music-accidentals.woff2']) {
      expect(css).toContain(`url('/fonts/${file}')`)
      expect(existsSync(new URL(`../../../public/fonts/${file}`, import.meta.url))).toBe(true)
    }
    expect(css).toContain('unicode-range: U+266D-266F, U+1D12A-1D12B;')
    expect(readFileSync(new URL('../../../public/fonts/LICENSE', import.meta.url), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE Version 1.1',
    )
  })

  it('loads every glyph class before measuring and never rejects', async () => {
    const load = vi.fn(async () => [])
    await loadLabelFont({ fonts: { load } } as unknown as Document, 12)
    expect(load).toHaveBeenCalledWith(`700 12px ${LABEL_FONT_FAMILY}`, expect.stringContaining('\u{1D12B}'))
    await expect(
      loadLabelFont({ fonts: { load: () => Promise.reject(new Error('offline')) } } as unknown as Document),
    ).resolves.toBeUndefined()
    await expect(
      loadLabelFont({ fonts: { load: () => new Promise(() => undefined) } } as unknown as Document, 12, 5),
    ).resolves.toBeUndefined()
    await expect(loadLabelFont(undefined)).resolves.toBeUndefined()
  })
})
