/**
 * Practice workflow helpers: a fake Web MIDI injected before the app boots (headless browsers
 * have no Web MIDI), and seeding IndexedDB with an imported fixture, a remembered route and
 * settings. Modeled on src/core/midi/fakeWebMidi.ts.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import { newPieceRecord } from '../../src/core/storage/records'
import { INITIAL_LIBRARY_KEY, LIBRARY_EXPANSION_KEY } from '../../src/core/storage/schema'
import { importFixture } from '../unit/import/fixtures'

/** Screenshots go outside the repository. */
export const SHOT_DIR = process.env['PW_SHOT_DIR'] ?? join(tmpdir(), 'pianissimo-practice-shots')
mkdirSync(SHOT_DIR, { recursive: true })

declare global {
  interface Window {
    __midi: {
      on(note: number, velocity?: number): void
      off(note: number): void
      sent: number[][]
    }
  }
}

/** Installs `navigator.requestMIDIAccess` (granted) with one input and one output. */
export async function installFakeMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners: Record<string, unknown> = {}
    const input = {
      id: 'fake-in',
      name: 'Fake Piano',
      manufacturer: 'Test',
      type: 'input',
      state: 'connected',
      connection: 'open',
      onmidimessage: null as null | ((ev: { data: Uint8Array; timeStamp: number }) => void),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      open: () => Promise.resolve(input),
    }
    const sent: number[][] = []
    const output = {
      id: 'fake-out',
      name: 'Fake Piano',
      manufacturer: 'Test',
      type: 'output',
      state: 'connected',
      connection: 'open',
      send: (data: number[]) => void sent.push([...data]),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      open: () => Promise.resolve(output),
    }
    const access = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map([[output.id, output]]),
      onstatechange: null,
      sysexEnabled: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    void listeners
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: () => Promise.resolve(access),
    })
    const perms = navigator.permissions
    if (perms) {
      const query = perms.query.bind(perms)
      Object.defineProperty(perms, 'query', {
        configurable: true,
        value: (d: { name: string }) =>
          d.name === 'midi' ? Promise.resolve({ state: 'granted' }) : query(d as PermissionDescriptor),
      })
    }
    const emit = (data: number[]) =>
      input.onmidimessage?.({ data: Uint8Array.from(data), timeStamp: performance.now() })
    window.__midi = {
      on: (note, velocity = 80) => emit([0x90, note, velocity]),
      off: (note) => emit([0x80, note, 0]),
      sent,
    }
  })
}

export const PIECE_ID = 'e2e-two-hands'

/** The stored settings still hold what was seeded (each seeded group, field by field). */
async function keptSettings(page: Page, seeded: Partial<AppSettings>): Promise<boolean> {
  const stored = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('pianissimo')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const settings = await new Promise<Record<string, Record<string, unknown>>>((resolve, reject) => {
      const req = db.transaction('settings').objectStore('settings').get('app')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return settings
  })
  return Object.entries(seeded).every(([group, fields]) =>
    Object.entries(fields as object).every(
      ([key, value]) => JSON.stringify(stored[group]?.[key]) === JSON.stringify(value),
    ),
  )
}

/**
 * Seeds the app database (created by the app on first boot) and reloads. The app saves the route it
 * connects by itself, debounced and as the page goes, and that save can land after the seed: then
 * the seed is written again.
 */
export async function seedPiece(page: Page, settingsPatch: Partial<AppSettings> = {}): Promise<void> {
  for (let tries = 0; tries < 3; tries++) {
    const { route } = await seedOnce(page, settingsPatch)
    if (await keptSettings(page, { route, ...settingsPatch })) return
  }
  throw new Error('The seeded settings were overwritten three times')
}

