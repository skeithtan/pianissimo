/**
 * Renders the installed-app icons in public/icons/ from public/favicon.svg with Playwright's
 * Chromium (DECISIONS U84). Run it after changing the favicon, then commit the PNGs:
 *
 *   node scripts/render-icons.mjs
 *
 * The favicon's lettering asks for Georgia, which macOS has; elsewhere Chromium substitutes
 * another serif, so render on a Mac. PW_CHROMIUM_PATH picks another Chromium, as in
 * playwright.config.ts.
 *  - icon-192.png, icon-512.png: the favicon as drawn (rounded square, transparent corners).
 *  - apple-touch-icon.png (180 × 180): square corners. iOS rounds them itself and would fill
 *    transparent corners with black.
 *  - icon-maskable-512.png: square corners, the lettering shrunk into the maskable safe zone
 *    (the central circle, 80 % of the width), since launchers crop to their own shape.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const square = favicon.replace(/ rx="[^"]*"/, '')
const maskable = square.replace('<text ', '<text transform="translate(16 15) scale(0.72) translate(-16 -16)" ')
const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url))

const icons = [
  ['icon-192.png', favicon, 192],
  ['icon-512.png', favicon, 512],
  ['apple-touch-icon.png', square, 180],
  ['icon-maskable-512.png', maskable, 512],
]

mkdirSync(outDir, { recursive: true })
const executablePath = process.env['PW_CHROMIUM_PATH']
const browser = await chromium.launch(executablePath ? { executablePath } : {})
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const [name, svg, size] of icons) {
    await page.setViewportSize({ width: size, height: size })
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `)
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${outDir}${name}`, omitBackground: true })
    console.log(`public/icons/${name} (${size} × ${size})`)
  }
} finally {
  await browser.close()
}
