/**
 * Helpers shared by the app-level workflow specs: the real file picker, fixtures (including an
 * .mxl built with fflate), reading IndexedDB straight from the page, and the Library bits that
 * several specs touch. Practice specs also use practice-helpers.ts (fake Web MIDI, seeding).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'

export interface UploadFile {
  name: string
  mimeType: string
  buffer: Buffer
}

const SCORES = fileURLToPath(new URL('../fixtures/scores/', import.meta.url))

export const fixtureText = (name: string): string => readFileSync(join(SCORES, name), 'utf8')

export function fixtureFile(name: string, asName = name): UploadFile {
  return { name: asName, mimeType: 'application/xml', buffer: readFileSync(join(SCORES, name)) }
}

/** A compressed MusicXML archive (container.xml + one rootfile) holding a fixture. */
export function mxlFile(fixture: string, asName: string): UploadFile {
  const rootfile = 'score.musicxml'
  const zip = zipSync({
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="${rootfile}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`,
    ),
    [rootfile]: strToU8(fixtureText(fixture)),
  })
  return { name: asName, mimeType: 'application/vnd.recordare.musicxml', buffer: Buffer.from(zip) }
}

/** Picks a score through the Library's real file input (a label around a hidden input). */
export async function importFile(page: Page, file: UploadFile): Promise<void> {
  await page.locator('label', { hasText: 'Import MusicXML' }).first().locator('input[type="file"]').setInputFiles(file)
}

/** The open modal sheet (import, delete, restore, ...). */
export const sheet = (page: Page) => page.locator('dialog[open]')

/** Import a fixture, then return from the automatic Practice opening to the Library. */
export async function addToLibrary(page: Page, file: UploadFile): Promise<void> {
  await importFile(page, file)
  await sheet(page).getByRole('button', { name: 'Add to library' }).click()
  // Saving opens Practice; these Library workflows explicitly return to the list.
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByText('is in your library')).toBeVisible()
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
}

/** Records in an IndexedDB object store of the app database (read in the page). */
export async function idbAll<T = unknown>(page: Page, store: string): Promise<T[]> {
  return (await page.evaluate(async (name) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('pianissimo')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(name, 'readonly').objectStore(name).getAll()
        req.onsuccess = () => resolve(req.result as unknown[])
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, store)) as T[]
}

/** The stored (not in-memory) settings record, or null before the first save. */
export async function storedSettings(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('pianissimo')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<Record<string, any> | null>((resolve, reject) => {
        const req = db.transaction('settings', 'readonly').objectStore('settings').get('app')
        req.onsuccess = () => resolve((req.result as Record<string, any> | undefined) ?? null)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
}
