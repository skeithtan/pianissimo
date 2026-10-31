/**
 * Renderer harness page (WP6). Exposes `window.harness` for Playwright specs and manual
 * inspection: prepare a layout for a fixture, mount a StripView, drive it, read measurements.
 */
import '../../src/ui/global.css'
import './theme.css'
import { buildScorePackage, inspectSource } from '../../src/core/import'
import type { ScorePackage } from '../../src/core/model/score'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { labelForMidi, labelText } from '../../src/core/naming'
import { OsmdRenderer } from '../../src/render/osmd/adapter'
import { positionToX } from '../../src/render/strip/scroll'
import { StripView, type StripOptions, type StripStats } from '../../src/render/strip/StripView'
import type { PreparedLayout, RenderInput } from '../../src/render/types'
import { generateLongScore } from '../fixtures/generate-long-score'
import { longScoreFixture } from '../fixtures/render/long-score'
import { FIXTURES, fixture, type FixtureName } from '../fixtures/render/scores'

const privateScores = import.meta.glob('../fixtures/private/*.musicxml', { query: '?raw', import: 'default' })
const importerScores = import.meta.glob('../fixtures/scores/*.musicxml', { query: '?raw', import: 'default' })

export interface PrepareSummary {
  readonly name: string
  readonly report: PreparedLayout['report']
  readonly stats: PreparedLayout['stats']
  readonly params: PreparedLayout['params']
  readonly width: number
  readonly height: number
  readonly segments: number
  readonly labels: number
  readonly notes: number
  readonly ottavas: PreparedLayout['ottavas']
  readonly contexts: number
  readonly contextChanges: PreparedLayout['contextChanges']
}

let layout: PreparedLayout | undefined
let input: RenderInput | undefined

async function inputFor(name: string): Promise<RenderInput> {
  if (name in FIXTURES) return fixture(name as FixtureName).input
  const long = /^long-(\d+)$/.exec(name)
  if (long) return longScoreFixture(Number(long[1])).input
  const generated = /^generated-(\d+)$/.exec(name)
  if (generated) return importXml(`${name}.musicxml`, generateLongScore(Number(generated[1])))
  const scored = /^scores\/(.+)$/.exec(name)
  const importerLoader = scored ? importerScores[`../fixtures/scores/${scored[1]}`] : undefined
  if (importerLoader) return importXml(scored![1]!, (await importerLoader()) as string)
  const loader = privateScores[`../fixtures/private/${name}`]
  if (loader) return importXml(name, (await loader()) as string)
  throw new Error(`Unknown fixture ${name}`)
}

/** Runs the real importer in the page and adapts its package to `RenderInput`. */
async function importXml(name: string, xml: string): Promise<RenderInput> {
  const file = { name, bytes: new TextEncoder().encode(xml) }
  const inspected = await inspectSource(file)
  const candidate = inspected.candidates[0]
  if (!candidate) throw new Error('No score candidate')
  const built = await buildScorePackage(
    file,
    { candidate: candidate.id, partIds: candidate.suggestedParts },
    { now: () => 0 },
  )
  lastPackage = built.package
  return packageInput(built.package)
}

export function packageInput(pkg: ScorePackage): RenderInput {
  const m = pkg.model
  return {
    renderXml: pkg.renderXml,
    scoreVersionId: m.scoreVersionId,
    notes: m.notes,
    occurrences: m.occurrences,
    staves: m.staves,
    ottavas: m.ottavas,
    clefs: m.clefs,
    keys: m.keys,
    meters: m.meters,
  }
}

let lastPackage: ScorePackage | undefined

