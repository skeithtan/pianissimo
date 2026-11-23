import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { test, expect, type Page } from '../browser-test'
import { installFakeMidi, seedPiece, openSeededPractice, openFooterMenu, play } from './practice-helpers'

test.use({ timezoneId: 'Europe/Paris' })

async function installPianoAudio(page: Page) {
  await page.addInitScript(() => {
    const inputs = [
      { kind: 'audioinput', deviceId: 'internal', label: 'Tablet microphone' },
      { kind: 'audioinput', deviceId: 'usb', label: 'Fake Piano' },
    ]
    let generator: AudioContext | undefined
    const unlock = () => {
      generator ??= new AudioContext()
      void generator.resume().catch(() => {})
    }
    for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) document.addEventListener(type, unlock, true)
    for (const media of [MediaDevices.prototype, navigator.mediaDevices]) {
      Object.defineProperty(media, 'enumerateDevices', { configurable: true, value: async () => inputs })
      Object.defineProperty(media, 'getUserMedia', {
        configurable: true,
        value: async (c: MediaStreamConstraints) => {
          const id =
            typeof c.audio === 'object' && (c.audio.deviceId as { exact?: string })?.exact === 'usb'
              ? 'usb'
              : 'internal'
          unlock()
          const ctx = generator!
          const source = ctx.createOscillator()
          const out = ctx.createMediaStreamDestination()
          source.connect(out)
          source.start()
          const track = out.stream.getAudioTracks()[0]!
          Object.defineProperty(track, 'label', { value: inputs.find((i) => i.deviceId === id)!.label })
          Object.defineProperty(track, 'getSettings', { value: () => ({ deviceId: id, channelCount: 2 }) })
          // Keep the instrument identity on the same track wrapper across Safari's async device queries.
          Object.defineProperty(out.stream, 'getAudioTracks', { value: () => [track] })
          return out.stream
        },
      })
    }
  })
}

/** Before a take the header holds no recording control at all; a take starts from the menu. */
async function expectNoRecordControl(page: Page) {
  await expect(page.locator('[data-recording-control]')).toHaveCount(0)
  await expect(
    page.locator('header, [data-testid="practice-bar"]').getByRole('button', { name: 'Record performance' }),
  ).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Recording', exact: true })).toHaveCount(0)
}

/** Open the recorder from the Practice menu (footer popover, or the phone bar's sheet). */
async function recordFromPracticeMenu(page: Page) {
  await expectNoRecordControl(page)
  const menu = await openFooterMenu(page)
  await menu.getByRole('button', { name: 'Record performance' }).click()
}

/** Open the recorder from the Sheet music menu (footer popover, or the phone header's sheet). */
async function recordFromSheetMusicMenu(page: Page) {
  await expectNoRecordControl(page)
  const footerMenu = page.locator('footer').getByRole('button', { name: 'Menu', exact: true })
  const menu = (await footerMenu.count())
    ? page.getByRole('dialog', { name: 'Sheet music menu' })
    : page.getByRole('dialog', { name: 'Menu' })
  if (await footerMenu.count()) await footerMenu.click()
  else await page.locator('header').getByRole('button', { name: 'Menu', exact: true }).click()
  await menu.getByRole('button', { name: 'Record performance' }).click()
}

