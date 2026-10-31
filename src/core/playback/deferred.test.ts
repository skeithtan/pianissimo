import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Spec "MIDI-only resource use" / "Deferred assets": the playback entry point must reach the
 * browser-audio backend (and its sample bank) and the metronome click only through dynamic
 * imports, so physical-MIDI practice never loads them.
 */
const ROOT = resolve(__dirname)

function staticImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  const re = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/gm
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue
    out.push(m[1]!)
  }
  return out
}

function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [`${base}.ts`, resolve(base, 'index.ts')]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // try next
    }
  }
  return null
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const spec of staticImports(f)) {
      const next = resolveModule(f, spec)
      if (next) stack.push(next)
    }
  }
  return seen
}

describe('deferred playback assets', () => {
  it('the playback index never statically imports browser audio or the metronome click', () => {
    const files = [...reachable(resolve(ROOT, 'index.ts'))].map((f) => relative(ROOT, f))
    expect(files).toContain('transport.ts')
    expect(files).toContain('midiOutput.ts')
    expect(files.filter((f) => f.startsWith('browserAudio') || f === 'webaudio/metronome.ts')).toEqual([])
  })

  it('lazy loaders reach them through dynamic import()', () => {
    const src = readFileSync(resolve(ROOT, 'lazy.ts'), 'utf8')
    expect(src).toMatch(/import\('\.\/browserAudio'\)/)
    expect(src).toMatch(/import\('\.\/webaudio\/metronome'\)/)
  })
})