/** Imports MusicXML text with the real importer, then prepares it (ad-hoc fixtures). */
async function prepareXml(name: string, xml: string, maxChars = 3): Promise<PrepareSummary> {
  input = await importXml(name, xml)
  layout = await new OsmdRenderer().prepare(input, { labels: { maxChars } })
  return summarize(name, layout)
}
function summarize(name: string, l: PreparedLayout): PrepareSummary {
  return {
    name,
    report: l.report,
    stats: l.stats,
    params: l.params,
    width: l.width,
    height: l.height,
    segments: l.segments.length,
    labels: l.labels.length,
    notes: l.notes.length,
    ottavas: l.ottavas,
    contexts: l.contexts.length,
    contextChanges: l.contextChanges,
  }
}

async function prepare(
  name: string,
  maxChars = 3,
  opts: {
    maxIterations?: number
    segmentWidth?: number
    spacing?: { voiceSpacingMultiplier: number; voiceSpacingAddend: number }
  } = {},
): Promise<PrepareSummary> {
  input = await inputFor(name)
  layout = await new OsmdRenderer().prepare(input, { labels: { maxChars }, ...opts })
  return summarize(name, layout)
}

let strip: StripView | undefined
const events: { type: string; value: unknown }[] = []

function mount(size: { width?: number; height?: number } = {}, options: StripOptions = {}): StripStats {
  if (!layout) throw new Error('prepare first')
  strip?.destroy()
  const host = document.getElementById('strip-host')!
  host.style.width = `${size.width ?? 1180}px`
  host.style.height = `${size.height ?? 360}px`
  events.length = 0
  const log = (type: string) => (value: unknown) => events.push({ type, value })
  strip = new StripView(host, layout, {
    onBrowse: log('browse'),
    onSeekRequest: log('seek'),
    onLoopChange: log('loop'),
    onLoopSelectModeChange: log('loopMode'),
    onVisibleLabels: log('visibleLabels'),
    onZoomChange: log('zoom'),
    ...options,
  })
  strip.flushNow()
  return strip.stats()
}

/** Label text for every note (default naming), as the session would supply from core/naming. */
function labelTexts(): Map<number, string> {
  const texts = new Map<number, string>()
  const pkg = lastPackage
  if (pkg && input?.scoreVersionId === pkg.model.scoreVersionId) {
    for (const n of pkg.model.notes) texts.set(n.index, labelText(n, DEFAULT_SETTINGS.naming))
  } else {
    for (const n of input?.notes ?? []) texts.set(n.index, labelForMidi(n.midi, DEFAULT_SETTINGS.naming).text)
  }
  return texts
}

function showAllLabels(opacity = 1): void {
  const texts = labelTexts()
  strip!.setLabels(texts)
  strip!.setLabelOpacity(new Map([...texts.keys()].map((n) => [n, opacity])))
  strip!.flushNow()
}

/** Onset positions (whole notes) of every distinct note onset, in order. */
function onsets(): number[] {
  const l = layout!
  const out = new Set<number>()
  for (const n of input!.notes) {
    const o = l.occurrences[n.occ]!
    out.add(o.start + n.onsetInMeasure.n / n.onsetInMeasure.d)
  }
  return [...out].sort((a, b) => a - b)
}

interface TraverseResult {
  readonly steps: number
  readonly maxMountedSegments: number
  readonly maxMountedNodes: number
  readonly maxLabelNodes: number
  readonly maxCachedSegments: number
  readonly maxDomNodes: number
  readonly maxFlushMs: number
  readonly p95FlushMs: number
  readonly final: StripStats
}

/** Steps the cursor through every onset (`passes` times), flushing each frame synchronously. */
function traverse(passes = 1, stride = 1): TraverseResult {
  const s = strip!
  const pos = onsets()
  let maxSeg = 0
  let maxNodes = 0
  let maxLabels = 0
  let maxCached = 0
  let maxDom = 0
  const times: number[] = []
  let steps = 0
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < pos.length; i += stride) {
      const t0 = performance.now()
      s.setCursor(pos[i]!, { smooth: false })
      s.flushNow()
      times.push(performance.now() - t0)
      const st = s.stats()
      maxSeg = Math.max(maxSeg, st.mountedSegments)
      maxNodes = Math.max(maxNodes, st.mountedNodes)
      maxLabels = Math.max(maxLabels, st.labelNodes)
      maxCached = Math.max(maxCached, st.cachedSegments)
      maxDom = Math.max(maxDom, st.domNodes)
      steps++
    }
  }
  times.sort((a, b) => a - b)
  return {
    steps,
    maxMountedSegments: maxSeg,
    maxMountedNodes: maxNodes,
    maxLabelNodes: maxLabels,
    maxCachedSegments: maxCached,
    maxDomNodes: maxDom,
    maxFlushMs: times.at(-1) ?? 0,
    p95FlushMs: times[Math.floor(times.length * 0.95)] ?? 0,
    final: s.stats(),
  }
}