async function seedOnce(page: Page, settingsPatch: Partial<AppSettings>): Promise<AppSettings> {
  const built = await importFixture('two-hands.musicxml')
  const piece = newPieceRecord(built.package, { id: PIECE_ID, now: Date.now() })
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    route: {
      ...DEFAULT_SETTINGS.route,
      inputId: 'fake-in',
      inputName: 'Fake Piano',
      outputId: 'fake-out',
      outputName: 'Fake Piano',
      outputVerified: true,
      echo: 'none',
    },
    ...settingsPatch,
  }
  await page.goto('./')
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'pianissimo')), {
      timeout: 15_000,
    })
    .toBe(true)
  await page.evaluate(
    async ({ piece, pkg, settings, libraryMarkers }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('pianissimo')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['pieces', 'packages', 'settings', 'libraryState'], 'readwrite')
        // The fixture replaces the library, including its installed status, in one transaction.
        for (const key of libraryMarkers) tx.objectStore('libraryState').put('complete', key)
        tx.objectStore('pieces').clear()
        tx.objectStore('pieces').put(piece)
        tx.objectStore('packages').put(pkg, (pkg as { model: { scoreVersionId: string } }).model.scoreVersionId)
        tx.objectStore('settings').put(settings, 'app')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    {
      libraryMarkers: [INITIAL_LIBRARY_KEY, LIBRARY_EXPANSION_KEY],
      piece: JSON.parse(JSON.stringify(piece)),
      pkg: JSON.parse(JSON.stringify(built.package)),
      settings: JSON.parse(JSON.stringify(settings)),
    },
  )
  await page.reload()
  return settings
}

export type ModeName = 'Listen' | 'Wait' | 'Keep time' | 'Follow'

/** The Practice screen in this mode (`data-mode` of its root). */
export async function expectMode(page: Page, name: ModeName): Promise<void> {
  const mode = { Listen: 'listen', Wait: 'wait', 'Keep time': 'time', Follow: 'follow' }[name]
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-mode', mode)
}

/**
 * Chooses the mode (DECISIONS U141): in the header's control, or from the sheet of the one button
 * that names it (a phone, or a header with no room for the four).
 */
export async function chooseMode(page: Page, name: ModeName): Promise<void> {
  const button = page.getByRole('button', { name: /^Mode: / })
  if (await button.count()) {
    const sheet = page.getByRole('dialog', { name: 'Mode', exact: true })
    await button.click()
    await sheet.getByRole('radio', { name, exact: true }).click()
    await expect(sheet).toHaveCount(0)
  } else {
    await page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name, exact: true }).click()
  }
  await expectMode(page, name)
}

/**
 * Opens the Practice footer menu (DECISIONS U76), the popover that holds the mode's rows, unless it
 * is already open, and returns it. On a phone-size screen (U80) the
 * same rows (plus Speed) are in the menu sheet opened from the top bar.
 */
export async function openFooterMenu(page: Page): Promise<Locator> {
  const bar = page.getByTestId('practice-bar')
  if (await bar.count()) {
    const menu = page.getByRole('dialog', { name: 'Menu' })
    if (!(await menu.isVisible())) await bar.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(menu).toBeVisible()
    return menu
  }
  const button = page.locator('footer').getByRole('button', { name: 'Menu', exact: true })
  const menu = page.getByRole('dialog', { name: 'Practice menu' })
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  await expect(menu).toBeVisible()
  return menu
}

/** Turns the keyboard guide on or off with the Show keys switch in the footer menu, then closes it. */
export async function setShowKeys(page: Page, on = true): Promise<void> {
  const menu = await openFooterMenu(page)
  const keys = menu.getByRole('switch', { name: 'Show keys' })
  if ((await keys.isChecked()) !== on) await keys.click()
  await expect(keys).toBeChecked({ checked: on })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
}

/** From the Library to the Practice view of the seeded piece. */
export async function openSeededPractice(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(?:Practice|Continue practice) Two Hands$/ }).click()
  await expect(page.locator('h1', { hasText: 'Two Hands' })).toBeVisible()
  await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Preparing the score/)).toHaveCount(0, { timeout: 60_000 })
}

/**
 * Repeat mode over the whole two-bar Two Hands piece: the footer's Repeat opens it on the
 * cursor's bar (or the remembered loop), then Loop end ▶ extends it to bar 2 (DECISIONS U10,
 * U14). Start is then a scored attempt.
 */
export async function loopWholePiece(page: Page): Promise<void> {
  const panel = page.getByTestId('repeat-controls')
  // Repeat mode opens from the cursor's repeat button (U17); a restored loop may already be open.
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Repeat from here' }).click()
  await expect(panel).toBeVisible()
  const end = panel.getByRole('group', { name: 'Loop end' })
  if (!(await end.textContent())?.includes('Bar 2'))
    await end.getByRole('button', { name: 'Move loop end one bar later' }).click()
  await expect(panel.getByRole('group', { name: 'Loop start' })).toContainText('Bar 1')
  await expect(end).toContainText('Bar 2')
}

