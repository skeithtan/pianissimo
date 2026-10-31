/** Shared helpers for renderer specs: open the harness page and call `window.harness`. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

export const HARNESS_URL = process.env['HARNESS_URL'] ?? `http://localhost:${process.env['HARNESS_PORT'] ?? 4174}/`

export const REFERENCE_PIECE = 'reference-piece.musicxml'
export const referencePresent = existsSync(
  fileURLToPath(new URL(`../fixtures/private/${REFERENCE_PIECE}`, import.meta.url)),
)

export async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS_URL)
  await expect.poll(() => page.evaluate(() => typeof window.harness === 'object')).toBe(true)
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function overlaps(a: Box, b: Box, eps = 0.5): boolean {
  return a.x + a.w - eps > b.x && b.x + b.w - eps > a.x && a.y + a.h - eps > b.y && b.y + b.h - eps > a.y
}
