// Compares perf runs (scripts/perf/perf.spec.ts JSON output) as a Markdown table.
//   node scripts/perf/table.mjs before-chromium.json after-chromium.json [more.json …]
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/perf/table.mjs <run.json> [<run.json> …]')
  process.exit(1)
}
const runs = files.map((f) => ({ name: basename(f, '.json'), data: JSON.parse(readFileSync(f, 'utf8')) }))

const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o)
const pct = (f) => (f ? `${f.p50} / ${f.p95} / ${f.p99}` : '–')
const n = (v) => (v === undefined || v === null ? '–' : String(v))

/** [row label, value(run)] */
const ROWS = [
  ['Library ready (ms)', (r) => n(get(r, 'load.libraryReady'))],
  ['Initial JS / CSS transferred (kB)', (r) => kb(get(r, 'load.jsEncoded'), get(r, 'load.cssEncoded'))],
  ['Load long tasks (ms)', (r) => n(get(r, 'load.longTaskMs'))],
  [
    'Import 500: to summary / stored (ms)',
    (r) => `${n(get(r, 'import500.toSummaryMs'))} / ${n(get(r, 'import500.toStoredMs'))}`,
  ],
  ['Import 500: max frame gap (ms)', (r) => n(get(r, 'import500.maxFrameGapMs'))],
  [
    'Prepare 500 cold (ms) / longest task',
    (r) => `${n(get(r, 'prepare500.cold.toStripMs'))} / ${n(get(r, 'prepare500.cold.maxLongTaskMs'))}`,
  ],
  [
    'Prepare 500 warm (ms) / longest task',
    (r) => `${n(get(r, 'prepare500.warm.toStripMs'))} / ${n(get(r, 'prepare500.warm.maxLongTaskMs'))}`,
  ],
  ['Reload into Practice 500 (ms)', (r) => n(get(r, 'prepare500.reloadIntoPracticeMs'))],
  [
    'Prepare normal fixture cold / warm (ms)',
    (r) => `${n(get(r, 'normal.prepare.cold.toStripMs'))} / ${n(get(r, 'normal.prepare.warm.toStripMs'))}`,
  ],
  [
    'Prepare reference piece cold / warm (ms)',
    (r) => `${n(get(r, 'reference.prepare.cold.toStripMs'))} / ${n(get(r, 'reference.prepare.warm.toStripMs'))}`,
  ],
  ['Listen: frame p50 / p95 / p99 (ms)', (r) => pct(get(r, 'listen.frames'))],
  ['Listen: frames > 20 ms', (r) => frac(get(r, 'listen.frames'))],
  ['Listen: long tasks', (r) => n(get(r, 'listen.longTasks'))],
  ['Listen: main thread ms/frame', (r) => split(get(r, 'listen.mainThreadPerFrame'))],
  ['Listen: Preact renders/frame', (r) => n(get(r, 'listen.rendersPerFrame'))],
  ['Listen: frames with a paint', (r) => paintShare(get(r, 'listen'))],
  ['Listen + 88-key guide: main ms/frame', (r) => split(get(r, 'listenGuide.mainThreadPerFrame'))],
  [
    'Listen + guide: frame p95 / > 20 ms',
    (r) => `${n(get(r, 'listenGuide.frames.p95'))} / ${frac(get(r, 'listenGuide.frames'))}`,
  ],
  ['Listen + all labels: main ms/frame', (r) => split(get(r, 'listenLabels.mainThreadPerFrame'))],
  ['Listen reference piece: main ms/frame', (r) => split(get(r, 'reference.listen.mainThreadPerFrame'))],
  [
    'MIDI → strip DOM p50 / p95 (ms)',
    (r) => `${n(get(r, 'midiLatency.dom.p50'))} / ${n(get(r, 'midiLatency.dom.p95'))}`,
  ],
  [
    'MIDI → next frame p50 / p95 (ms)',
    (r) => `${n(get(r, 'midiLatency.nextFrame.p50'))} / ${n(get(r, 'midiLatency.nextFrame.p95'))}`,
  ],
  ['Practice 8 notes/s: frame p50 / p95 / p99', (r) => pct(get(r, 'practiceFast.frames'))],
  ['Practice 8 notes/s: main ms/frame', (r) => split(get(r, 'practiceFast.mainThreadPerFrame'))],
  [
    'Wrong-note flash: frame p95 / max (ms)',
    (r) => `${n(get(r, 'wrongFlash.frames.p95'))} / ${n(get(r, 'wrongFlash.frames.max'))}`,
  ],
  ['Wrong-note flash: main ms/frame', (r) => split(get(r, 'wrongFlash.mainThreadPerFrame'))],
  ['Traversal: max mounted segments', (r) => n(get(r, 'traversal.maxMountedSegments'))],
  ['JS heap after prepare / listen / traversal (MB)', (r) => heap(r)],
]

function kb(a, b) {
  if (a === undefined) return '–'
  return `${(a / 1024).toFixed(1)} / ${(b / 1024).toFixed(1)}`
}
function frac(f) {
  return f ? `${f.over20} / ${f.n}` : '–'
}
function split(s) {
  return s ? `${s.total} (js ${s.scripting}, style ${s.style}, paint ${s.paint})` : '–'
}
function paintShare(m) {
  const p = m?.mainThread?.paints
  return p === undefined ? '–' : `${p} / ${m.frames.n}`
}
function heap(r) {
  const h = ['heapAfterPrepare', 'heapAfterListen', 'heapAfterTraversal'].map((k) => get(r, `${k}.jsHeapUsedMB`))
  return h.every((v) => v === undefined) ? '–' : h.map(n).join(' / ')
}

const header = `| Metric | ${runs.map((r) => `${r.name} (${r.data.browser}, CPU ${r.data.cpuThrottle}×)`).join(' | ')} |`
const rule = `| --- | ${runs.map(() => '---').join(' | ')} |`
const body = ROWS.map(([label, f]) => `| ${label} | ${runs.map((r) => f(r.data)).join(' | ')} |`)
console.log([header, rule, ...body].join('\n'))