/** 'light' | 'dark' theme on <html>, optionally pinning light score paper. */
function setTheme(theme: 'light' | 'dark', lightPaper = false): void {
  const html = document.documentElement
  html.dataset['theme'] = theme
  if (lightPaper) html.dataset['scorePaper'] = 'light'
  else delete html.dataset['scorePaper']
}

interface PracticeRun {
  readonly steps: number
  readonly frames: number
  readonly p95FrameMs: number
  readonly maxFrameMs: number
  readonly longTasks: readonly number[]
  readonly maxMountedSegments: number
  readonly maxMountedNodes: number
  readonly parsedSegments: number
}

/**
 * Plays through onsets in real time like a fast player: every `stepMs` the cursor advances (smooth
 * scroll) and the targets change, with all labels visible. Times each StripView frame (its own
 * rAF work) and records long tasks (Chromium).
 */
async function simulatePractice(seconds = 8, stepMs = 60): Promise<PracticeRun> {
  const s = strip!
  const target = s as unknown as { flush: () => void }
  const original = target.flush.bind(s)
  const frames: number[] = []
  target.flush = () => {
    const t0 = performance.now()
    original()
    frames.push(performance.now() - t0)
  }
  const longTasks: number[] = []
  let observer: PerformanceObserver | undefined
  try {
    observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => e.duration)))
    observer.observe({ type: 'longtask' })
  } catch {
    observer = undefined
  }
  const pos = onsets()
  const byOnset = new Map<number, number[]>()
  for (const n of input!.notes) {
    const o = layout!.occurrences[n.occ]!
    const p = o.start + n.onsetInMeasure.n / n.onsetInMeasure.d
    const list = byOnset.get(p)
    if (list) list.push(n.index)
    else byOnset.set(p, [n.index])
  }
  let maxSeg = 0
  let maxNodes = 0
  let steps = 0
  const end = performance.now() + seconds * 1000
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (performance.now() >= end || steps >= pos.length) {
        resolve()
        return
      }
      const p = pos[steps++]!
      s.setCursor(p)
      s.setTargets(byOnset.get(p) ?? [])
      const st = s.stats()
      maxSeg = Math.max(maxSeg, st.mountedSegments)
      maxNodes = Math.max(maxNodes, st.mountedNodes)
      setTimeout(tick, stepMs)
    }
    tick()
  })
  await new Promise((r) => setTimeout(r, 300))
  observer?.disconnect()
  target.flush = original
  const sorted = [...frames].sort((a, b) => a - b)
  return {
    steps,
    frames: frames.length,
    p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maxFrameMs: sorted.at(-1) ?? 0,
    longTasks,
    maxMountedSegments: maxSeg,
    maxMountedNodes: maxNodes,
    parsedSegments: s.stats().parsedSegments,
  }
}

interface ListenSample {
  /** rAF timestamp (ms). */
  readonly t: number
  readonly pos: number
  /** Content translate (screen px) and the cursor's screen x after the frame. */
  readonly tx: number
  readonly cursorX: number
  /** StripView flush time for this frame (ms). */
  readonly flushMs: number
}

interface ListenRun {
  readonly samples: readonly ListenSample[]
  readonly from: number
  readonly to: number
  readonly wholePerSec: number
  /** Largest jump of the old barline-anchored mapping (barline → next bar's first onset, layout px). */
  readonly legacyMaxJump: number
  readonly longTasks: readonly number[]
}

