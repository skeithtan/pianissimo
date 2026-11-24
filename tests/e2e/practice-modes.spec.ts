/**
 * The four modes of the score screen (DECISIONS U141): the control on each size of screen, what a
 * missing piano leaves, one hand in Listen, Follow over MIDI, the old study links, and the header's
 * fit in the interface languages. Phones have no Web MIDI here (like Safari on one), so a piece
 * opens in Listen and plays through browser sound (U72). `practice-reload.spec.ts` has the reloads,
 * `practice-mic.spec.ts` Follow through the microphone, `recordings.spec.ts` the header with a take.
 */
import { expect, test, type Page } from '../browser-test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import es from '../../src/i18n/locales/es-ES.json' with { type: 'json' }
import en from '../../src/i18n/locales/en-US.json' with { type: 'json' }
import fil from '../../src/i18n/locales/fil-PH.json' with { type: 'json' }
import fr from '../../src/i18n/locales/fr-FR.json' with { type: 'json' }
import ja from '../../src/i18n/locales/ja-JP.json' with { type: 'json' }
import { idbAll } from './app-helpers'
import {
  PIECE_ID,
  chooseMode,
  expectMode,
  installFakeMidi,
  openFooterMenu,
  openSeededPractice,
  play,
  seedPiece,
  type ModeName,
} from './practice-helpers'

const COLD = { timeout: 60_000 }
const MAIN: Readonly<Record<ModeName, string>> = {
  Listen: 'Play',
  Wait: 'Start',
  'Keep time': 'Start',
  Follow: 'Start',
}
const DESCRIPTION: Readonly<Record<ModeName, string>> = {
  Listen: 'The app plays it for you.',
  Wait: 'The score waits until you play the right notes.',
  'Keep time': 'The score keeps going, whatever you play.',
  Follow: 'The score follows your playing. Nothing is graded.',
}
const MODES = Object.keys(MAIN) as ModeName[]

const screen = (page: Page) => page.locator('[data-activity]')
const header = (page: Page) => page.getByTestId('practice-header')
const bar = (page: Page) => page.getByTestId('practice-bar')
const main = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Mode', exact: true })
const modeButton = (page: Page, name: ModeName) => page.getByRole('button', { name: `Mode: ${name}. Change` })
const storedMode = async (page: Page) => (await idbAll<{ id: string; mode?: string }>(page, 'pieces'))[0]?.mode

/** Web MIDI with no ports: a piano that was chosen before and is away. */
async function installMidiWithoutPorts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const access = {
      inputs: new Map(),
      outputs: new Map(),
      onstatechange: null,
      sysexEnabled: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(access) })
  })
}

for (const size of [
  { name: 'a tablet on its side', width: 1194, height: 834, phone: false },
  { name: 'a tablet upright', width: 834, height: 1194, phone: false },
  { name: 'a phone upright', width: 390, height: 844, phone: true },
  { name: 'a phone on its side', width: 844, height: 390, phone: true },
])
  test(`${size.name}: every mode can be chosen, starts nothing and is kept`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
    await expectMode(page, 'Wait') // the piano is there
    for (const name of [...MODES, 'Wait'] as const) {
      if (size.phone) {
        const now = (await screen(page).getAttribute('data-mode'))!
        const label = MODES.find(
          (m) => ({ Listen: 'listen', Wait: 'wait', 'Keep time': 'time', Follow: 'follow' })[m] === now,
        )!
        const button = modeButton(page, label)
        const box = (await button.boundingBox())!
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
        await button.click()
        await expect(sheet(page).getByRole('radio')).toHaveCount(4)
        for (const mode of MODES) {
          const row = sheet(page).getByRole('radio', { name: mode, exact: true })
          await expect(row).toBeChecked({ checked: mode === label })
          await expect(row).toHaveAccessibleDescription(DESCRIPTION[mode])
          await expect(row).toBeInViewport({ ratio: 1 })
        }
        await sheet(page).getByRole('radio', { name, exact: true }).click()
        await expect(sheet(page)).toHaveCount(0)
        await expect(modeButton(page, name)).toBeVisible()
      } else {
        const option = page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name, exact: true })
        await expect(option).toHaveAttribute('title', DESCRIPTION[name])
        await option.click()
        await expect(option).toBeChecked()
        await expect(modeButton(page, name)).toHaveCount(0)
      }
      await expectMode(page, name)
      await expect(main(page, MAIN[name])).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
      await expect(page.getByRole('note')).toHaveCount(0)
      const stored = { Listen: 'listen', Wait: 'wait', 'Keep time': 'time', Follow: 'follow' }[name]
      await expect.poll(() => storedMode(page)).toBe(stored)
      // Repeat is the learner's in every mode but Follow.
      await expect(page.locator('.pn-action-on')).toHaveCount(name === 'Follow' ? 0 : 1)
    }
    // Changing the mode stops what plays.
    await chooseMode(page, 'Listen')
    await main(page, 'Play').click()
    await expect(main(page, 'Pause')).toBeVisible()
    await chooseMode(page, 'Keep time')
    await expect(main(page, 'Start')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width)
  })

