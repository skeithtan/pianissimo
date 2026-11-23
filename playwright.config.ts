import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

/**
 * Browser workflows (spec "Verification": Playwright Chromium and WebKit).
 *  - The app is tested against the production build served under the Pages path.
 *  - Renderer specs (tests/e2e/render*.spec.ts) use the harness page in tests/harness, served by
 *    its own Vite dev server so it never enters the production bundle.
 * Chromium uses the cloud container's browser when present, unless PW_CHROMIUM_PATH says
 * otherwise ('' = Playwright's own). APP_PORT moves the preview server (parallel worktrees).
 * For one change use `npm run check -- <spec>`; the whole suite is CI's job (DECISIONS D19).
 */
const containerChromium = '/opt/pw-browsers/chromium'
const chromiumPath = process.env['PW_CHROMIUM_PATH'] ?? (existsSync(containerChromium) ? containerChromium : '')
const appPort = Number(process.env['APP_PORT'] ?? 4173)
const harnessPort = Number(process.env['HARNESS_PORT'] ?? 4174)

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${appPort}/pianissimo/`,
    headless: true,
    // A stuck step fails by itself, instead of waiting out the whole test.
    actionTimeout: 30_000,
    // Recording every step slows every test; locally, ask for it with --trace on.
    trace: process.env['CI'] ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--mute-audio'], ...(chromiumPath ? { executablePath: chromiumPath } : {}) },
      },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: [
    {
      command: `npx vite build --logLevel warn && npx vite preview --port ${appPort} --strictPort`,
      url: `http://localhost:${appPort}/pianissimo/`,
      reuseExistingServer: !process.env['CI'],
      timeout: 240_000,
    },
    {
      command: 'npx vite --config tests/harness/vite.config.ts',
      url: `http://localhost:${harnessPort}/`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: { HARNESS_PORT: String(harnessPort) },
    },
  ],
})