const translateX = (el: Element | null): number =>
  Number(/translate3d\((-?[\d.]+)px/.exec((el as HTMLElement | null)?.style.transform ?? '')?.[1] ?? NaN)

/**
 * Listen-mode motion (R12): the position advances at a constant musical speed and is passed with
 * `smooth: false` every frame, then the frame is flushed and the translate sampled. By default
 * each animation frame advances by `wholePerSec` × elapsed rAF time, like the transport's
 * `positionNow`; `fixedStep` (whole notes) instead advances by exactly that per synchronous step,
 * independent of frame timing. `legacy` swaps in the pre-R12 mapping (barline anchors, no
 * smoothing) for comparison. The sweep runs through the unclamped middle of the score.
 */
async function simulateListen(
  seconds = 3,
  wholePerSec = 1,
  opts: { fixedStep?: number; legacy?: boolean } = {},
): Promise<ListenRun> {
  const s = strip!
  const l = layout!
  const hostW = document.getElementById('strip-host')!.getBoundingClientRect().width
  const occs = l.occurrences
  const first = occs.find((o) => o.x0 > hostW) ?? occs[0]!
  const lastEnd = l.width - hostW
  const last = [...occs].reverse().find((o) => o.x1 < lastEnd) ?? occs.at(-1)!
  const from = first.start
  const to = Math.min(last.start + last.duration, from + seconds * wholePerSec)
  let legacyMaxJump = 0
  for (let i = 0; i + 1 < occs.length; i++)
    legacyMaxJump = Math.max(legacyMaxJump, occs[i + 1]!.anchors[0]![1] - occs[i]!.x1)
  const internal = s as unknown as { path: { at(p: number): number; smoothAt(p: number, w: number): number } }
  const path = internal.path
  if (opts.legacy) internal.path = { at: (p) => positionToX(occs, p), smoothAt: (p) => positionToX(occs, p) }
  const longTasks: number[] = []
  let observer: PerformanceObserver | undefined
  try {
    observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => e.duration)))
    observer.observe({ type: 'longtask' })
  } catch {
    observer = undefined
  }
  s.setCursor(from, { smooth: false })
  s.flushNow()
  const content = document.querySelector('.pn-content')
  const cursor = document.querySelector('.pn-cursor')
  const samples: ListenSample[] = []
  const step = (t: number, pos: number): void => {
    const f0 = performance.now()
    s.setCursor(pos, { smooth: false })
    s.flushNow()
    samples.push({ t, pos, tx: translateX(content), cursorX: translateX(cursor), flushMs: performance.now() - f0 })
  }
  try {
    if (opts.fixedStep) {
      for (let k = 1; from + k * opts.fixedStep <= to; k++) step(k, from + k * opts.fixedStep)
    } else {
      await new Promise<void>((resolve) => {
        let t0 = -1
        const frame = (t: number): void => {
          if (t0 < 0) t0 = t
          const pos = Math.min(to, from + ((t - t0) / 1000) * wholePerSec)
          step(t, pos)
          if (pos >= to) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
    }
  } finally {
    internal.path = path
    observer?.disconnect()
  }
  return { samples, from, to, wholePerSec, legacyMaxJump, longTasks }
}

const harness = {
  simulatePractice,
  simulateListen,
  setTheme,
  prepareXml,
  fixtures: [...Object.keys(FIXTURES), 'long-500', ...Object.keys(privateScores).map((k) => k.split('/').pop()!)],
  importerFixtures: Object.keys(importerScores).map((k) => `scores/${k.split('/').pop()!}`),
  prepare,
  layout: () => layout,
  input: () => input,
  package: () => lastPackage,
  mount,
  strip: () => strip,
  events,
  labelTexts,
  showAllLabels,
  onsets,
  traverse,
}

declare global {
  interface Window {
    harness: typeof harness
  }
}
window.harness = harness