test.describe('in focus mode', () => {
  test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true })

  test('the control dims and takes no input: a touch there brings it back and changes nothing', async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
    const modes = page.getByTestId('practice-modes')
    await main(page, 'Start').click()
    await expect(screen(page)).toHaveAttribute('data-recede', 'true')
    await expect(modes).toHaveCSS('opacity', '0.12')
    await expect(modes).toHaveAttribute('inert', '')
    // The header's other controls fade with it (U147).
    await expect(header(page).getByRole('button', { name: 'Settings' })).toHaveCSS('opacity', '0.12')
    const listen = (await modes.getByRole('radio', { name: 'Listen', includeHidden: true }).boundingBox())!
    const at = { x: listen.x + listen.width / 2, y: listen.y + listen.height / 2 }
    await page.touchscreen.tap(at.x, at.y)
    await expect(modes).toHaveCSS('opacity', '1')
    await page.waitForTimeout(400) // longer than a touch's late click
    await expectMode(page, 'Wait')
    await expect(main(page, 'Pause')).toBeVisible()
    // The next one chooses.
    await page.touchscreen.tap(at.x, at.y)
    await expectMode(page, 'Listen')
    await expect(main(page, 'Play')).toBeVisible()
  })
})

for (const size of [
  { width: 1194, height: 834 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
])
  test(`${size.width}×${size.height}: without its piano Wait explains and offers Connect piano; Listen and Follow work`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await installMidiWithoutPorts(page)
    await seedPiece(page)
    await openSeededPractice(page)
    await expectMode(page, 'Wait') // the piano was chosen before
    const note = page.getByRole('note')
    await expect(note).toContainText('Wait needs a connected piano.')
    await expect(main(page, 'Start')).toBeDisabled()
    // The hands stay selectable.
    const left = page.getByRole('button', { name: 'Left hand', exact: true })
    await left.click()
    await expect(left).toHaveAttribute('aria-pressed', 'false')
    await left.click()
    await chooseMode(page, 'Keep time')
    await expect(note).toContainText('Keep time needs a connected piano.')
    const connect = note.getByRole('button', { name: 'Connect piano' })
    await expect(connect).toBeInViewport({ ratio: 1 })
    await connect.click()
    await expect(page.getByRole('tabpanel', { name: 'Piano and sound' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    await expectMode(page, 'Keep time')
    await chooseMode(page, 'Follow') // over the microphone
    await expect(note).toHaveCount(0)
    await expect(main(page, 'Start')).toBeEnabled()
    await chooseMode(page, 'Listen')
    await expect(note).toHaveCount(0)
    await expect(main(page, 'Play')).toBeEnabled()
  })

test('Listen plays the chosen hand only', async ({ page }) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await chooseMode(page, 'Listen')
  const right = page.getByRole('button', { name: 'Right hand', exact: true })
  await page.getByRole('button', { name: 'Left hand', exact: true }).click()
  await expect(right).toHaveAttribute('title', 'Right hand: you hear it')
  const attacks = () =>
    page.evaluate(() => window.__midi.sent.filter((m) => (m[0]! & 0xf0) === 0x90 && m[2]! > 0).map((m) => m[1]!))
  await main(page, 'Play').click()
  await expect.poll(attacks).toContain(62)
  expect(await attacks()).not.toContain(48)
  // The only lit hand stays on.
  await right.click()
  await expect(right).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('At least one hand stays on.')).toBeVisible()
})

test('Follow moves with the MIDI piano, and neither it nor Listen records practice', async ({ page }) => {
  await page.setViewportSize({ width: 1194, height: 834 })
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await chooseMode(page, 'Follow')
  const cue = page.getByTestId('timing-cue')
  const playhead = page.locator('.pn-cursor-bar')
  const defaultColor = await playhead.evaluate((b: HTMLElement) => {
    b.style.transition = 'none'
    return getComputedStyle(b).backgroundColor
  })
  await page.clock.install()
  await main(page, 'Start').click()
  await expect(main(page, 'Pause')).toBeVisible()
  const targets = page.locator('.pn-music .pn-target:not(.pn-acc)')
  const targetIds = () => targets.evaluateAll((els) => els.map((el) => el.getAttribute('data-n')))
  await expect.poll(targetIds).not.toEqual([])
  const first = await targetIds()
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 150)))
  await play(page, 85)
  await page.clock.runFor(50)
  await expect(playhead).toHaveCSS('background-color', defaultColor)
  await expect(cue).toBeHidden()
  await play(page, 60, 48)
  await page.clock.runFor(50)
  await expect
    .poll(async () => {
      const next = await targetIds()
      return next.length > 0 && next.join(' ') !== first.join(' ')
    })
    .toBe(true)
  await expect(cue).toBeHidden()
  await page.clock.runFor(350)
  await play(page, 62)
  await page.clock.runFor(50)
  await expect(cue).toHaveAttribute('data-direction', 'rushing')
  await expect(cue).toBeVisible()
  await expect(playhead).not.toHaveCSS('background-color', defaultColor)
  await page.clock.resume()
  await chooseMode(page, 'Listen')
  await main(page, 'Play').click()
  await expect(main(page, 'Pause')).toBeVisible()
  await expect(targets).toHaveCount(0)
  await expect(cue).toBeHidden()
  await expect(playhead).toHaveCSS('background-color', defaultColor)
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
  await page.waitForTimeout(500)
  expect(await idbAll(page, 'attempts')).toEqual([])
  const pieces = await idbAll<{ resume?: unknown }>(page, 'pieces')
  expect(pieces[0]?.resume ?? null).toBeNull()
})

