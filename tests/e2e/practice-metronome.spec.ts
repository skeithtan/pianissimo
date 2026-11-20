/**
 * The Metronome switch (DECISIONS U87, P20) in the real app: the Practice menu's row and the Study
 * menu's row (U90), which preference each edits, and the clicks themselves. With the fake MIDI piano and both
 * hands selected the app makes no other browser sound, so the metronome's oscillators are the
 * clicks: a wrapper around `AudioContext.prototype.createOscillator` counts them.
 */
import { expect, test, type Page } from '../browser-test'
import { sheet, storedSettings } from './app-helpers'
import { installFakeMidi, openFooterMenu, openSeededPractice, seedPiece } from './practice-helpers'

declare global {
  interface Window {
    __clicks: number
    __clickOutputs: string[]
  }
}

/** Counts every oscillator any AudioContext creates, on `window.__clicks`. */
async function countOscillators(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__clicks = 0
    const proto = window.AudioContext?.prototype
    if (!proto) return
    const create = proto.createOscillator
    proto.createOscillator = function (this: AudioContext) {
      window.__clicks++
      return create.call(this)
    }
  })
}

const clicks = (page: Page) => page.evaluate(() => window.__clicks)

async function metronomeSwitch(page: Page) {
  const menu = await openFooterMenu(page)
  return menu.getByRole('switch', { name: 'Metronome' })
}

async function keepTimeSwitch(page: Page) {
  const menu = await openFooterMenu(page)
  return menu.getByRole('switch', { name: 'Keep time' })
}

test.describe('Practice Metronome switch', () => {
  test.beforeEach(async ({ page }) => {
    await countOscillators(page)
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
  })

  test('is off by default, reads the Keep time preference in Keep time and leaves the general one alone', async ({
    page,
  }) => {
    const metronome = await metronomeSwitch(page)
    await expect(metronome).not.toBeChecked()
    // Keep time's own preference is on by default.
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).toBeChecked()
    // Turn it off there: it stays off after Keep time goes off and on again.
    await metronome.click()
    await expect(metronome).not.toBeChecked()
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
    // The general preference (Keep time off) was never touched.
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
    // And turning the general one on does not change Keep time's.
    await metronome.click()
    await expect(metronome).toBeChecked()
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
  })

  test('Keep time clicks through the attempt after the count-in; with the switch off only the count-in clicks', async ({
    page,
  }) => {
    await (await keepTimeSwitch(page)).click()
    await expect(await metronomeSwitch(page)).toBeChecked()
    await page.keyboard.press('Escape')
    expect(await clicks(page)).toBe(0)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    await expect.poll(() => clicks(page)).toBeGreaterThanOrEqual(4)
    // The attempt keeps adding clicks once the one-bar count-in (4 s at 60 BPM) is over.
    await expect(page.getByTestId('count-in')).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(() => clicks(page), { timeout: 10_000 }).toBeGreaterThan(4)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()

    // Off in Keep time: the count-in still clicks, nothing after it.
    const metronome = await metronomeSwitch(page)
    await metronome.click()
    await expect(metronome).not.toBeChecked()
    await page.keyboard.press('Escape')
    const before = await clicks(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    await expect(page.getByTestId('count-in')).toHaveCount(0, { timeout: 10_000 })
    await page.waitForTimeout(1500)
    expect((await clicks(page)) - before).toBe(4)
  })

  test('ordinary reading with the switch off creates no click', async ({ page }) => {
    await expect(await metronomeSwitch(page)).not.toBeChecked()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.waitForTimeout(1500)
    expect(await clicks(page)).toBe(0)
  })

  test('turning it on in ordinary reading saves the general preference', async ({ page }) => {
    const metronome = await metronomeSwitch(page)
    await metronome.click()
    await expect(metronome).toBeChecked()
    await expect.poll(async () => (await storedSettings(page))?.['metronome']).toMatchObject({ enabled: true })
  })
})

