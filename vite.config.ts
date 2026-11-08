import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'
import { pwa } from './scripts/pwa.ts'

// GitHub Pages project path. Override with PAGES_BASE=/other/ for a different repository name.
const pagesBase = process.env['PAGES_BASE'] ?? '/pianissimo/'

// `vite preview` serves the build, so it needs the same base (Playwright runs against it).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview === true ? pagesBase : '/',
  // pwa(): after a production build, writes dist/sw.js and stamps index.html (DECISIONS U84).
  plugins: [preact(), pwa()],
  worker: { format: 'es' },
  build: {
    // Syntax baseline from the spec (Safari 16.4, Chrome 111); never ship esnext. The runtime
    // target is newer: current iPadOS WebKit on the reference tablet (an older iPad) and current
    // desktop Chrome (DECISIONS D10). Never lower this for "older iPads": optimize runtime work instead.
    target: ['safari16.4', 'chrome111'],
    sourcemap: true,
    manifest: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 1600,
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
    environment: 'node',
  },
  server: {
    allowedHosts: true,
  },
}))
