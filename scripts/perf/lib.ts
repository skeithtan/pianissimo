/**
 * Node-side helpers for perf.spec.ts: statistics, the in-page probe installed before the app
 * boots, and Chromium trace parsing (main-thread self time by kind).
 */

export interface Dist {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
}

const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d

export function dist(values: readonly number[]): Dist {
  const s = [...values].sort((a, b) => a - b)
  const q = (p: number): number => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0)
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0
  return {
    n: s.length,
    p50: round(q(0.5)),
    p95: round(q(0.95)),
    p99: round(q(0.99)),
    max: round(s.at(-1) ?? 0),
    mean: round(mean),
  }
}

export interface FrameStats extends Dist {
  /** Frames longer than 20 ms (a missed 60 Hz vsync with margin). */
  readonly over20: number
  readonly over33: number
  readonly over50: number
  readonly fps: number
}

export function frameStats(intervals: readonly number[]): FrameStats {
  const d = dist(intervals)
  const total = intervals.reduce((a, b) => a + b, 0)
  return {
    ...d,
    over20: intervals.filter((v) => v > 20).length,
    over33: intervals.filter((v) => v > 33.4).length,
    over50: intervals.filter((v) => v > 50).length,
    fps: total > 0 ? round((intervals.length * 1000) / total) : 0,
  }
}

/**
 * Installed with `addInitScript` (serialized: no closures over this module). Records frame
 * timestamps on demand, long tasks (Chromium), the first appearance of the Library, and strip
 * mutations for MIDI → DOM latency.
 */
export function installPageProbe(): void {
  interface LongTask {
    start: number
    duration: number
  }
  const w = window as unknown as Record<string, unknown>
  const longTasks: LongTask[] = []
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration })
    })
    po.observe({ type: 'longtask', buffered: true })
  } catch {
    // WebKit has no Long Tasks API.
  }
  const marks: Record<string, number> = {}
  const mo = new MutationObserver(() => {
    if (marks['libraryReady'] !== undefined) return
    const input = document.querySelector('label input[type="file"]')
    const h = [...document.querySelectorAll('h1, h2')].some((e) => /library/i.test(e.textContent ?? ''))
    if (input && h) {
      marks['libraryReady'] = performance.now()
      mo.disconnect()
    }
  })
  document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }))

  let frameTimes: number[] | null = null
  // One sampling loop at a time: a loop from an earlier start ends at its next frame.
  let generation = 0
  const loop = (gen: number) => (t: number) => {
    if (!frameTimes || gen !== generation) return
    frameTimes.push(t)
    requestAnimationFrame(loop(gen))
  }
  w['__perf'] = {
    marks,
    longTasks,
    startFrames(): void {
      frameTimes = []
      requestAnimationFrame(loop(++generation))
    },
    stopFrames(): number[] {
      const t = frameTimes ?? []
      frameTimes = null
      const out: number[] = []
      for (let i = 1; i < t.length; i++) out.push(t[i]! - t[i - 1]!)
      return out
    },
    longTasksSince(since: number): LongTask[] {
      return longTasks.filter((l) => l.start >= since)
    },
  }
}

/** Main-thread self time (ms) by kind from a Chromium trace. */
export interface TraceSplit {
  readonly scripting: number
  readonly style: number
  readonly layout: number
  readonly paint: number
  readonly gc: number
  readonly other: number
  readonly total: number
  /** Elements restyled (UpdateLayoutTree elementCount), summed. */
  readonly styledElements: number
  /** Main-thread paints (Paint events): frames that re-recorded some notation or UI. */
  readonly paints: number
  /** Top trace events by self time: "name count× ms". */
  readonly top: readonly string[]
}

const KIND: Record<string, 'scripting' | 'style' | 'layout' | 'paint' | 'gc'> = {
  FunctionCall: 'scripting',
  EvaluateScript: 'scripting',
  FireAnimationFrame: 'scripting',
  TimerFire: 'scripting',
  EventDispatch: 'scripting',
  RunMicrotasks: 'scripting',
  'v8.compile': 'scripting',
  'v8.compileModule': 'scripting',
  'v8.evaluateModule': 'scripting',
  'v8.run': 'scripting',
  'v8.callFunction': 'scripting',
  V8Execute: 'scripting',
  FireIdleCallback: 'scripting',
  XHRReadyStateChange: 'scripting',
  ParseHTML: 'scripting',
  MajorGC: 'gc',
  MinorGC: 'gc',
  'V8.GC_SCAVENGER': 'gc',
  BlinkGC: 'gc',
  'V8.GCScavenger': 'gc',
  'V8.GCFinalizeMC': 'gc',
  'V8.GCIncrementalMarking': 'gc',
  UpdateLayoutTree: 'style',
  RecalculateStyles: 'style',
  ParseAuthorStyleSheet: 'style',
  Layout: 'layout',
  UpdateLayerTree: 'layout',
  IntersectionObserverController: 'layout',
  PrePaint: 'paint',
  Paint: 'paint',
  PaintImage: 'paint',
  Layerize: 'paint',
  Commit: 'paint',
  CompositeLayers: 'paint',
  UpdateLayer: 'paint',
  'Decode Image': 'paint',
  RasterTask: 'paint',
}

interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: { name?: string; elementCount?: number; data?: { frame?: string } }
}

/** Self time of complete events on the renderer main thread(s) of the page, bucketed by kind. */
export function traceSplit(json: string): TraceSplit {
  const parsed = JSON.parse(json) as { traceEvents: TraceEvent[] } | TraceEvent[]
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents
  const main = new Set<string>()
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') main.add(`${e.pid}:${e.tid}`)
  }
  const out = { scripting: 0, style: 0, layout: 0, paint: 0, gc: 0, other: 0 }
  let styledElements = 0
  let paints = 0
  const byName = new Map<string, { n: number; self: number }>()
  const byThread = new Map<string, TraceEvent[]>()
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`
    if (!main.has(key)) continue
    if (e.name === 'UpdateLayoutTree') styledElements += e.args?.elementCount ?? 0
    if (e.name === 'Paint' && e.ph === 'X') paints++
    if (e.ph !== 'X' || e.dur === undefined) continue
    let list = byThread.get(key)
    if (!list) byThread.set(key, (list = []))
    list.push(e)
  }
  for (const list of byThread.values()) {
    list.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0))
    // Self time: duration minus direct children (proper nesting of X events on one thread).
    const stack: { name: string; end: number; kind: keyof typeof out | null; child: number; dur: number }[] = []
    const close = (until: number): void => {
      while (stack.length && stack.at(-1)!.end <= until) {
        const top = stack.pop()!
        const self = Math.max(0, top.dur - top.child)
        // Unknown event kinds inherit their parent's kind (e.g. V8 sub-phases under FunctionCall);
        // task overhead with no known kind above it is "other".
        out[top.kind ?? inherited(stack) ?? 'other'] += self
        const agg = byName.get(top.name) ?? { n: 0, self: 0 }
        agg.n++
        agg.self += self
        byName.set(top.name, agg)
      }
    }
    for (const e of list) {
      close(e.ts)
      const parent = stack.at(-1)
      if (parent) parent.child += e.dur!
      stack.push({ name: e.name, end: e.ts + e.dur!, kind: KIND[e.name] ?? null, child: 0, dur: e.dur! })
    }
    close(Infinity)
  }
  const ms = (v: number): number => round(v / 1000)
  const total = out.scripting + out.style + out.layout + out.paint + out.gc + out.other
  return {
    scripting: ms(out.scripting),
    style: ms(out.style),
    layout: ms(out.layout),
    paint: ms(out.paint),
    gc: ms(out.gc),
    other: ms(out.other),
    total: ms(total),
    styledElements,
    paints,
    top: [...byName.entries()]
      .sort((a, b) => b[1].self - a[1].self)
      .slice(0, 14)
      .map(([name, a]) => `${name} ${a.n}× ${ms(a.self)}`),
  }
}

function inherited(
  stack: readonly { kind: string | null }[],
): 'scripting' | 'style' | 'layout' | 'paint' | 'gc' | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const k = stack[i]!.kind
    if (k) return k as 'scripting' | 'style' | 'layout' | 'paint' | 'gc'
  }
  return null
}

/** Per-frame view of a trace split. */
export function perFrame(split: TraceSplit, frames: number): Record<string, number> {
  const f = Math.max(1, frames)
  return {
    scripting: round(split.scripting / f, 2),
    style: round(split.style / f, 2),
    layout: round(split.layout / f, 2),
    paint: round(split.paint / f, 2),
    gc: round(split.gc / f, 2),
    other: round(split.other / f, 2),
    total: round(split.total / f, 2),
  }
}

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}

/** Top self time (ms) by function from a CDP CPU profile: "name file:line ms". */
export function topSelf(
  profile: { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] },
  n: number,
): string[] {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const self = new Map<string, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]!)
    if (!node) continue
    const f = node.callFrame
    const file = f.url.split('/').pop() || '(native)'
    const key = `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (deltas[i + 1] ?? deltas[i] ?? 0) / 1000)
  }
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${round(v)}`)
}
