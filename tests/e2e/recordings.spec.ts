import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import en from '../../src/i18n/locales/en-US.json' with { type: 'json' }
import fil from '../../src/i18n/locales/fil-PH.json' with { type: 'json' }
import fr from '../../src/i18n/locales/fr-FR.json' with { type: 'json' }
import { test, expect, type Locator, type Page } from '../browser-test'
import {
  chooseMode,
  installFakeMidi,
  seedPiece,
  openSeededPractice,
  openFooterMenu,
  play,
  PIECE_ID,
} from './practice-helpers'

test.use({ timezoneId: 'Europe/Paris' })

interface AudioRig {
  /** What the browser lists. The app opens the first unless it asks for one by its ID. */
  inputs: { kind: string; deviceId: string; label: string }[]
  /** Every request, by the device ID it asked for ('' for any). */
  asked: string[]
  /** getUserMedia refuses (the learner said no). */
  refuse: boolean
  /** getUserMedia answers once this resolves. */
  gate: Promise<void> | null
  /** Labels of the streams still open. */
  live(): string[]
  /** Every element that played a take. */
  players: HTMLMediaElement[]
}
declare global {
  interface Window {
    __audio: AudioRig
    __openGate: () => void
  }
}

async function installPianoAudio(page: Page) {
  await page.addInitScript(() => {
    let generator: AudioContext | undefined
    const unlock = () => {
      generator ??= new AudioContext()
      void generator.resume().catch(() => {})
    }
    for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) document.addEventListener(type, unlock, true)
    const open: { label: string; track: MediaStreamTrack }[] = []
    const rig: AudioRig = {
      inputs: [
        { kind: 'audioinput', deviceId: 'internal', label: 'Tablet microphone' },
        { kind: 'audioinput', deviceId: 'usb', label: 'Fake Piano' },
      ],
      asked: [],
      refuse: false,
      gate: null,
      live: () => open.filter((o) => o.track.readyState === 'live').map((o) => o.label),
      players: [],
    }
    window.__audio = rig
    const playMedia = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      if (!rig.players.includes(this)) rig.players.push(this)
      return playMedia.call(this)
    }
    for (const media of [MediaDevices.prototype, navigator.mediaDevices]) {
      Object.defineProperty(media, 'enumerateDevices', { configurable: true, value: async () => rig.inputs })
      Object.defineProperty(media, 'getUserMedia', {
        configurable: true,
        value: async (c: MediaStreamConstraints) => {
          const wanted = (typeof c.audio === 'object' && (c.audio.deviceId as { exact?: string })?.exact) || ''
          rig.asked.push(wanted)
          if (rig.gate) await rig.gate
          if (rig.refuse) throw new DOMException('Permission denied', 'NotAllowedError')
          const input = wanted ? rig.inputs.find((i) => i.deviceId === wanted) : rig.inputs[0]
          if (!input) throw new DOMException('No such device', 'OverconstrainedError')
          unlock()
          const ctx = generator!
          const source = ctx.createOscillator()
          const out = ctx.createMediaStreamDestination()
          source.connect(out)
          source.start()
          const track = out.stream.getAudioTracks()[0]!
          open.push({ label: input.label, track })
          Object.defineProperty(track, 'label', { value: input.label })
          Object.defineProperty(track, 'getSettings', { value: () => ({ deviceId: input.deviceId, channelCount: 2 }) })
          // Keep the instrument identity on the same track wrapper across Safari's async device queries.
          Object.defineProperty(out.stream, 'getAudioTracks', { value: () => [track] })
          return out.stream
        },
      })
    }
  })
}

const REMEMBERED: AppSettings['recording'] = { inputId: 'usb', inputLabel: 'Fake Piano' }

/** Opening an input waits until `openGate`. */
async function holdOpening(page: Page) {
  await page.evaluate(() => {
    window.__audio.gate = new Promise((resolve) => (window.__openGate = resolve))
  })
}
const openGate = (page: Page) => page.evaluate(() => window.__openGate())

/** Before a take the header holds no recording control at all; a take starts from the menu. */
async function expectNoRecordControl(page: Page) {
  await expect(page.locator('[data-recording-control]')).toHaveCount(0)
  await expect(
    page.locator('header, [data-testid="practice-bar"]').getByRole('button', { name: 'Record performance' }),
  ).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Recording', exact: true })).toHaveCount(0)
}