export async function play(page: Page, ...notes: number[]): Promise<void> {
  await page.evaluate((ns) => {
    for (const n of ns) window.__midi.on(n)
    for (const n of ns) window.__midi.off(n)
  }, notes)
}

let pitches: Promise<readonly number[]> | undefined

/** Wait for the requested, unanswered notes to reach the stationary cursor and stop there. */
export async function waitForOnset(page: Page, ...notes: number[]): Promise<void> {
  pitches ??= importFixture('two-hands.musicxml').then((built) => built.package.model.notes.map((n) => n.midi))
  await page.evaluate(
    ({ notes, pitches }) =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 15_000
        let stableSince = performance.now()
        let previous = ''
        const check = () => {
          const now = performance.now()
          const cursor = document.querySelector('.pn-cursor-bar')?.getBoundingClientRect()
          const targets = [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')].map((el) => ({
            pitches: (el.getAttribute('data-n') ?? '').split(' ').map((n) => pitches[Number(n)]),
            box: el.getBoundingClientRect(),
          }))
          const wanted = notes.map((n) => targets.find((t) => t.pitches.includes(n)))
          const atCursor =
            cursor &&
            wanted.every(Boolean) &&
            wanted.some((t) => t && t.box.left <= cursor.right && t.box.right >= cursor.left)
          const position = atCursor ? wanted.map((t) => t!.box.x.toFixed(1)).join('|') : ''
          if (!position || position !== previous) stableSince = now
          previous = position
          // A moving note can overlap the bar before its musical time. Two quiet frames are
          // insufficient at a low frame rate; require 80 ms of unchanged position at the gate.
          if (position && now - stableSince >= 80) return resolve()
          if (now >= deadline) return reject(new Error(`Notes ${notes.join(', ')} did not reach the cursor`))
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
    { notes, pitches: await pitches },
  )
}

/** Play a correct group only when the timed practice transport has reached it. */
export async function playWhenDue(page: Page, ...notes: number[]): Promise<void> {
  await waitForOnset(page, ...notes)
  await play(page, ...notes)
}

/** One timed key press for `playAtScheduled`: the pitches, struck together `atMs` after the anchor. */
export interface TimedGroup {
  readonly notes: readonly number[]
  readonly atMs: number
}

/**
 * Keep time: waits for the count-in (`data-testid="count-in"`) to show and then go away, and
 * returns the beats it displayed in order. The attempt's music starts the moment it goes (the
 * session ends the count-in and starts the transport at the same instant), so each group is
 * struck `atMs` after that, measured from the page's own clock. Resolves after the last press.
 */
export async function playAfterCountIn(page: Page, groups: readonly TimedGroup[]): Promise<number[]> {
  return page.evaluate(
    (groups) =>
      new Promise<number[]>((resolve, reject) => {
        const beats: number[] = []
        const deadline = performance.now() + 30_000
        const read = () => {
          const el = document.querySelector('[data-testid="count-in"]')
          return el ? Number(/(\d+)/.exec(el.getAttribute('aria-label') ?? '')?.[1]) : null
        }
        let shown = false
        const observer = new MutationObserver(() => {
          const beat = read()
          if (beat !== null) {
            shown = true
            if (beats[beats.length - 1] !== beat) beats.push(beat)
            return
          }
          if (!shown) return
          observer.disconnect()
          const anchor = performance.now()
          let last = 0
          for (const g of groups) {
            last = Math.max(last, g.atMs)
            setTimeout(
              () => {
                for (const n of g.notes) window.__midi.on(n)
                for (const n of g.notes) window.__midi.off(n)
              },
              Math.max(0, g.atMs - (performance.now() - anchor)),
            )
          }
          setTimeout(() => {
            clearInterval(guard)
            resolve(beats)
          }, last + 100)
        })
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
        const first = read()
        if (first !== null) {
          shown = true
          beats.push(first)
        }
        const guard = setInterval(() => {
          if (performance.now() > deadline) {
            clearInterval(guard)
            observer.disconnect()
            reject(new Error('The count-in never finished'))
          }
        }, 500)
      }),
    groups,
  )
}
