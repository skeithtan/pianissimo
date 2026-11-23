/**
 * Import through the real file picker (spec "Supported file formats", "MusicXML import
 * validation", "Import memory lifecycle"): each extension, an unrelated XML file refused with a
 * readable message, and cancelation of a long import in the real worker.
 */
import { INITIAL_PIECES } from '../../src/app/initialPieces'
import { expect, test } from '../browser-test'
import { generateLongScore } from '../fixtures/generate-long-score'
import { addToLibrary, fixtureFile, idbAll, importFile, mxlFile, sheet } from './app-helpers'

const CASES = [
  { ext: '.musicxml', file: () => fixtureFile('two-hands.musicxml', 'etude.musicxml') },
  { ext: '.xml', file: () => fixtureFile('two-hands.musicxml', 'etude.xml') },
  { ext: '.mxl', file: () => mxlFile('two-hands.musicxml', 'etude.mxl') },
] as const

for (const c of CASES) {
  test(`imports a ${c.ext} file picked in the Library and keeps it`, async ({ page }) => {
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'Ode to Joy', exact: true })).toBeVisible()
    await importFile(page, c.file())
    await expect(page.getByText('is in your library')).toBeVisible()
    await page.getByRole('button', { name: 'Back to Library' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^(?:Practice|Continue practice) Two Hands$/ })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
    expect(await idbAll(page, 'pieces')).toHaveLength(INITIAL_PIECES.length + 1)
  })
}

test('the same score twice warns that it is already in the library', async ({ page }) => {
  await page.goto('./')
  await addToLibrary(page, fixtureFile('two-hands.musicxml'))
  await importFile(page, fixtureFile('two-hands.musicxml', 'copy.musicxml'))
  await expect(sheet(page)).toContainText('Already in your library')
  await sheet(page).getByRole('button', { name: 'Open existing piece' }).click()
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.locator('.pn-strip')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  expect(await idbAll(page, 'pieces')).toHaveLength(INITIAL_PIECES.length + 1)
})

test('an unrelated XML file is rejected with a clear message and nothing is stored', async ({ page }) => {
  await page.goto('./')
  await importFile(page, fixtureFile('unrelated.xml'))
  await expect(sheet(page)).toContainText('could not be imported')
  await expect(sheet(page)).toContainText(/MusicXML/)
  await expect(sheet(page).getByRole('button', { name: 'Add and open' })).toHaveCount(0)
  await expect(sheet(page).getByRole('button', { name: 'Choose another file' })).toBeVisible()
  expect(await idbAll(page, 'pieces')).toHaveLength(INITIAL_PIECES.length)
})

test('a damaged .mxl archive is rejected with a clear message', async ({ page }) => {
  await page.goto('./')
  const bad = mxlFile('two-hands.musicxml', 'broken.mxl')
  bad.buffer = bad.buffer.subarray(0, Math.floor(bad.buffer.length / 2))
  await importFile(page, bad)
  await expect(sheet(page)).toContainText('could not be imported')
  await expect(sheet(page).getByRole('button', { name: 'Choose another file' })).toBeVisible()
})

test('canceling a long import terminates the real worker and nothing appears afterwards', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Ode to Joy', exact: true })).toBeVisible()
  let workers = 0
  const closed = new Promise<void>((resolve) => {
    page.on('worker', (w) => {
      workers++
      w.on('close', () => resolve())
    })
  })

  const xml = generateLongScore(3000)
  await importFile(page, { name: 'long.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) })
  const cancel = sheet(page).getByRole('button', { name: 'Cancel import' })
  await expect(cancel).toBeVisible()
  await expect.poll(() => workers).toBeGreaterThan(0)
  await cancel.click()

  // The sheet closes at once and the worker is terminated (no later result can arrive from it).
  await expect(sheet(page)).toHaveCount(0)
  await closed
  // Let any queued task of the page run, then check that nothing came back.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Ode to Joy', exact: true })).toBeVisible()
  expect(await idbAll(page, 'pieces')).toHaveLength(INITIAL_PIECES.length)

  // The importer is free again: a new import works.
  await importFile(page, fixtureFile('two-hands.musicxml'))
  await expect(page.getByText('is in your library')).toBeVisible()
})
