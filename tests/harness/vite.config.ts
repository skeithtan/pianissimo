import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Renderer harness (WP6): a standalone dev server rooted at tests/harness, outside the app build.
 * Playwright starts it as a second web server for tests/e2e/render*.spec.ts.
 */
const root = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root,
  base: '/',
  // The app's public folder: the strip's label font is served from /fonts/.
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  server: {
    port: Number(process.env['HARNESS_PORT'] ?? 4174),
    strictPort: true,
    fs: { allow: [repo] },
  },
  optimizeDeps: { include: ['opensheetmusicdisplay'] },
  build: { target: ['safari16.4', 'chrome111'] },
})
