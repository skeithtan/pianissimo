import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { test, expect, type Page } from '../browser-test'
import { installFakeMidi, seedPiece, openSeededPractice, openFooterMenu, play } from './practice-helpers'

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
          return out.stream
        },
      })
    }
  })
}

test('records a scored take, downloads both real files and manages recording history', async ({ page }, info) => {
  await installFakeMidi(page)
  await installPianoAudio(page)
  await seedPiece(page)
  await openSeededPractice(page)
  const record = async (notes: number[]) => {
    await (await openFooterMenu(page)).getByRole('button', { name: 'Record performance' }).click()
    await page.getByRole('button', { name: 'Enable audio input' }).click()
    await expect(page.getByRole('combobox', { name: 'Audio input', exact: true })).toHaveValue('usb')
    await page.getByRole('button', { name: 'Start recording' }).click()
    await expect(page.getByRole('button', { name: /Stop recording/ })).toBeVisible()
    await play(page, ...notes)
    await expect(page.getByRole('button', { name: 'Stop recording · 1 s' })).toBeVisible()
    await page.getByRole('button', { name: /Stop recording/ }).click()
    return page.getByRole('dialog', { name: 'Recordings' })
  }
  let history = await record([60, 48])
  await expect(history.getByText('Best take', { exact: true })).toBeVisible()
  const link = history.getByRole('link', { name: 'Download MIDI and WAV (.zip)' })
  await expect(link).toBeVisible()
  await page.screenshot({ path: info.outputPath('recording-history.png') })
  const pendingDownload = page.waitForEvent('download')
  await link.click()
  const download = await pendingDownload
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const files = unzipSync(await readFile((await download.path())!))
  expect(Object.keys(files)).toHaveLength(2)
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
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'Record performance', exact: true }).click()
  await page.getByRole('button', { name: 'Enable audio input' }).click()
  await expect(page.getByRole('combobox', { name: 'Audio input', exact: true })).toHaveValue('usb')
  await page.screenshot({ path: info.outputPath('recording-phone.png') })
  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop recording · 1 s' })).toBeVisible()
  await play(page, 60)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  const history = page.getByRole('dialog', { name: 'Recordings' })
  await expect(history.getByText('Interrupted', { exact: true })).toBeVisible()
  await expect(history.getByRole('link', { name: 'Download MIDI and WAV (.zip)' })).toBeVisible()
  await expect(history.getByText('Best take', { exact: true })).toHaveCount(0)
})
