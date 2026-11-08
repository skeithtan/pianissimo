/**
 * Installed app and offline support (DECISIONS U84) against the production build: the manifest
 * and icons, an offline relaunch after one online visit (the shell, every file of the build,
 * Practice and an import), and staying on the latest deploy while online. The deploy specs fake
 * a new deploy by changing one file of dist/ and re-running the worker generator over it, then
 * put the files back; they need the preview server to serve this checkout's dist/ (APP_PORT).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { writeServiceWorker } from '../../scripts/pwa'
import { addToLibrary, fixtureFile, importFile, sheet } from './app-helpers'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIST = join(ROOT, 'dist')
/** The files a fake deploy rewrites, restored after each test. */
const TOUCHED = ['index.html', 'sw.js', 'mic-processor.js']

/** Every file the deploy serves, as paths relative to the app (what the worker must precache). */
function deployedFiles(): string[] {
  return readdirSync(DIST, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(DIST, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !path.endsWith('.map') && !path.startsWith('.vite/') && path !== 'sw.js')
}

const localBuild = (): string | undefined =>
  /<meta name="pianissimo-build" content="([^"]+)">/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'))?.[1]

/** The build the page runs, or null while it is reloading. */
const buildOf = (page: Page): Promise<string | null> =>
  page
    .evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="pianissimo-build"]')?.content ?? null)
    .catch(() => null)

/** Wait until the worker has precached the build and controls the page. */
async function waitForWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 })
}

/** The worker builds whose caches exist. */
const cachedBuilds = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await caches.keys()).map((name) => name.slice(name.lastIndexOf(':') + 1)).sort())

/** Fake a deploy: change one public file and regenerate the worker over dist/. */
async function deploy(marker: string): Promise<string> {
  const path = join(DIST, 'mic-processor.js')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// ${marker}\n`)
  return (await writeServiceWorker(ROOT, DIST)).build
}

const originals = new Map<string, Buffer>()

test.beforeAll(() => {
  for (const name of TOUCHED) originals.set(name, readFileSync(join(DIST, name)))
})

test.afterEach(() => {
  for (const [name, bytes] of originals) writeFileSync(join(DIST, name), bytes)
})

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  test.skip(!(await page.evaluate(() => 'serviceWorker' in navigator)), 'no service workers in this browser')
  // The deploy specs rewrite dist/: make sure the server serves this checkout's build.
  expect(await buildOf(page), 'the preview server must serve this checkout (set APP_PORT)').toBe(localBuild())
})

test('the manifest is linked, parses, and its icons resolve', async ({ page }) => {
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const manifestUrl = new URL(href!, page.url())
  const response = await page.request.get(manifestUrl.href)
  expect(response.ok()).toBe(true)
  const manifest = (await response.json()) as {
    name: string
    display: string
    start_url: string
    scope: string
    theme_color: string
    background_color: string
    icons: { src: string; sizes: string; type: string; purpose?: string }[]
  }
  expect(manifest).toMatchObject({ name: 'Pianissimo', display: 'standalone', theme_color: '#1f1c17' })
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/)
  const appUrl = new URL('./', page.url()).href
  expect(new URL(manifest.start_url, manifestUrl).href).toBe(appUrl)
  expect(new URL(manifest.scope, manifestUrl).href).toBe(appUrl)

  const icons = manifest.icons.map((icon) => ({ ...icon, url: new URL(icon.src, manifestUrl).href }))
  const appleHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  icons.push({ src: appleHref!, sizes: '180x180', type: 'image/png', url: new URL(appleHref!, page.url()).href })
  expect(icons.map((icon) => icon.sizes).sort()).toEqual(['180x180', '192x192', '512x512', '512x512'])
  expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
  for (const icon of icons) {
    const image = await page.request.get(icon.url)
    expect(image.ok(), icon.url).toBe(true)
    const png = await image.body()
    // PNG signature, then the IHDR chunk: width and height as big-endian 32-bit integers.
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes)
  }
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Pianissimo')
})

test('after one online visit the app relaunches and works offline', async ({ page, context }) => {
  await addToLibrary(page, fixtureFile('two-hands.musicxml'))
  await waitForWorker(page)

  await context.setOffline(true)
  // Truly offline, the worker's own network included: a file it never cached fails.
  expect(
    await page.evaluate(() =>
      fetch('mic-processor.js?probe').then(
        () => 'online',
        () => 'offline',
      ),
    ),
  ).toBe('offline')
  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()

  // Every file of the deploy answers: each chunk (lazy views, the notation engine, backup), the
  // workers, the microphone worklet, the fonts, the piano samples, the manifest and icons.
  const failed = await page.evaluate(async (paths) => {
    const bad: string[] = []
    for (const path of paths)
      if (
        !(await fetch(path).then(
          (r) => r.ok,
          () => false,
        ))
      )
        bad.push(path)
    return bad
  }, deployedFiles())
  expect(failed).toEqual([])

  // Practice boots offline and Listen plays with the cached samples (no piano here).
  await page.getByRole('button', { name: 'Practice Two Hands' }).click()
  await expect(page.locator('.pn-strip')).toBeVisible()
  await page.getByRole('button', { name: 'Back to Library' }).click()

  // An import works offline too (the import worker).
  await importFile(page, fixtureFile('repeats.musicxml'))
  await sheet(page).getByRole('button', { name: 'Add to library' }).click()
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByText('is in your library')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect(page.locator('.pn-strip')).toBeVisible()
})

test('an online reload runs a new deploy at once, and the old cache goes', async ({ page }) => {
  await waitForWorker(page)
  const first = await buildOf(page)
  const next = await deploy('deploy 2')
  expect(next).not.toBe(first)

  await page.reload()
  expect(await buildOf(page)).toBe(next)
  // The new worker takes over in the background, and the old build's cache is deleted once no
  // open page runs it.
  await expect.poll(() => cachedBuilds(page), { timeout: 30_000 }).toEqual([next])
})

test('an open app moves to a new deploy only where nothing is interrupted', async ({ page, context }) => {
  await addToLibrary(page, fixtureFile('two-hands.musicxml'))
  await waitForWorker(page)
  const first = await buildOf(page)
  const marker = () => page.evaluate(() => (window as { pnMarker?: boolean }).pnMarker === true).catch(() => false)

  // On the Practice screen a newer worker takes over, but the page stays put.
  await page.getByRole('button', { name: 'Practice Two Hands' }).click()
  await expect(page.locator('.pn-strip')).toBeVisible()
  await page.evaluate(() => ((window as { pnMarker?: boolean }).pnMarker = true))
  const next = await deploy('deploy 2')
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update())
  await expect.poll(() => cachedBuilds(page), { timeout: 30_000 }).toContain(next)
  await page.waitForTimeout(1500)
  expect(await marker()).toBe(true)
  expect(await buildOf(page)).toBe(first)
  // The build this page runs keeps its cache, so its lazily loaded chunks stay available.
  expect(await cachedBuilds(page)).toContain(first)

  // Leaving Practice reloads into the new build.
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect.poll(() => buildOf(page), { timeout: 15_000 }).toBe(next)
  expect(await marker()).toBe(false)
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()

  // On the Library, with nothing open, the next deploy is taken as soon as the network is back.
  await page.evaluate(() => ((window as { pnMarker?: boolean }).pnMarker = true))
  await context.setOffline(true)
  const third = await deploy('deploy 3')
  await context.setOffline(false)
  await expect.poll(() => buildOf(page), { timeout: 30_000 }).toBe(third)
  expect(await marker()).toBe(false)
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
})
