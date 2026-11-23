import { test, expect } from '../browser-test'
import { fixtureFile, fixtureText, storedSettings } from './app-helpers'
import { installFakeMidi, loopWholePiece, openSeededPractice, playWhenDue, seedPiece } from './practice-helpers'

const cases = [
  {
    device: 'es-MX',
    lang: 'es-ES',
    library: 'Biblioteca',
    settings: 'Ajustes',
    general: 'General',
    language: 'Idioma',
    add: 'Añadir y abrir',
  },
  {
    device: 'fr-CA',
    lang: 'fr-CA',
    library: 'Bibliothèque',
    settings: 'Paramètres',
    general: 'Général',
    language: 'Langue',
    add: 'Ajouter et ouvrir',
  },
  {
    device: 'fr-BE',
    lang: 'fr-FR',
    library: 'Bibliothèque',
    settings: 'Réglages',
    general: 'Général',
    language: 'Langue',
    add: 'Ajouter et ouvrir',
  },
  {
    device: 'tl-PH',
    lang: 'fil-PH',
    library: 'Aklatan',
    settings: 'Mga Setting',
    general: 'Pangkalahatan',
    language: 'Wika',
    add: 'Idagdag at buksan',
  },
  {
    device: 'ja',
    lang: 'ja-JP',
    library: 'ライブラリ',
    settings: '設定',
    general: '一般',
    language: '言語',
    add: '追加して開く',
  },
  {
    device: 'de-AT',
    lang: 'en-US',
    library: 'Library',
    settings: 'Settings',
    general: 'General',
    language: 'Language',
    add: 'Add and open',
  },
]

for (const c of cases) {
  test.describe(c.device, () => {
    test.use({ locale: c.device, viewport: { width: 360, height: 740 } })
    test('matches the device, imports a score, and switches language in place', async ({ page }) => {
      await page.goto('./')
      await expect(page.locator('html')).toHaveAttribute('lang', c.lang)
      await expect(page.getByRole('heading', { name: c.library, exact: true })).toBeVisible()
      // A title that is also interface copy must retain its original spelling.
      const xml = fixtureText('two-hands.musicxml').replaceAll('Two Hands', 'Settings')
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles({ name: 'Settings.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) })
      const sheet = page.locator('dialog[open]')
      await expect(sheet.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await sheet.getByRole('button', { name: c.add, exact: true }).click()
      await expect(page.locator('.pn-strip').first()).toBeVisible({ timeout: 60000 })
      const url = page.url()
      const menu = ({ 'es-ES': 'Menú', 'ja-JP': 'メニュー' } as Record<string, string>)[c.lang] ?? 'Menu'
      await page.getByRole('button', { name: menu, exact: true }).click()
      await page.getByRole('button', { name: c.settings, exact: true }).click()
      await sheet.getByRole('tab', { name: c.general, exact: true }).click()
      const select = sheet.getByRole('combobox', { name: c.language, exact: true })
      await expect(select).toHaveValue('system')
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
      await select.selectOption(c.lang === 'fr-CA' ? 'es-ES' : 'fr-CA')
      const tag = c.lang === 'fr-CA' ? 'es-ES' : 'fr-CA'
      await expect(page.locator('html')).toHaveAttribute('lang', tag)
      await expect(sheet.getByRole('combobox', { name: tag === 'fr-CA' ? 'Langue' : 'Idioma' })).toHaveValue(tag)
      const close = tag === 'fr-CA' ? 'Fermer' : 'Cerrar'
      await sheet.getByRole('button', { name: close, exact: true }).click()
      await expect(page).toHaveURL(url)
      await expect(page.locator('.pn-strip').first()).toHaveAttribute(
        'aria-label',
        tag === 'fr-CA' ? 'Partition' : 'Partitura',
      )
      await expect(page.locator('h1', { hasText: 'Settings' })).toBeAttached()
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('lang', tag)
      expect((await storedSettings(page))?.view.language).toBe(tag)
      // The first render after a reload waits for the cached catalog: only then is there a screen.
      await expect(page.locator('.pn-strip').first()).toBeVisible({ timeout: 60_000 })
      const menuAfterReload = page.getByRole('button', { name: tag === 'fr-CA' ? 'Menu' : 'Menú', exact: true })
      if (await menuAfterReload.isVisible()) await menuAfterReload.click()
      await page.getByRole('button', { name: tag === 'fr-CA' ? 'Paramètres' : 'Ajustes', exact: true }).click()
      await sheet.getByRole('tab', { name: tag === 'fr-CA' ? 'Général' : 'General', exact: true }).click()
      await sheet.getByRole('combobox', { name: tag === 'fr-CA' ? 'Langue' : 'Idioma' }).selectOption('system')
      await expect(page.locator('html')).toHaveAttribute('lang', c.lang)
    })
  })
}

test.describe('Filipino score workflows', () => {
  test.use({ locale: 'fil-PH', viewport: { width: 820, height: 1180 } })
  test('explains an import error and opens the translated Study and Results views', async ({ page }) => {
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'Aklatan' })).toBeVisible()
    await page.locator('input[type=file]').first().setInputFiles(fixtureFile('unrelated.xml'))
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Hindi ma-import ang file na ito.')
    await expect(dialog).toContainText('MusicXML')
    await expect(dialog).not.toContainText('not a MusicXML score')
    await expect(dialog.getByRole('button', { name: 'Pumili ng ibang file' })).toBeVisible()
    await dialog.locator('button[aria-label="Isara"]').click()
    await page.getByRole('button', { name: 'Buksan ang partitura ng Ode to Joy' }).click()
    await expect(page.getByTestId('study-screen').getByRole('group', { name: 'Partitura', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sundan ang tugtog ko', exact: true })).toBeVisible()
    await page.goto('./#/results')
    await expect(page.getByRole('heading', { name: 'Resulta', exact: true })).toBeVisible()
  })
})

test('follows changes to ordered device languages while offline', async ({ page, context }) => {
  await page.goto('./')
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await context.setOffline(true)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['ko', 'ja', 'fr-CA', 'en'] })
    window.dispatchEvent(new Event('languagechange'))
  })
  await expect(page.getByRole('heading', { name: 'ライブラリ' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja-JP')
})

for (const [lang, close, start, show, title, clean] of [
  [
    'fil-PH',
    'Isara',
    'Magsimula',
    'Ipakita ang mga detalle ng ulit na ito',
    'Ulit na ito',
    'Walang sablay: walang maling nota.',
  ],
  ['ja-JP', '閉じる', '開始', '今回の演奏の詳細を表示', '今回の演奏', 'ミスなく弾けました。'],
] as const) {
  test(`scores a MIDI performance in ${lang} after changing the language with a loop open`, async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
    await loopWholePiece(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('tab', { name: 'General', exact: true }).click()
    await sheet.getByRole('combobox', { name: 'Language' }).selectOption(lang)
    await sheet.getByRole('button', { name: close, exact: true }).click()
    await page.getByRole('button', { name: start, exact: true }).click()
    for (const keys of [[60, 48], [62], [64], [65], [67, 71, 74, 43], [48]]) await playWhenDue(page, ...keys)
    await page.getByRole('button', { name: show }).click()
    const details = page.getByTestId('result-details')
    await expect(details).toContainText(title)
    await expect(details).toContainText(clean)
  })
}
