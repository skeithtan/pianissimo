/** The build-time worker generator (scripts/pwa.ts, DECISIONS U84) over a fake build output. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { integrityOf, isPrecached, writeServiceWorker } from '../../scripts/pwa'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HTML = '<!doctype html>\n<html>\n  <head>\n    <title>Pianissimo</title>\n  </head>\n</html>\n'
const dirs: string[] = []

function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pn-pwa-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, '.vite'))
  mkdirSync(join(dir, 'samples/salamander'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), HTML)
  writeFileSync(join(dir, 'assets/index-abc.js'), 'console.log(1)\n')
  writeFileSync(join(dir, 'assets/index-abc.js.map'), '{}')
  writeFileSync(join(dir, '.vite/manifest.json'), '{}')
  writeFileSync(join(dir, 'samples/salamander/C4.mp3'), 'mp3')
  return dir
}

/** The constants the generator prepends to the worker. */
function readWorker(dir: string): { build: string; assets: [string, string][]; code: string } {
  const code = readFileSync(join(dir, 'sw.js'), 'utf8')
  const build = JSON.parse(/^const BUILD = (.+)$/m.exec(code)![1]!) as string
  const assets = JSON.parse(/^const ASSETS = (.+)$/m.exec(code)![1]!) as [string, string][]
  return { build, assets, code }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('writeServiceWorker', () => {
  it('precaches every file but source maps, the Vite manifest and itself, with their hashes', async () => {
    const dir = fakeBuild()
    const report = await writeServiceWorker(ROOT, dir)
    const { build, assets, code } = readWorker(dir)
    expect(build).toBe(report.build)
    expect(assets.map(([path]) => path)).toEqual(['assets/index-abc.js', 'index.html', 'samples/salamander/C4.mp3'])
    expect(assets[0]![1]).toBe(integrityOf(Buffer.from('console.log(1)\n')))
    // The stamped page is precached as written, stamp included.
    const html = readFileSync(join(dir, 'index.html'), 'utf8')
    expect(html).toContain(`<meta name="pianissimo-build" content="${build}">\n  </head>`)
    expect(assets[1]![1]).toBe(integrityOf(Buffer.from(html)))
    // A classic script: the types and the module marker are gone.
    expect(code).not.toMatch(/^\s*(import|export)\b/m)
    expect(code).not.toContain('declare const')
    expect(code).toContain('addEventListener("fetch"')
  })

  it('is stable when run again, and any changed file gives a new build', async () => {
    const dir = fakeBuild()
    const first = await writeServiceWorker(ROOT, dir)
    const worker = readFileSync(join(dir, 'sw.js'), 'utf8')
    const again = await writeServiceWorker(ROOT, dir)
    expect(again.build).toBe(first.build)
    expect(readFileSync(join(dir, 'sw.js'), 'utf8')).toBe(worker)
    expect(readFileSync(join(dir, 'index.html'), 'utf8').match(/pianissimo-build/g)).toHaveLength(1)

    writeFileSync(join(dir, 'samples/salamander/C4.mp3'), 'another mp3')
    const changed = await writeServiceWorker(ROOT, dir)
    expect(changed.build).not.toBe(first.build)
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(`content="${changed.build}"`)
  })

  it('knows what is precached', () => {
    expect(isPrecached('assets/PracticeScreen-x.js')).toBe(true)
    expect(isPrecached('fonts/LICENSE')).toBe(true)
    expect(isPrecached('assets/PracticeScreen-x.js.map')).toBe(false)
    expect(isPrecached('.vite/manifest.json')).toBe(false)
    expect(isPrecached('sw.js')).toBe(false)
  })
})
