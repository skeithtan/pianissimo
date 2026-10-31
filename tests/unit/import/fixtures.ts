/**
 * Test helpers for importer fixtures (Node only: reads files from tests/fixtures).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildScorePackage,
  inspectSource,
  type BuildResult,
  type ImportSelection,
  type InspectResult,
} from '../../../src/core/import/pipeline'

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURES = resolve(here, '../../fixtures')
export const SCORES = resolve(FIXTURES, 'scores')
export const REFERENCE_PIECE = resolve(FIXTURES, 'private/reference-piece.musicxml')

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(SCORES, name)))
}

export function fixtureExists(path: string): boolean {
  return existsSync(path)
}

export async function inspectFixture(name: string): Promise<InspectResult> {
  return inspectSource({ name, bytes: fixtureBytes(name) })
}

/** Import a fixture with its suggested selection (or the given one). Fixed clock for stable ids. */
export async function importFixture(name: string, selection?: Partial<ImportSelection>): Promise<BuildResult> {
  return importBytes(name, fixtureBytes(name), selection)
}

export async function importBytes(
  name: string,
  bytes: Uint8Array,
  selection?: Partial<ImportSelection>,
): Promise<BuildResult> {
  const file = { name, bytes }
  const inspected = await inspectSource(file)
  const candidate = inspected.candidates.find((c) => c.id === selection?.candidate) ?? inspected.candidates[0]
  if (!candidate) throw new Error('no candidate')
  return buildScorePackage(
    file,
    { candidate: candidate.id, partIds: selection?.partIds ?? candidate.suggestedParts },
    { now: () => 0 },
  )
}

/** Minimal score-partwise wrapper for inline test documents. */
export function scoreXml(parts: string, partList?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>${partList ?? '<score-part id="P1"><part-name>Piano</part-name></score-part>'}</part-list>
  ${parts}
</score-partwise>`
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