/** Tap Record performance in the Practice menu (footer popover, or the phone bar's sheet). It closes. */
async function tapRecord(page: Page) {
  const menu = await openFooterMenu(page)
  await menu.getByRole('button', { name: 'Record performance' }).click()
  await expect(page.getByRole('dialog', { name: /^(Practice menu|Menu)$/ })).toHaveCount(0)
}

/** The first take: the recorder opens from the Practice menu, with nothing before it. */
async function recordFromPracticeMenu(page: Page) {
  await expectNoRecordControl(page)
  await tapRecord(page)
}

const setupSheet = (page: Page) => page.getByRole('dialog', { name: 'Record performance' })
const pill = (page: Page) => page.getByRole('group', { name: 'Take saved', exact: true })
const recordings = (page: Page) => page.getByRole('dialog', { name: 'Recordings', exact: true })

/** A take's controls (or its pill) are in view, in the header or footer, and cover neither the timeline nor the score. */
async function checkPlace(page: Page, controls: Locator) {
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

async function checkTransport(page: Page) {
  const controls = page.getByRole('group', { name: 'Recording', exact: true })
  await expect(controls.getByRole('timer')).toHaveText(/^[0-9]+:[0-5][0-9]$/)
  for (const name of ['Stop recording', 'Discard recording'])
    await expect(controls.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
  await checkPlace(page, controls)
}

/** The pill's controls are whole, uncovered, and 48 px to a finger. */
async function checkPill(page: Page) {
  await expect(pill(page)).toBeVisible()
  expect((await pill(page).boundingBox())!.height).toBe(34)
  const buttons = pill(page).getByRole('button')
  await expect(buttons).toHaveCount(3)
  for (const button of await buttons.all()) {
    await expect(button).toBeInViewport({ ratio: 1 })
    const hit = await button.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      const at = (dy: number) => el.contains(document.elementFromPoint(x, y + dy))
      return { width: r.width, reached: [0, -23, 23].map(at) }
    })
    expect(hit.width).toBeGreaterThanOrEqual(48)
    expect(hit.reached).toEqual([true, true, true])
  }
  await checkPlace(page, pill(page))
}

/** The pill is on screen, nothing records, and the score is in view (no list opened over it). */
async function expectSaved(page: Page) {
  await checkPill(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('strip-host')).toBeVisible()
  expect(await page.evaluate(() => window.__audio.live())).toEqual([])
}

const stopRecording = (page: Page) => page.getByRole('button', { name: 'Stop recording', exact: true }).click()

/** Stop from the Practice menu (U163), which closes. */
async function stopFromMenu(page: Page) {
  const menu = await openFooterMenu(page)
  await expect(menu.getByRole('button', { name: 'Record performance' })).toHaveCount(0)
  await menu.getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.getByRole('dialog', { name: /^(Practice menu|Menu)$/ })).toHaveCount(0)
}

/** Open Practice with the piano's audio input remembered, as after an earlier take. */
async function openWithRememberedInput(page: Page, patch: Partial<AppSettings> = {}) {
  await installFakeMidi(page)
  await installPianoAudio(page)
  await seedPiece(page, { recording: REMEMBERED, ...patch })
  await openSeededPractice(page)
}

const player = (page: Page) =>
  page.evaluate(() => window.__audio.players.map((p) => ({ paused: p.paused, src: p.src, at: p.currentTime })))

