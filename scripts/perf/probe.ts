/**
 * Render counter for the perf build only (scripts/perf/vite.config.ts prepends it to the app
 * entry). Counts Preact component renders by component name through the internal render hook
 * (`options._render`, mangled `__r` in Preact's published build), chained with any hook already
 * installed (@preact/signals installs one too). Never part of the production bundle.
 */
import { options } from 'preact'

interface PerfProbe {
  renders: Record<string, number>
  reset(): void
}

declare global {
  interface Window {
    __pnProbe?: PerfProbe
  }
}

type RenderHook = (vnode: { type: unknown }) => void
const hooks = options as unknown as { __r?: RenderHook }
const previous = hooks.__r

const probe: PerfProbe = {
  renders: {},
  reset() {
    probe.renders = {}
  },
}
window.__pnProbe = probe

hooks.__r = (vnode) => {
  const type = vnode.type as { displayName?: string; name?: string } | string
  if (typeof type === 'function' || typeof type === 'object') {
    const name = (type as { displayName?: string }).displayName || (type as { name?: string }).name || 'anonymous'
    probe.renders[name] = (probe.renders[name] ?? 0) + 1
  }
  previous?.(vnode)
}
