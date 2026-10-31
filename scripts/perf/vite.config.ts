import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig, type ConfigEnv, type Plugin, type UserConfig } from 'vite'
import appConfig from '../../vite.config'

/**
 * Perf build: the production build (same base, target, minifier) plus a Preact render counter
 * (probe.ts, prepended to the entry) and kept function names so renders are counted by component.
 * Output goes outside the repository; `vite preview -c scripts/perf/vite.config.ts` serves it.
 */
export const PERF_DIST = process.env['PERF_DIST'] ?? join(tmpdir(), 'pianissimo-perf', 'dist')
const probe = fileURLToPath(new URL('./probe.ts', import.meta.url))
const root = fileURLToPath(new URL('../..', import.meta.url))

function renderProbe(): Plugin {
  return {
    name: 'pianissimo-perf-probe',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/src/main.tsx')) return null
      return { code: `import ${JSON.stringify(probe)}\n${code}`, map: null }
    },
  }
}

export default (env: ConfigEnv): UserConfig => {
  const base = typeof appConfig === 'function' ? appConfig(env) : appConfig
  return mergeConfig(base as UserConfig, {
    root,
    plugins: [renderProbe()],
    build: {
      outDir: PERF_DIST,
      emptyOutDir: true,
      // PERF_MINIFY=0: readable function names in CPU profiles (investigation only).
      ...(process.env['PERF_MINIFY'] === '0' ? { minify: false } : {}),
      rolldownOptions: { output: { keepNames: true } },
    },
  })
}
