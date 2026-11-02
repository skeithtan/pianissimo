/**
 * Text metrics for reserved label boxes and app-drawn measure numbers (DECISIONS R3, R6).
 *
 * Widths come from the font the strip actually draws with (`.pn-label` / `.pn-mnum` in
 * strip.css: `LABEL_FONT_FAMILY` weight 700 at the label size / `--font-ui` weight 500 at 11 px),
 * measured once per text with a canvas 2D context and cached for the session. The label font is a
 * web font: `loadLabelFont` must resolve before measuring (R14). Without a usable canvas (Node,
 * happy-dom) or when the browser rejects the font string, the deterministic estimate is used
 * (0.62 em per character), so unit tests do not depend on fonts.
 *
 * The reserved label box must hold the widest label the naming settings can produce without a
 * relayout (R3): `maxChars` identifies the naming family (letters or fixed do, with or without
 * octave — see `maxLabelWidthChars`), and the box is the widest of every name × accidental (♯ ♭ ♮
 * 𝄪 𝄫 or none) × octave digit of that family, because accidental and enharmonic preferences change
 * labels without changing `maxChars`.
 */
import type { NamingSettings } from '../../core/model/settings'
import type { Step } from '../../core/music/pitch'
import { DOUBLE_FLAT, DOUBLE_SHARP, FLAT, NATURAL, SHARP } from '../../core/naming/glyphs'
import { maxLabelWidthChars, stepName } from '../../core/naming/label'

/** Measures the advance width of text in a CSS font shorthand ("600 12px system-ui"). */
export interface TextMeasurer {
  width(text: string, font: string): number
}

/** Strip label weight (strip.css `.pn-label`, `.pn-corr-label`; the bundled face's weight). */
export const LABEL_FONT_WEIGHT = 700
/**
 * Default note-label size in layout px (hint labels and persistent note names): 13.5, about 12 %
 * above the former 12 px (user, 2026-10-31). Part of the layout cache key (`labelFontPx`).
 */
export const LABEL_FONT_PX = 13.5
/** App-drawn measure number font (strip.css `.pn-mnum`). */
export const NUMBER_FONT_WEIGHT = 500
export const NUMBER_FONT_PX = 11
/** Measure number box height and baseline offset within it (StripView draws at y + 10). */
export const NUMBER_BOX_H = 13
/** Fallback when `--font-ui` is not defined (strip.css uses the same fallback). */
export const FALLBACK_FONT_FAMILY = 'system-ui, sans-serif'
/**
 * Note-label font stack (R14, revised): the self-hosted "Pianissimo Label" (Inter Bold for
 * letters and digits + Noto Music for ♯ ♭ ♮ 𝄪 𝄫, by unicode-range, both faces declared at 700;
 * `@font-face` in strip.css, files in public/fonts), else the system UI font. strip.css
 * `--pn-label-font` must be exactly this string (unit-tested).
 */
export const LABEL_FONT_FAMILY = '"Pianissimo Label", system-ui, sans-serif'
/** Every glyph class a label can contain: loads both unicode-range faces. */
const LABEL_FONT_SAMPLE = `CDEFGABdoremifasltiA0123456789${SHARP}${FLAT}${NATURAL}${DOUBLE_SHARP}${DOUBLE_FLAT}`

/**
 * Loads the label web font (both faces) so canvas measurement and the first labels use it. Never
 * rejects; gives up after `timeoutMs` (the system fallback is then measured and drawn alike).
 */
export async function loadLabelFont(
  doc: Document | undefined,
  fontPx = LABEL_FONT_PX,
  timeoutMs = 3000,
): Promise<void> {
  const fonts = doc?.fonts
  if (!fonts || typeof fonts.load !== 'function') return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fonts.load(labelFont(fontPx, LABEL_FONT_FAMILY), LABEL_FONT_SAMPLE),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } catch {
    // A failed download leaves the fallback in place; it is measured like any other font.
  } finally {
    clearTimeout(timer)
  }
}

const EM_PER_CHAR = 0.62
/** Estimated measure number advance per character at 11 px. */
const NUMBER_PX_PER_CHAR = 6.4

function fontPxOf(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return m ? Number(m[1]) : LABEL_FONT_PX
}

/** Deterministic width estimate: characters (code points) × 0.62 em. */
export const estimateMeasurer: TextMeasurer = {
  width: (text, font) => Array.from(text).length * fontPxOf(font) * EM_PER_CHAR,
}

const cache = new Map<string, number>()

/**
 * Canvas-backed measurer with a session-wide cache (each distinct text and font is measured
 * once). Falls back to `estimateMeasurer` per font when the browser rejects the font string, and
 * returns null when no 2D context exists.
 */