test('records a scored take, downloads both real files and manages recording history', async ({ page }, info) => {
  await installFakeMidi(page)
  await installPianoAudio(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await page.clock.setFixedTime(new Date('2026-11-21T23:04:56.789Z'))
  await recordFromPracticeMenu(page)
  await expect(setupSheet(page)).toContainText('This choice is kept for next time.')
  await page.getByRole('button', { name: 'Enable audio input' }).click()
  await expect(page.getByRole('combobox', { name: 'Audio input', exact: true })).toHaveValue('usb')
  const connected = page.locator('header [data-state="connected"]')
  const connectedBox = (await connected.boundingBox())!
  await page.getByRole('button', { name: 'Start recording' }).click()
  await checkTransport(page)
  const active = page.getByRole('group', { name: 'Recording', exact: true })
  // A take takes the connection's place in the header (U156).
  await expect(connected).toHaveCount(0)
  const activeBox = (await active.boundingBox())!
  expect(activeBox.height).toBe(connectedBox.height)
  expect(activeBox.y).toBe(connectedBox.y)
  const tint = (group: Locator, tone: string) =>
    group.evaluate((node, tone) => {
      const css = getComputedStyle(node)
      const probe = document.createElement('span')
      node.append(probe)
      probe.style.color = `color-mix(in srgb, var(${tone}) 13%, var(--practice-surface))`
      const fill = getComputedStyle(probe).color
      probe.style.color = 'transparent'
      const border = getComputedStyle(probe).color
      probe.remove()
      return { fill: css.backgroundColor, border: css.borderTopColor, expectedFill: fill, expectedBorder: border }
    }, tone)
  const colors = await tint(active, '--danger')
  expect(colors.fill).toBe(colors.expectedFill)
  expect(colors.border).toBe(colors.expectedBorder)
  await page.clock.setFixedTime(new Date('2026-11-22T01:00:00Z'))
  // The whole piece.
  for (const keys of [[60, 48], [62], [64], [65], [43, 67, 71, 74], [48]]) await play(page, ...keys)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await page.screenshot({ path: info.outputPath('recording-active.png') })
  await stopRecording(page)

  await expectSaved(page)
  await expect(pill(page)).toContainText('Take saved')
  await expect(pill(page)).toContainText('%')
  await expect(page.getByRole('status').filter({ hasText: /^Take saved · [0-9.]+%$/ })).toHaveCount(1)
  const saved = await tint(pill(page), '--success')
  expect(saved.fill).toBe(saved.expectedFill)
  expect(saved.border).toBe(saved.expectedBorder)
  expect((await pill(page).boundingBox())!.y).toBe(connectedBox.y)
  await page.screenshot({ path: info.outputPath('recording-saved.png') })

  const score = (await pill(page).textContent())!.match(/[0-9.]+%/)![0]
  await pill(page).getByRole('button', { name: 'Recordings' }).click()
  let history = recordings(page)
  await expect(history.getByRole('button', { name: /Whole piece/, expanded: true })).toContainText(score)
  await expect(history.getByText('Best take', { exact: true })).toBeVisible()
  const link = history.getByRole('button', { name: 'Download MIDI and WAV (.zip)' })
  await expect(link).toBeVisible()
  await page.screenshot({ path: info.outputPath('recording-history.png') })
  const pendingDownload = page.waitForEvent('download')
  await link.click()
  const download = await pendingDownload
  const stem = '2026-11-22T00-04-56+0100 Two Hands'
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
  await expectSaved(page)

  // The second take starts from the menu in one tap, while the first one's pill still shows.
  const asked = await page.evaluate(() => window.__audio.asked.length)
  await tapRecord(page)
  await checkTransport(page)
  await expect(setupSheet(page)).toHaveCount(0)
  await expect(pill(page)).toHaveCount(0)
  expect(await page.evaluate((n) => window.__audio.asked.slice(n), asked)).toEqual(['usb'])
  await play(page, 120)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await stopRecording(page)
  await expectSaved(page)
  await pill(page).getByRole('button', { name: 'Recordings' }).click()
  history = recordings(page)
  await expect(history.getByRole('button', { name: /Whole piece/ })).toHaveCount(2)
  await expect(history.getByText('Best take', { exact: true })).toHaveCount(1)

  // The choice outlives a reload.
  await page.reload()
  await openSeededPracticeAgain(page)
  await tapRecord(page)
  await checkTransport(page)
  await play(page, 60)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await stopRecording(page)
  await expectSaved(page)
  await page.getByRole('button', { name: 'Back to Library', exact: true }).first().click()
  // The piece's options hold the same takes (U164). What is discarded can be undone from the sheet.
  await page.getByRole('button', { name: 'Options for Two Hands', exact: true }).click()
  await page.getByRole('button', { name: 'Recordings…', exact: true }).click()
  history = recordings(page)
  const takes = history.getByRole('listitem')
  // Not the one of a toast that is fading.
  const undo = history.getByRole('button', { name: 'Undo', exact: true, disabled: false })
  await expect(takes).toHaveCount(3)
  // Asked first, with the takes to keep.
  await history.getByRole('button', { name: 'Delete incomplete (2)' }).click()
  const ask = page.getByRole('dialog', { name: 'Delete incomplete recordings?' })
  await expect(ask.getByRole('button', { pressed: true })).toHaveCount(2)
  await ask.getByRole('button', { pressed: true }).first().click()
  await expect(ask.getByRole('button', { name: 'Delete 1 recording' })).toBeInViewport({ ratio: 1 })
  await ask.locator('[aria-pressed="false"]').click()
  await ask.getByRole('button', { name: 'Delete 2 recordings' }).click()
  await expect(ask).toHaveCount(0)
  await expect(takes).toHaveCount(1)
  await expect(takes).toContainText('Best take')
  await expect(history.getByText('2 recordings discarded')).toBeVisible()
  await undo.click()
  await expect(takes).toHaveCount(3)
  await takes.first().getByRole('button').click()
  await history.getByRole('button', { name: 'Delete recording' }).click()
  await expect(takes).toHaveCount(2)
  await expect(history.getByText('Recording discarded', { exact: true })).toBeVisible()
  // Deleted at once: closing the app does not bring it back.
  await page.reload()
  await page.getByRole('button', { name: 'Options for Two Hands', exact: true }).click()
  await page.getByRole('button', { name: 'Recordings…', exact: true }).click()
  await expect(takes).toHaveCount(2)
  await history.getByRole('button', { name: 'Clear all' }).click()
  await expect(history.getByText('No recordings yet.')).toBeVisible()
})

test('Discard, in the header and in the menu, drops the take and closes its input; Undo saves it', async ({ page }) => {
  await openWithRememberedInput(page)
  const undo = page.getByRole('button', { name: 'Undo', exact: true, disabled: false })
  const start = async () => {
    await tapRecord(page)
    await play(page, 60)
    await expect(page.getByRole('timer')).not.toHaveText('0:00')
  }
  await start()
  await page
    .getByRole('group', { name: 'Recording', exact: true })
    .getByRole('button', { name: 'Discard recording' })
    .click()
  await expectNoRecordControl(page)
  await expect.poll(() => page.evaluate(() => window.__audio.live())).toEqual([])
  await expect(page.getByText('Recording discarded')).toBeVisible()

  await start()
  const menu = await openFooterMenu(page)
  await menu.getByRole('button', { name: 'Discard recording' }).click()
  await expect(page.getByRole('dialog', { name: /^(Practice menu|Menu)$/ })).toHaveCount(0)
  await expectNoRecordControl(page)
  await undo.click()
  await expect(page.getByText('2 recordings restored')).toBeVisible()
  // Recordings opens from the menu, beside Record performance and apart from Progress.
  await (await openFooterMenu(page)).getByRole('button', { name: 'Recordings' }).click()
  await expect(recordings(page).getByRole('listitem')).toHaveCount(2)
})

/** After a reload Practice is on screen already (U98). */
async function openSeededPracticeAgain(page: Page) {
  await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Preparing the score/)).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('header [data-state="connected"]')).toBeVisible()
}