async function checkTransport(page: Page) {
  const controls = page.getByRole('group', { name: 'Recording', exact: true })
  await expect(controls.getByRole('timer')).toHaveText(/^[0-9]+:[0-5][0-9]$/)
  await expect(controls.getByRole('button', { name: 'Stop recording', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.locator('header, footer, [data-testid="practice-bar"]').filter({ has: controls })).toHaveCount(1)
  const box = (await controls.boundingBox())!
  for (const element of [page.getByRole('slider', { name: 'Piece overview' }), page.getByTestId('strip-host')]) {
    const other = (await element.boundingBox())!
    expect(
      box.y + box.height <= other.y ||
        other.x + other.width <= box.x ||
        box.x + box.width <= other.x ||
        box.y >= other.y + other.height,
    ).toBe(true)
  }
}

test('records a scored take, downloads both real files and manages recording history', async ({ page }, info) => {
  await installFakeMidi(page)
  await installPianoAudio(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await page.clock.setFixedTime(new Date('2026-11-21T23:04:56.789Z'))
  const record = async (notes: number[], shot = false) => {
    await recordFromPracticeMenu(page)
    await page.getByRole('button', { name: 'Enable audio input' }).click()
    await expect(page.getByRole('combobox', { name: 'Audio input', exact: true })).toHaveValue('usb')
    await page.getByRole('button', { name: 'Start recording' }).click()
    await checkTransport(page)
    const active = page.getByRole('group', { name: 'Recording', exact: true })
    const connected = page.locator('header [data-state="connected"]')
    const connectedBox = (await connected.boundingBox())!
    const activeBox = (await active.boundingBox())!
    expect(activeBox.height).toBe(connectedBox.height)
    expect(activeBox.y).toBe(connectedBox.y)
    const colors = await active.evaluate((node) => {
      const css = getComputedStyle(node)
      const probe = document.createElement('span')
      node.append(probe)
      probe.style.color = 'color-mix(in srgb, var(--danger) 9%, transparent)'
      const fill = getComputedStyle(probe).color
      probe.style.color = 'color-mix(in srgb, var(--danger) 35%, var(--border))'
      const border = getComputedStyle(probe).color
      probe.remove()
      return { fill: css.backgroundColor, border: css.borderTopColor, expectedFill: fill, expectedBorder: border }
    })
    expect(colors.fill).toBe(colors.expectedFill)
    expect(colors.border).toBe(colors.expectedBorder)
    await page.clock.setFixedTime(new Date('2026-11-22T01:00:00Z'))
    await play(page, ...notes)
    await expect(page.getByRole('timer')).not.toHaveText('0:00')
    if (shot) await page.screenshot({ path: info.outputPath('recording-active.png') })
    await page.getByRole('button', { name: /Stop recording/ }).click()
    return page.getByRole('dialog', { name: 'Recordings' })
  }
  let history = await record([60, 48], true)
  await expect(history.getByText('Best take', { exact: true })).toBeVisible()
  const link = history.getByRole('button', { name: 'Download MIDI and WAV (.zip)' })
  await expect(link).toBeVisible()
  await page.screenshot({ path: info.outputPath('recording-history.png') })
  const pendingDownload = page.waitForEvent('download')
  await link.click()
  const download = await pendingDownload
  const stem = 'Two Hands - 2026-11-22 00-04-56.789 UTC+0100'
  expect(download.suggestedFilename()).toBe(stem + '.zip')
  const files = unzipSync(await readFile((await download.path())!))
  expect(Object.keys(files).sort()).toEqual([stem + '.mid', stem + '.wav'])
  const midi = Object.entries(files).find(([k]) => k.endsWith('.mid'))![1]
  const wav = Object.entries(files).find(([k]) => k.endsWith('.wav'))![1]
  expect(String.fromCharCode(...midi.slice(0, 4))).toBe('MThd')
  expect(Array.from(midi)).toContain(0x90)
  expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
  expect(wav.length).toBeGreaterThan(4096)
  expect(new Int16Array(wav.slice(44).buffer).some((sample) => Math.abs(sample) > 100)).toBe(true)
  await history.getByRole('button', { name: 'Close' }).click()
  history = await record([120])
  await expect(history.getByRole('button', { name: /Two Hands/ })).toHaveCount(2)
  await expect(history.getByText('Best take', { exact: true })).toHaveCount(1)
  await page.reload()
  await page.getByRole('button', { name: 'Back to Library', exact: true }).first().click()
  await page.getByRole('button', { name: 'Recordings', exact: true }).click()
  history = page.getByRole('dialog', { name: 'Recordings' })
  await expect(history.getByRole('button', { name: /Two Hands/ })).toHaveCount(2)
  await history
    .getByRole('button', { name: /Two Hands/ })
    .first()
    .click()
  await history.getByRole('button', { name: 'Delete recording' }).click()
  await history.getByRole('button', { name: 'Cancel' }).click()
  await history.getByRole('button', { name: 'Delete recording' }).click()
  await history.getByRole('button', { name: 'Delete recording' }).click()
  await expect(history.getByRole('button', { name: /Two Hands/ })).toHaveCount(1)
})

test('a phone can record from Sheet music and keep both files when the page is interrupted', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await installFakeMidi(page)
  await installPianoAudio(page)
  await seedPiece(page)
  await page.getByRole('button', { name: 'Open sheet music for Two Hands' }).click()
  await recordFromSheetMusicMenu(page)
  await page.getByRole('button', { name: 'Enable audio input' }).click()
  await expect(page.getByRole('combobox', { name: 'Audio input', exact: true })).toHaveValue('usb')
  await page.screenshot({ path: info.outputPath('recording-phone.png') })
  await page.getByRole('button', { name: 'Start recording' }).click()
  await checkTransport(page)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await page.screenshot({ path: info.outputPath('recording-phone-active.png') })
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.getByTestId('study-screen')).toHaveAttribute('data-sideways', 'true')
  await checkTransport(page)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(page.getByTestId('study-screen')).not.toHaveAttribute('data-compact', 'true')
  await checkTransport(page)
  await play(page, 60)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  const history = page.getByRole('dialog', { name: 'Recordings' })
  await expect(history.getByText('Interrupted', { exact: true })).toBeVisible()
  await expect(history.getByRole('button', { name: 'Download MIDI and WAV (.zip)' })).toBeVisible()
  await expect(history.getByText('Best take', { exact: true })).toHaveCount(0)
})

test('Practice keeps Stop within reach on a narrow phone and through rotation while playing', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await installFakeMidi(page)
  await installPianoAudio(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await recordFromPracticeMenu(page)
  await page.getByRole('button', { name: 'Enable audio input' }).click()
  await page.getByRole('button', { name: 'Start recording' }).click()
  await checkTransport(page)
  await expect(page.getByTestId('practice-bar').getByRole('button', { name: 'Menu' })).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await play(page, 60, 48)
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-recede', 'true')
  await expect(page.locator('footer').getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await checkTransport(page)
  await page.screenshot({ path: info.outputPath('recording-practice-small.png') })
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.getByTestId('practice-bar').getByRole('slider', { name: 'Piece overview' })).toBeVisible()
  await checkTransport(page)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(page.locator('header').getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await checkTransport(page)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.getByRole('dialog', { name: 'Recordings' }).getByText('Best take', { exact: true })).toBeVisible()
})

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 844, height: 390 },
]) {
  test(`recording controls stay usable in the focused header at ${viewport.width} px`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await installFakeMidi(page)
    await installPianoAudio(page)
    await seedPiece(page)
    await openSeededPractice(page)
    const header = page.locator('header, [data-testid="practice-bar"]')
    await recordFromPracticeMenu(page)
    await page.getByRole('button', { name: 'Enable audio input' }).click()
    await page.getByRole('button', { name: 'Start recording' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await play(page, 60, 48)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-recede', 'true')
    // Focus mode hides a phone's bar only: a tablet's header stays in full (U93 revised).
    const tablet = viewport.height > 520
    await expect(header.getByRole('button', { name: 'Back to Library' })).toBeVisible({ visible: tablet })
    await checkTransport(page)
    if (tablet) {
      await expect(header.getByRole('button', { name: /MIDI status: Connected/ })).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('footer-tools-slot')).toHaveAttribute('inert', '')
    }
    const stop = header.getByRole('button', { name: 'Stop recording' })
    expect(
      await stop.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      }),
    ).toBe(true)
    await page.screenshot({ path: info.outputPath('recording-focus.png') })
    await stop.click()
    await expect(
      page.getByRole('dialog', { name: 'Recordings' }).getByRole('button', { name: 'Download MIDI and WAV (.zip)' }),
    ).toBeVisible()
  })
}