export function canvasMeasurer(doc: Document): TextMeasurer | null {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = doc.createElement('canvas').getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx || typeof ctx.measureText !== 'function') return null
  const c = ctx
  let current = ''
  let ok = false
  return {
    width(text, font) {
      const k = `${font}\n${text}`
      const hit = cache.get(k)
      if (hit !== undefined) return hit
      if (font !== current) {
        c.font = font
        current = font
        // An unparsable shorthand leaves the previous font in place.
        ok = c.font.includes(`${fontPxOf(font)}px`)
      }
      const w = ok ? c.measureText(text).width : estimateMeasurer.width(text, font)
      cache.set(k, w)
      return w
    },
  }
}

/** The strip's UI font family: `--font-ui` as computed on `el`, else the CSS fallback. */
export function uiFontFamily(el: Element | null | undefined): string {
  if (!el) return FALLBACK_FONT_FAMILY
  try {
    const v = el.ownerDocument.defaultView?.getComputedStyle(el).getPropertyValue('--font-ui').trim()
    return v || FALLBACK_FONT_FAMILY
  } catch {
    return FALLBACK_FONT_FAMILY
  }
}

export const labelFont = (fontPx: number, family: string): string => `${LABEL_FONT_WEIGHT} ${fontPx}px ${family}`
export const numberFont = (family: string): string => `${NUMBER_FONT_WEIGHT} ${NUMBER_FONT_PX}px ${family}`

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const ACCIDENTALS = ['', SHARP, FLAT, NATURAL, DOUBLE_SHARP, DOUBLE_FLAT]
const OCTAVES = ['0', '1', '2', '3', '4', '5', '6', '7', '8']

/**
 * Every label text a naming family with this `maxChars` can produce (empty when no family
 * matches; the caller then reserves `maxChars` of the widest glyph).
 */
export function labelCandidates(maxChars: number): string[] {
  const names = new Set<string>()
  let octave = false
  for (const system of ['letter', 'fixed-do'] as const) {
    for (const seventh of ['si', 'ti'] as const) {
      for (const showOctave of [false, true]) {
        const naming: NamingSettings = {
          system,
          seventh,
          showOctave,
          alwaysShowEffectiveAccidentals: true,
          simplifyEnharmonics: false,
        }
        if (maxLabelWidthChars(naming) !== maxChars) continue
        for (const s of STEPS) names.add(stepName(s, naming))
        octave ||= showOctave
      }
    }
  }
  const out: string[] = []
  for (const n of names) for (const a of ACCIDENTALS) for (const o of octave ? OCTAVES : ['']) out.push(`${n}${a}${o}`)
  return out
}

/** Widest glyph any label can contain (fallback for an unknown `maxChars`). */
function widestGlyph(measure: TextMeasurer, font: string): number {
  const glyphs = new Set<string>([...OCTAVES, ...ACCIDENTALS.filter(Boolean)])
  for (const system of ['letter', 'fixed-do'] as const)
    for (const s of STEPS) for (const ch of stepName(s, { system, seventh: 'ti' })) glyphs.add(ch)
  glyphs.add('i')
  let w = 0
  for (const g of glyphs) w = Math.max(w, measure.width(g, font))
  return w
}

/**
 * Reserved label box (every label gets it, R3): the widest candidate text plus 1 px inside each
 * side (labels are drawn 1 px in from their anchor edge), 1.2 em high.
 */
export function labelBoxSize(
  maxChars: number,
  fontPx: number,
  measure: TextMeasurer = estimateMeasurer,
  family = FALLBACK_FONT_FAMILY,
): { w: number; h: number } {
  const h = Math.round(fontPx * 1.2)
  if (measure === estimateMeasurer) return { w: Math.ceil(maxChars * fontPx * EM_PER_CHAR) + 2, h }
  const font = labelFont(fontPx, family)
  const candidates = labelCandidates(maxChars)
  let text = 0
  if (candidates.length > 0) for (const c of candidates) text = Math.max(text, measure.width(c, font))
  else text = maxChars * widestGlyph(measure, font)
  return { w: Math.ceil(text) + 2, h }
}

/** Width of an app-drawn measure number box (text drawn 1 px in from its left edge). */
export function numberBoxWidth(
  text: string,
  measure: TextMeasurer = estimateMeasurer,
  family = FALLBACK_FONT_FAMILY,
): number {
  if (measure === estimateMeasurer) return Math.ceil(Array.from(text).length * NUMBER_PX_PER_CHAR) + 2
  return Math.ceil(measure.width(text, numberFont(family))) + 2
}