test.describe('the Library', () => {
  test('its Continue line names the mode first, unless it is Wait', async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    for (const name of ['Keep time', 'Follow', 'Listen', 'Wait'] as const) {
      await chooseMode(page, name)
      await page.getByRole('button', { name: 'Back to Library' }).click()
      const line = page.getByText(/Repeat bar 1 · both hands/)
      await expect(line).toHaveText(name === 'Wait' ? /^Repeat bar 1/ : new RegExp(`^${name} · Repeat bar 1`))
      await expect(page.getByRole('button', { name: /sheet music/i })).toHaveCount(0)
      await openSeededPractice(page)
      await expectMode(page, name)
    }
  })
})

test.describe('old links to the Sheet music screen', () => {
  for (const path of ['study', 'consult'])
    test(`#/${path}/<id> opens the piece in Listen, under its new address, and leaves its own mode`, async ({
      page,
    }) => {
      await installFakeMidi(page)
      await seedPiece(page)
      await openSeededPractice(page)
      await chooseMode(page, 'Keep time')
      await expect.poll(() => storedMode(page)).toBe('time')
      await page.getByRole('button', { name: 'Back to Library' }).click()
      await page.evaluate((hash) => (location.hash = hash), `#/${path}/${PIECE_ID}`)
      await expect(page.locator('.pn-strip')).toBeVisible(COLD)
      await expectMode(page, 'Listen')
      expect(await page.evaluate(() => location.hash)).toBe(`#/practice/${PIECE_ID}`)
      await main(page, 'Play').click()
      await expect(main(page, 'Pause')).toBeVisible()
      await main(page, 'Pause').click()
      await page.waitForTimeout(400)
      expect(await storedMode(page)).toBe('time')
      // A reload opens the piece as it is stored, and Back still goes to the Library.
      await page.reload()
      await expect(page.locator('.pn-strip')).toBeVisible(COLD)
      await expectMode(page, 'Keep time')
      await page.goBack()
      await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
    })

  test('a cold start at one opens Listen, and #/study alone is Practice without a piece', async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await page.goto(`./#/study/${PIECE_ID}`)
    await page.reload()
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
    await page.goto('./#/study')
    await expect(page.getByRole('heading', { name: 'Choose a piece to practice' })).toBeVisible()
    expect(await page.evaluate(() => location.hash)).toBe('#/practice')
  })
})