test('one tap shows that the input is opening, and Cancel leaves nothing behind', async ({ page }) => {
  await openWithRememberedInput(page)
  await holdOpening(page)
  await tapRecord(page)
  const opening = page.getByRole('group', { name: 'Opening audio input…' })
  await expect(opening).toBeVisible()
  await expect(opening).toHaveAttribute('aria-busy', 'true')
  await checkPlace(page, opening)
  await expect(setupSheet(page)).toHaveCount(0)
  // No other take can start meanwhile.
  const menu = await openFooterMenu(page)
  await expect(menu.getByRole('button', { name: 'Record performance' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await opening.getByRole('button', { name: 'Cancel' }).click()
  await expectNoRecordControl(page)
  await openGate(page)
  await expect.poll(() => page.evaluate(() => window.__audio.live())).toEqual([])
  await expectNoRecordControl(page)

  // Record again: the take starts by itself once the input is open.
  await holdOpening(page)
  await tapRecord(page)
  await expect(opening).toBeVisible()
  await openGate(page)
  await checkTransport(page)
  expect(await page.evaluate(() => window.__audio.live())).toEqual(['Fake Piano'])
  await stopFromMenu(page)
  await expectSaved(page)
})

test('a missing, replaced or refused input opens the setup sheet with the reason, never another source', async ({
  page,
}) => {
  await openWithRememberedInput(page)
  // Unplugged: only the tablet's own microphone is left.
  await page.evaluate(() => {
    window.__audio.inputs = [{ kind: 'audioinput', deviceId: 'internal', label: 'Tablet microphone' }]
  })
  await tapRecord(page)
  await expect(setupSheet(page)).toBeVisible()
  await expect(setupSheet(page).getByRole('alert')).toContainText('The selected audio input is not available.')
  await expect(page.getByRole('timer')).toHaveCount(0)
  expect(await page.evaluate(() => window.__audio.live())).toEqual([])
  await setupSheet(page).getByRole('button', { name: 'Close' }).click()

  await page.evaluate(() => {
    window.__audio.refuse = true
  })
  await tapRecord(page)
  await expect(setupSheet(page).getByRole('alert')).toContainText('Pianissimo is not allowed to use audio input.')
  expect(await page.evaluate(() => window.__audio.live())).toEqual([])

  // Allowed and plugged in again, under a new ID: the sheet offers the choice, as for a first take.
  await page.evaluate(() => {
    window.__audio.refuse = false
    window.__audio.inputs.push({ kind: 'audioinput', deviceId: 'usb-2', label: 'Fake Piano' })
  })
  await setupSheet(page).getByRole('button', { name: 'Enable audio input' }).click()
  const choice = page.getByRole('combobox', { name: 'Audio input', exact: true })
  await expect(choice).toHaveValue('usb-2')
  await choice.selectOption('internal')
  await page.getByRole('button', { name: 'Start recording' }).click()
  await checkTransport(page)
  await stopRecording(page)
  await expectSaved(page)

  // The take that started from the sheet decides what the next one uses.
  await tapRecord(page)
  await checkTransport(page)
  expect(await page.evaluate(() => window.__audio.live())).toEqual(['Tablet microphone'])
  await stopRecording(page)
  await expectSaved(page)
})

test('the input is found by its name when the browser has given out new IDs', async ({ page }) => {
  await openWithRememberedInput(page)
  await page.evaluate(() => {
    window.__audio.inputs[1]!.deviceId = 'usb-again'
  })
  await tapRecord(page)
  await checkTransport(page)
  expect(await page.evaluate(() => window.__audio.live())).toEqual(['Fake Piano'])
  await stopRecording(page)
  await expectSaved(page)
})

test('without a connected piano Record opens the setup sheet, whatever is remembered', async ({ page }) => {
  await installPianoAudio(page)
  await seedPiece(page, { recording: REMEMBERED })
  await openSeededPractice(page)
  await tapRecord(page)
  await expect(setupSheet(page)).toContainText('Connect and select a MIDI piano to record a performance.')
  expect(await page.evaluate(() => window.__audio.asked)).toEqual([])
})

test('the pill plays the take, closes, and goes when the score starts playing', async ({ page }) => {
  await openWithRememberedInput(page)
  const take = async () => {
    await tapRecord(page)
    await play(page, 60)
    await expect(page.getByRole('timer')).not.toHaveText('0:00')
    await stopRecording(page)
    await expectSaved(page)
  }
  await take()
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  const pause = pill(page).getByRole('button', { name: 'Pause' })
  await expect(pause).toBeVisible()
  await expect.poll(async () => (await player(page))[0]!.at).toBeGreaterThan(0.1)
  await pause.click()
  await expect(pill(page).getByRole('button', { name: 'Listen to recording' })).toBeVisible()
  expect((await player(page))[0]!.paused).toBe(true)
  // To its end, and Listen is offered again.
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  await expect(pill(page).getByRole('button', { name: 'Listen to recording' })).toBeVisible({ timeout: 15_000 })

  // Recordings has its own player: the pill's pauses, and it is still there when the list closes.
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  await pill(page).getByRole('button', { name: 'Recordings' }).click()
  await expect(recordings(page).getByRole('button', { name: /Whole piece/, expanded: true })).toBeVisible()
  expect((await player(page))[0]!.paused).toBe(true)
  await recordings(page).getByRole('button', { name: 'Close' }).click()
  await checkPill(page)

  // Close, while it plays: silence, and nothing left of it.
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  await pill(page).getByRole('button', { name: 'Close' }).click()
  await expectNoRecordControl(page)
  expect((await player(page))[0]).toMatchObject({ paused: true, src: '' })

  // Another take starts: the pill of the last one gives way, with its sound.
  await take()
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  await expect(pill(page).getByRole('button', { name: 'Pause' })).toBeVisible()
  await take()
  expect((await player(page))[1]).toMatchObject({ paused: true, src: '' })

  // The score starts playing.
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  await expect(pill(page).getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expectNoRecordControl(page)
  expect((await player(page))[2]).toMatchObject({ paused: true, src: '' })

  // Leaving the screen.
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await take()
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  await expect(pill(page).getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to Library', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()
  expect((await player(page))[3]).toMatchObject({ paused: true, src: '' })
})

test('a take deleted in Recordings takes its pill with it', async ({ page }) => {
  await openWithRememberedInput(page)
  await tapRecord(page)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await stopRecording(page)
  await expectSaved(page)
  await pill(page).getByRole('button', { name: 'Recordings' }).click()
  await recordings(page).getByRole('button', { name: 'Delete recording' }).click()
  await expect(recordings(page).getByText('No recordings yet.')).toBeVisible()
  // Its sheet mounts open: the toast is there too.
  await expect(recordings(page).getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await recordings(page).getByRole('button', { name: 'Close' }).click()
  await expectNoRecordControl(page)
})

test('a take that cannot be saved opens Recordings, which keeps it in memory', async ({ page }) => {
  await openWithRememberedInput(page)
  await tapRecord(page)
  await play(page, 60)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    ;(window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = put
    }
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'recordingBlocks') throw new DOMException('full', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await stopRecording(page)
  await expect(recordings(page)).toContainText('This take is in memory.')
  await expect(page.getByText('Recording could not be saved.')).toBeVisible()
  await expect(pill(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.__audio.live())).toEqual([])
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut())
  await recordings(page).getByRole('button', { name: 'Retry saving' }).click()
  await expect(recordings(page).getByRole('button', { name: /Whole piece/ })).toHaveCount(1)
  await recordings(page).getByRole('button', { name: 'Close' }).click()
  await expectNoRecordControl(page)
})

test('the keyboard goes from Stop to Listen', async ({ page }) => {
  await openWithRememberedInput(page)
  await tapRecord(page)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await page.getByRole('button', { name: 'Stop recording', exact: true }).focus()
  await page.keyboard.press('Enter')
  await checkPill(page)
  await expect(pill(page).getByRole('button', { name: 'Listen to recording' })).toBeFocused()
})

test('a phone can record in Listen and keep both files when the page is interrupted', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await installFakeMidi(page)
  await installPianoAudio(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await chooseMode(page, 'Listen')
  await recordFromPracticeMenu(page)
  await page.getByRole('button', { name: 'Enable audio input' }).click()
  await expect(page.getByRole('combobox', { name: 'Audio input', exact: true })).toHaveValue('usb')
  await page.screenshot({ path: info.outputPath('recording-phone.png') })
  await page.getByRole('button', { name: 'Start recording' }).click()
  await checkTransport(page)
  await expect(page.getByRole('timer')).not.toHaveText('0:00')
  await page.screenshot({ path: info.outputPath('recording-phone-active.png') })
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-sideways', 'true')
  await checkTransport(page)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(page.locator('[data-activity]')).not.toHaveAttribute('data-compact', 'true')
  await checkTransport(page)
  await play(page, 60)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await checkPill(page)
  await expect(pill(page)).toContainText('Interrupted')
  await expect(page.getByRole('status').filter({ hasText: /^Take saved · Interrupted · / })).toHaveCount(1)
  await pill(page).getByRole('button', { name: 'Recordings' }).click()
  const history = recordings(page)
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
  await stopRecording(page)
  await checkPill(page)
  await pill(page).getByRole('button', { name: 'Recordings' }).click()
  // Only its first notes were played.
  await expect(recordings(page).getByText('Incomplete', { exact: true })).toBeVisible()
})

test('a phone keeps the pill in its footer upright and in its bar on its side, and the sound through the turn', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openWithRememberedInput(page)
  await holdOpening(page)
  await tapRecord(page)
  const opening = page.getByRole('group', { name: 'Opening audio input…' })
  await expect(page.locator('footer').filter({ has: opening })).toHaveCount(1)
  await openGate(page)
  await checkTransport(page)
  await play(page, 60)
  // Long enough to be still playing after the turns below.
  await expect(page.getByRole('timer')).toHaveText('0:05', { timeout: 15_000 })
  await stopFromMenu(page)
  await expectSaved(page)
  await expect(page.locator('footer').filter({ has: pill(page) })).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('recording-saved-phone.png') })
  await pill(page).getByRole('button', { name: 'Listen to recording' }).click()
  await page.setViewportSize({ width: 852, height: 393 })
  await expect(page.getByTestId('practice-bar').filter({ has: pill(page) })).toHaveCount(1)
  await checkPill(page)
  await expect(pill(page).getByRole('button', { name: 'Pause' })).toBeVisible()
  expect(await player(page)).toHaveLength(1)
  expect((await player(page))[0]!.paused).toBe(false)
  await expect(page.getByTestId('practice-bar').getByRole('slider', { name: 'Piece overview' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('recording-saved-phone-landscape.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('footer').filter({ has: pill(page) })).toHaveCount(1)
  await checkPill(page)
  await pill(page).getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('footer')).toBeHidden()
})

test('a take stopped in focus mode shows its pill on a phone on its side', async ({ page }) => {
  await page.setViewportSize({ width: 852, height: 393 })
  await openWithRememberedInput(page)
  await tapRecord(page)
  await checkTransport(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await play(page, 60, 48)
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-recede', 'true')
  await stopRecording(page)
  await checkPill(page)
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-recede', 'true')
  await pill(page).getByRole('button', { name: 'Close' }).click()
  await expect(pill(page)).toHaveCount(0)
})

test('Settings names the remembered input, and Choose again brings the setup sheet back', async ({ page }) => {
  await openWithRememberedInput(page)
  const settings = page.locator('header').getByRole('button', { name: 'Settings' })
  await settings.click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('tab', { name: 'Piano and sound' }).click()
  const input = dialog.getByRole('group', { name: 'Audio input' })
  await expect(input).toContainText('Fake Piano')
  await input.getByRole('button', { name: 'Choose again' }).click()
  await expect(input).toHaveCount(0)
  await expect(dialog.getByText('You choose the audio input the next time you record.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await tapRecord(page)
  await expect(setupSheet(page)).toBeVisible()
  expect(await page.evaluate(() => window.__audio.asked)).toEqual([])
})

const CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'en-US': en,
  'fr-FR': fr,
  'fil-PH': fil,
}
const in_ = (language: string, source: string): string => {
  const id = Object.keys(en).find((key) => (en as Record<string, string>)[key] === source)
  return CATALOGS[language]![id ?? ''] ?? source
}

/**
 * Every control and the title's words, as boxes: none meets another or leaves the header, and the
 * title keeps some words. The mode is there too (U141): all four, centered, or the one button.
 */
async function expectTidyHeader(page: Page, name: string) {
  const header = page.getByTestId('practice-header')
  const group = header.getByRole('group', { name, exact: true })
  await expect(group).toBeVisible()
  const boxes = await header.evaluate((node) => {
    const control = node.querySelector('[data-recording-control] [role="group"]')!
    const box = (el: Element) => {
      const { left, right, top, bottom } = el.getBoundingClientRect()
      return { left, right, top, bottom }
    }
    const chip = node.querySelector('[data-state]')
    const named: Record<string, Element> = {
      back: node.querySelector('button')!,
      title: node.querySelector('h1')!,
      mode:
        node.querySelector('[data-testid="practice-modes"] > button') ??
        node.querySelector('[data-testid="practice-modes"] [role="radiogroup"]')!,
      take: control,
      // Not while a take runs (U156).
      ...(chip ? { chip } : {}),
      settings: node.lastElementChild!.lastElementChild!,
    }
    return {
      header: box(node),
      modes: node.dataset['modes'],
      modeNames: [...node.querySelectorAll('[data-testid="practice-modes"] > button > span')].map(
        (el) => el.scrollWidth <= el.clientWidth,
      ),
      named: Object.entries(named).map(([key, el]) => ({ key, ...box(el) })),
      /** Inside the pill: its words, its score, its controls. */
      parts: [...control.querySelectorAll(':scope > :first-child > *, button')].map((el) => box(el)),
    }
  })
  const row = [...boxes.named].sort((a, b) => a.left - b.left)
  const expected = ['back', 'title', 'mode', 'take', 'chip', 'settings']
  const saved = boxes.named.some((b) => b.key === 'chip')
  expect(row.map((b) => b.key)).toEqual(saved ? expected : expected.filter((key) => key !== 'chip'))
  const at = (key: string) => boxes.named.find((b) => b.key === key)!
  expect(at('title').right - at('title').left).toBeGreaterThan(64)
  // The one button names its mode in full, whatever the title and the take need.
  expect(boxes.modeNames).toEqual(boxes.modes === 'one' ? [true] : [])
  if (boxes.modes === 'all') {
    const middle = (b: { left: number; right: number }) => (b.left + b.right) / 2
    expect(Math.abs(middle(at('mode')) - middle(boxes.header))).toBeLessThan(1)
  }
  for (const [i, b] of row.entries()) {
    expect(b.left).toBeGreaterThanOrEqual(boxes.header.left)
    expect(b.right).toBeLessThanOrEqual(boxes.header.right)
    expect(b.bottom).toBeLessThanOrEqual(boxes.header.bottom)
    if (i > 0) expect(b.left, `${row[i - 1]!.key} meets ${b.key}`).toBeGreaterThanOrEqual(row[i - 1]!.right)
  }
  const take = boxes.named.find((b) => b.key === 'take')!
  for (const [i, part] of boxes.parts.entries()) {
    expect(part.left).toBeGreaterThanOrEqual(i > 0 ? boxes.parts[i - 1]!.right - 0.1 : take.left)
    expect(part.right).toBeLessThanOrEqual(take.right)
  }
  const overview = (await page.locator('[data-testid="practice-header"] + *').boundingBox())!
  expect(boxes.header.bottom).toBeLessThanOrEqual(overview.y)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width)
  for (const button of await group.getByRole('button').all()) await expect(button).toBeInViewport({ ratio: 1 })
  return boxes.modes
}

for (const language of ['en-US', 'fr-FR', 'fil-PH'])
  for (const viewport of [
    { width: 744, height: 1133 },
    { width: 834, height: 1194 },
    { width: 1194, height: 834 },
  ])
    test(`the header holds the title, a take and the piano's pill at ${viewport.width} px in ${language}`, async ({
      page,
    }) => {
      const say = (source: string) => in_(language, source)
      await page.setViewportSize(viewport)
      await installFakeMidi(page)
      await installPianoAudio(page)
      await seedPiece(page, {
        recording: REMEMBERED,
        view: { ...DEFAULT_SETTINGS.view, language: language as AppSettings['view']['language'] },
      })
      await page.goto(`./#/practice/${PIECE_ID}`)
      await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('header [data-state="connected"]')).toBeVisible()
      const header = page.getByTestId('practice-header')
      const modesBefore = await header.getAttribute('data-modes')
      const take = async () => {
        await holdOpening(page)
        await page
          .locator('footer')
          .getByRole('button', { name: say('Menu'), exact: true })
          .click()
        await page.getByRole('button', { name: say('Record performance') }).click()
        // A narrow header has no room for the four modes beside a take. It goes to the one button at
        // most once, and that stays where it is until the pill is gone.
        const shown = [await expectTidyHeader(page, say('Opening audio input…'))]
        await openGate(page)
        shown.push(await expectTidyHeader(page, say('Recording')))
        await header.getByRole('button', { name: say('Stop recording'), exact: true }).click()
        shown.push(await expectTidyHeader(page, say('Take saved')))
        expect(shown.join()).not.toContain('one,all')
        if (viewport.width < 1000) expect(shown[0]).toBe('one')
      }
      await take()
      const mode = header.getByRole('button', { name: new RegExp(`^${say('Mode')}`) })
      if (viewport.width < 1000) {
        await mode.click()
        const sheet = page.getByRole('dialog', { name: say('Mode'), exact: true })
        await sheet.getByRole('radio', { name: say('Keep time'), exact: true }).click()
        await expect(sheet).toHaveCount(0)
        await expect(page.locator('[data-activity]')).toHaveAttribute('data-mode', 'time')
        await expectTidyHeader(page, say('Take saved'))
      }
      await expect(page.getByRole('group', { name: say('Take saved') })).toContainText(say('Take saved'))
      // A long title gives up words, never a control.
      await page.locator('h1').evaluate((h1) => {
        h1.textContent = 'Invention No. 13 in A minor, arranged for two hands and a patient left one'
      })
      await expectTidyHeader(page, say('Take saved'))
      // The pill's words say something or give way entirely.
      const shown = await page
        .getByRole('group', { name: say('Take saved') })
        .getByText(say('Take saved'), { exact: true })
        .evaluate((el) => ({ width: el.clientWidth, full: el.scrollWidth, chars: el.textContent!.length }))
      if (shown.width > 0 && shown.width < shown.full)
        expect(shown.width).toBeGreaterThanOrEqual((shown.full / shown.chars) * 6)
      await take()
      // The pill closed, the header is as it was.
      await page
        .getByRole('group', { name: say('Take saved') })
        .getByRole('button', { name: say('Close') })
        .click()
      await expect(header).toHaveAttribute('data-modes', modesBefore!)
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
      await expect(header.getByRole('button', { name: /MIDI status/ })).toHaveCount(0)
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
    await checkPill(page)
    await pill(page).getByRole('button', { name: 'Recordings' }).click()
    await expect(recordings(page).getByRole('button', { name: 'Download MIDI and WAV (.zip)' })).toBeVisible()
  })
}
