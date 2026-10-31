import { describe, expect, it } from 'vitest'
import { generateLongScore } from '../../fixtures/generate-long-score'
import { importBytes, utf8 } from './fixtures'

describe('500-measure generated score (spec: Long piece, Import lifecycle)', async () => {
  const xml = generateLongScore(500)
  const t0 = performance.now()
  const result = await importBytes('long-500.musicxml', utf8(xml))
  const importMs = performance.now() - t0
  const model = result.package.model

  it('imports within a generous time budget and reports the time', () => {
    console.info(
      `500-measure import: ${importMs.toFixed(0)} ms, ${(xml.length / 1e6).toFixed(2)} MB XML, ${model.notes.length} notes`,
    )
    expect(importMs).toBeLessThan(15_000)
  })

  it('has 500 occurrences, every note mapped, and no warnings', () => {
    expect(model.occurrences).toHaveLength(500)
    expect(model.notes.length).toBe(model.sourceNotes.length)
    expect(model.notes.length).toBe((xml.match(/<pitch>/g) ?? []).length)
    expect(model.diagnostics.filter((d) => d.severity !== 'info')).toEqual([])
    expect(result.summary.readiness.scoredPractice).toBe(true)
  })

  it('contains the features renderer and e2e tests rely on', () => {
    expect(model.ottavas).toHaveLength(31)
    expect(model.ottavas.every((o) => o.notes.length > 0 && o.endOcc === o.startOcc + 1)).toBe(true)
    expect(model.keys.map((k) => [k.occ, k.fifths])).toEqual([
      [0, 0],
      [250, 2],
    ])
    expect(model.clefs.filter((c) => c.staff === 1).length).toBe(1 + 2 * 10)
    expect(model.tempo.segments.map((s) => s.quarterBpm)).toEqual([96, 80])
    expect(result.summary.counts.tupletNotes).toBe(3 * 125)
    expect(model.notes.filter((n) => n.tieContinuation)).toHaveLength(124)
    expect(result.summary.counts.chords).toBeGreaterThan(250)
    expect(model.pedals.length).toBe(250)
  })

  it('renders one measure per occurrence', () => {
    expect(result.package.renderXml.match(/<measure /g)).toHaveLength(500)
  })

  it('is deterministic and accepts other lengths', () => {
    expect(generateLongScore(500)).toBe(xml)
    expect(() => generateLongScore(0)).toThrow(RangeError)
    expect(generateLongScore(3).match(/<measure /g)).toHaveLength(3)
  })
})
