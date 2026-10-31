// Bundle size report (spec: "Initial application code" budget and deferred-chunk reporting).
// Reads dist/.vite/manifest.json, walks static imports from the HTML entry for the initial
// shell, and reports every deferred chunk plus the total needed to start MusicXML practice.
import { readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const DIST = 'dist'
const BUDGET_JS = 150 * 1024
const BUDGET_CSS = 30 * 1024

const manifest = JSON.parse(readFileSync(join(DIST, '.vite', 'manifest.json'), 'utf8'))

const gz = (file) => gzipSync(readFileSync(join(DIST, file))).length
const raw = (file) => statSync(join(DIST, file)).size
const kb = (n) => `${(n / 1024).toFixed(1)} kB`

function collect(key, seen, follow) {
  if (seen.has(key)) return
  seen.add(key)
  const chunk = manifest[key]
  for (const dep of chunk?.[follow] ?? []) collect(dep, seen, follow)
}

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry && k.endsWith('index.html'))
if (!entryKey) throw new Error('No HTML entry in manifest')

const initial = new Set()
collect(entryKey, initial, 'imports')

const files = (keys, pick) =>
  [...keys].flatMap((k) => {
    const c = manifest[k]
    return pick === 'css' ? (c.css ?? []) : c.file.endsWith('.js') ? [c.file] : []
  })

const sum = (list) => list.reduce((a, f) => a + gz(f), 0)
const initialJs = [...new Set(files(initial, 'js'))]
const initialCss = [...new Set(files(initial, 'css'))]

// Practice path: everything reachable from the entry including dynamic imports.
const practice = new Set()
;(function walk(key) {
  if (practice.has(key)) return
  practice.add(key)
  const c = manifest[key]
  for (const dep of [...(c?.imports ?? []), ...(c?.dynamicImports ?? [])]) walk(dep)
})(entryKey)
const practiceJs = [...new Set(files(practice, 'js'))]
const practiceCss = [...new Set(files(practice, 'css'))]

const deferred = [...practice].filter((k) => !initial.has(k))

const rows = []
rows.push('# Bundle size report', '')
rows.push(`Initial shell JS:  ${kb(sum(initialJs))} gzip (budget ${kb(BUDGET_JS)})`)
rows.push(`Initial shell CSS: ${kb(sum(initialCss))} gzip (budget ${kb(BUDGET_CSS)})`)
rows.push(`Practice path JS:  ${kb(sum(practiceJs))} gzip (all chunks reachable incl. dynamic)`)
rows.push(`Practice path CSS: ${kb(sum(practiceCss))} gzip`, '')
rows.push('Deferred chunks:')
for (const k of deferred) {
  const c = manifest[k]
  if (!c.file.endsWith('.js')) continue
  rows.push(`  ${c.file.padEnd(48)} ${kb(gz(c.file)).padStart(10)} gzip  ${kb(raw(c.file)).padStart(10)} raw  (${k})`)
}
console.log(rows.join('\n'))

const over = []
if (sum(initialJs) > BUDGET_JS) over.push('initial JS')
if (sum(initialCss) > BUDGET_CSS) over.push('initial CSS')
if (over.length) {
  console.error(`\nOver budget: ${over.join(', ')}`)
  process.exitCode = 1
}
