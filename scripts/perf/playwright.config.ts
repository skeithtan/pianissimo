import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

/**
 * Performance measurements (DECISIONS D10): the perf build (production build + render counter,
 * see vite.config.ts here) served by `vite preview`. Chromium runs with CDP CPU throttling as the
 * stand-in for the reference tablet (PERF_CPU, default 4×); WebKit runs unthrottled for relative
 * numbers. Viewport: a 12.9-inch tablet in landscape at 2× (PERF_VIEWPORT=1194x834 for an 11-inch one).
 *
 *   npm run perf                       # both browsers
 *   npm run perf -- --project=chromium # one browser
 *   PERF_LABEL=after npm run perf      # results in $TMPDIR/pianissimo-perf/<label>-<browser>.json
 */
// Same rule as the root playwright.config.ts: the cloud container's Chromium when present, unless
// PW_CHROMIUM_PATH says otherwise ('' = Playwright's own, selected by channel below).
const containerChromium = '/opt/pw-browsers/chromium'
const chromiumPath = process.env['PW_CHROMIUM_PATH'] ?? (existsSync(containerChromium) ? containerChromium : '')
const port = Number(process.env['PERF_PORT'] ?? 4185)
const [vw, vh] = (process.env['PERF_VIEWPORT'] ?? '1366x1024').split('x').map(Number) as [number, number]

export default defineConfig({
  testDir: '.',
  testMatch: 'perf.spec.ts',
  outputDir: join(tmpdir(), 'pianissimo-perf', 'test-results'),
  timeout: 20 * 60_000,
  // Long waits in the spec pass their own timeouts; anything else that is stale fails fast.
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}/pianissimo/`,
    viewport: { width: vw, height: vh },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    actionTimeout: 30_000,
  },
  projects: [
    // The full Chromium build in new headless mode (not the headless shell): real compositor frames.
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : { channel: 'chromium' as const }),
      },
    },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `npx vite build -c scripts/perf/vite.config.ts && npx vite preview -c scripts/perf/vite.config.ts --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: `http://localhost:${port}/pianissimo/`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
  },
})