test.describe('a phone without Web MIDI', () => {
  test.describe('upright', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('opens in Listen, plays through this device on the fitted page, and records nothing', async ({ page }) => {
      const samples: string[] = []
      page.on('request', (r) => {
        if (r.url().includes('/samples/')) samples.push(r.url())
      })
      await seedPiece(page, { route: DEFAULT_SETTINGS.route })
      await openSeededPractice(page)
      await expectMode(page, 'Listen')
      await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'page')
      // The page is engraved to the stage's width and fitted to it: nothing scrolls sideways (R17).
      await expect(page.locator('.pn-page-wide')).toHaveCount(0)
      await expect(page.locator('footer')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      const title = modeButton(page, 'Listen')
      await expect(title).toContainText('Two Hands')
      await expect(title).toContainText('Listen')
      await expect(bar(page).getByText('Pianissimo fixtures')).toHaveCount(0)
      for (const button of [title, bar(page).getByRole('button', { name: 'Back to Library' }), main(page, 'Play')]) {
        const box = (await button.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(390)
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
      }
      expect(samples).toEqual([])
      await main(page, 'Play').click()
      await expect(main(page, 'Pause')).toBeVisible({ timeout: 20_000 })
      expect(samples.length).toBeGreaterThan(0)
      await main(page, 'Pause').click()
      const overview = page.getByRole('slider', { name: 'Piece overview' })
      await overview.press('End')
      await expect(overview).toHaveAttribute('aria-valuenow', '2')
      await overview.press('Home')
      await expect(overview).toHaveAttribute('aria-valuenow', '1')
      await page.waitForTimeout(500)
      expect(await idbAll(page, 'attempts')).toHaveLength(0)
      const pieces = await idbAll<{ resume?: unknown; mode?: string }>(page, 'pieces')
      expect(pieces[0]?.resume ?? null).toBeNull()
      expect(pieces[0]?.mode).toBeUndefined()
    })

    test('its menu has Note names and Show keys in Listen, and the guide reaches the bottom', async ({ page }) => {
      await seedPiece(page, { route: DEFAULT_SETTINGS.route })
      await openSeededPractice(page)
      const labels = page.locator('.pn-label')
      await expect(labels).toHaveCount(0)
      const menu = await openFooterMenu(page)
      // The menu has no visible title, only its close button (U81).
      await expect(menu.locator('h2')).toHaveCount(0)
      const names = menu.getByRole('radiogroup', { name: 'Note names on the score' })
      await names.getByRole('radio', { name: 'All' }).click()
      await expect(labels.first()).toBeVisible({ timeout: 30_000 })
      await names.getByRole('radio', { name: 'Off' }).click()
      await expect(labels).toHaveCount(0, { timeout: 30_000 })
      await menu.getByRole('switch', { name: 'Show keys' }).check()
      await expect(page.getByTestId('guide-slot')).toHaveAttribute('data-open', 'true')
      await menu.getByRole('button', { name: 'Close' }).click()
      await expect(menu).toHaveCount(0)
      const guide = (await page.getByTestId('guide-slot').boundingBox())!
      expect(guide.y + guide.height).toBeGreaterThanOrEqual(844 - 40)
    })
  })

  test.describe('on its side', () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })

    test('its bar holds the timeline and the mode in one row, and the strip gets the height', async ({ page }) => {
      await seedPiece(page, { route: DEFAULT_SETTINGS.route })
      await openSeededPractice(page)
      await expectMode(page, 'Listen')
      await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'strip')
      await expect(screen(page)).toHaveAttribute('data-sideways', 'true')
      expect((await page.getByTestId('strip-host').boundingBox())!.height).toBeGreaterThanOrEqual(390 - 80)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      const overview = (await bar(page).getByRole('slider', { name: 'Piece overview' }).boundingBox())!
      const mode = (await modeButton(page, 'Listen').boundingBox())!
      const left = (await page.getByRole('button', { name: 'Left hand', exact: true }).boundingBox())!
      const middle = (b: { y: number; height: number }) => b.y + b.height / 2
      expect(Math.abs(middle(overview) - middle(mode))).toBeLessThan(8)
      expect(Math.abs(middle(left) - middle(mode))).toBeLessThan(8)
      expect(mode.x).toBeGreaterThanOrEqual(overview.x + overview.width)
      expect(left.x).toBeGreaterThanOrEqual(mode.x + mode.width)
      expect(overview.width).toBeGreaterThan(844 / 2)
      await expect(page.getByTestId('guide-slot')).toHaveAttribute('data-open', 'false')
      const menu = await openFooterMenu(page)
      await expect(menu.getByRole('switch', { name: 'Show keys' })).toHaveCount(0)
    })
  })
})