test.describe('Study Metronome switch', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

  test("toggles in the tablet footer's Sheet music menu (U90)", async ({ page }) => {
    await seedPiece(page)
    await page.getByRole('button', { name: 'Open sheet music for Two Hands' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'study')
    await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('study-screen').locator('footer').getByRole('button', { name: 'Menu', exact: true }).click()
    const metronome = page.getByRole('dialog', { name: 'Sheet music menu' }).getByRole('switch', { name: 'Metronome' })
    await expect(metronome).not.toBeChecked()
    await metronome.click()
    await expect(metronome).toBeChecked()
    await expect.poll(async () => (await storedSettings(page))?.['metronome']).toMatchObject({ enabled: true })
    await metronome.click()
    await expect(metronome).not.toBeChecked()
  })
})

async function openSoundSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = sheet(page)
  await settings.getByRole('tab', { name: 'Sound' }).click()
  return settings
}

test('Test click works through system audio without changing either click switch', async ({ page }) => {
  await countOscillators(page)
  await seedPiece(page)
  const settings = await openSoundSettings(page)
  await expect(settings.getByRole('combobox', { name: /^Metronome output/u })).toHaveValue('')
  await settings.getByRole('button', { name: 'Test click' }).click()
  await expect.poll(() => clicks(page)).toBe(1)
  await expect(settings.getByRole('switch', { name: 'Metronome click' })).not.toBeChecked()
  await expect(settings.getByRole('switch', { name: 'Click in Keep time' })).toBeChecked()
})

test('the saved audio output plays the test click and the Keep time count-in', async ({ page }) => {
  await page.addInitScript(() => {
    window.__clickOutputs = []
    const piano = { kind: 'audiooutput', deviceId: 'usb-piano', label: 'USB Piano Audio' }
    const outputs = new WeakMap<AudioContext, string>()
    // WebKit can recreate the MediaDevices wrapper after reload or garbage collection.
    Object.defineProperty(MediaDevices.prototype, 'enumerateDevices', {
      value: async () => (sessionStorage.getItem('piano-unplugged') ? [] : [piano]),
      configurable: true,
    })
    const proto = window.AudioContext.prototype
    Object.defineProperty(proto, 'setSinkId', {
      value: async function (this: AudioContext, id: string) {
        if (id !== piano.deviceId || sessionStorage.getItem('piano-unplugged')) {
          throw new DOMException('Audio output unavailable', 'NotFoundError')
        }
        outputs.set(this, id)
      },
      configurable: true,
    })
    const create = proto.createOscillator
    proto.createOscillator = function (this: AudioContext) {
      window.__clickOutputs.push(outputs.get(this) ?? 'system')
      return create.call(this)
    }
  })
  const clickOutputs = () => page.evaluate(() => window.__clickOutputs)
  await installFakeMidi(page)
  await seedPiece(page)
  const settings = await openSoundSettings(page)
  const output = settings.getByRole('combobox', { name: /^Metronome output/u })
  await output.selectOption({ label: 'USB Piano Audio' })
  await expect.poll(async () => (await storedSettings(page))?.['metronome']).toMatchObject({ outputId: 'usb-piano' })
  await settings.getByRole('button', { name: 'Test click' }).click()
  await expect.poll(clickOutputs).toEqual(['usb-piano'])
  await settings.getByRole('button', { name: 'Close', exact: true }).click()

  await page.reload()
  await openSeededPractice(page)
  await (await keepTimeSwitch(page)).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('count-in')).toBeVisible()
  await expect.poll(clickOutputs).toEqual(Array<string>(4).fill('usb-piano'))

  await page.evaluate(() => sessionStorage.setItem('piano-unplugged', 'true'))
  await page.goto('./')
  await openSoundSettings(page)
  await expect(output).toHaveValue('usb-piano')
  await settings.getByRole('button', { name: 'Test click' }).click()
  await expect.poll(clickOutputs).toEqual(['system'])
  await expect(settings.getByRole('status').filter({ hasText: 'The test used system audio.' })).toBeVisible()
  await output.selectOption('')
  await expect.poll(async () => (await storedSettings(page))?.['metronome']).toMatchObject({ outputId: null })
})