const CATALOGS = { 'en-US': en, 'es-ES': es, 'fr-FR': fr, 'fil-PH': fil, 'ja-JP': ja } as const

/** The header's parts as boxes: in order, none meeting another, inside the header, the modes centered. */
async function headerParts(page: Page) {
  return header(page).evaluate((node) => {
    const box = (el: Element) => {
      const { left, right, top, bottom } = el.getBoundingClientRect()
      return { left, right, top, bottom }
    }
    const modes = node.querySelector('[data-testid="practice-modes"]')!
    return {
      modes: node.dataset['modes'],
      header: box(node),
      row: [
        node.querySelector('button')!,
        node.querySelector('h1')!,
        modes.querySelector(':scope > button') ?? modes.querySelector('[role="radiogroup"]')!,
        node.querySelector('[data-state]')!,
        node.lastElementChild!.lastElementChild!,
      ].map(box),
      /** The options, each on one line inside the control. */
      options: [...modes.querySelectorAll('[role="radio"]')].map((el) => ({
        ...box(el),
        clipped: el.scrollWidth > el.clientWidth,
      })),
    }
  })
}

for (const language of ['en-US', 'fr-FR', 'ja-JP', 'es-ES', 'fil-PH'] as const)
  for (const size of [
    { width: 1194, height: 834 },
    { width: 834, height: 1194 },
    { width: 744, height: 1133 },
  ])
    for (const piano of [true, false])
      test(`${language} at ${size.width} px${piano ? '' : ', no piano'}: the modes fit in the header`, async ({
        page,
      }) => {
        const say = (source: string) => {
          const id = Object.keys(en).find((key) => (en as Record<string, string>)[key] === source)!
          return (CATALOGS[language] as Record<string, string>)[id]!
        }
        await page.setViewportSize(size)
        if (piano) await installFakeMidi(page)
        else await installMidiWithoutPorts(page)
        await seedPiece(page, {
          view: { ...DEFAULT_SETTINGS.view, language: language as AppSettings['view']['language'] },
        })
        await page.goto(`./#/practice/${PIECE_ID}`)
        await expect(page.locator('.pn-strip')).toBeVisible(COLD)
        await expect(page.locator(`header [data-state="${piano ? 'connected' : 'disconnected'}"]`)).toBeVisible()
        for (const long of [false, true]) {
          if (long)
            await page.locator('h1').evaluate((h1) => {
              h1.textContent = 'Invention No. 13 in A minor, arranged for two hands and a patient left one'
            })
          const parts = await headerParts(page)
          for (const [i, b] of parts.row.entries()) {
            expect(b.left).toBeGreaterThanOrEqual(parts.header.left)
            expect(b.right).toBeLessThanOrEqual(parts.header.right)
            expect(b.top).toBeGreaterThanOrEqual(parts.header.top)
            expect(b.bottom).toBeLessThanOrEqual(parts.header.bottom)
            if (i > 0) expect(b.left).toBeGreaterThanOrEqual(parts.row[i - 1]!.right)
          }
          // The title keeps some words, beside all four modes wherever they fit (only Filipino's are too
          // long, and only on the narrowest tablet).
          expect(parts.row[1]!.right - parts.row[1]!.left).toBeGreaterThanOrEqual(long ? 96 : 60)
          expect(parts.modes).toBe(language === 'fil-PH' && size.width === 744 ? 'one' : 'all')
          if (parts.modes === 'all') {
            const middle = (b: { left: number; right: number }) => (b.left + b.right) / 2
            expect(Math.abs(middle(parts.row[2]!) - middle(parts.header))).toBeLessThan(1)
            expect(parts.options).toHaveLength(4)
            for (const option of parts.options) {
              expect(option.clipped).toBe(false)
              expect(option.top).toBe(parts.options[0]!.top)
            }
          }
          // The chip says its words in enough room, else it is a dot.
          const chip = parts.row[3]!.right - parts.row[3]!.left
          expect(chip === 48 || chip >= 90).toBe(true)
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width)
        }
        // It works wherever it is.
        const one = header(page).getByRole('button', { name: new RegExp(`^${say('Mode')}`) })
        if (await one.count()) {
          await one.click()
          await page
            .getByRole('dialog', { name: say('Mode'), exact: true })
            .getByRole('radio', { name: say('Keep time'), exact: true })
            .click()
        } else
          await page
            .getByRole('radiogroup', { name: say('Mode') })
            .getByRole('radio', { name: say('Keep time'), exact: true })
            .click()
        await expectMode(page, 'Keep time')
      })
