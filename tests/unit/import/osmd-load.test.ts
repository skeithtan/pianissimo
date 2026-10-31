// @vitest-environment happy-dom
/**
 * The render XML must be MusicXML that OSMD 2.2.1 reads as intended: one source measure per
 * occurrence, every performed note present, octave-shift brackets per performed span, and no
 * repeat structure left for OSMD to unfold again. Only OSMD's reader runs here (no drawing).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { describe, expect, it } from 'vitest'
import { generateLongScore } from '../../fixtures/generate-long-score'
import { REFERENCE_PIECE, SCORES, fixtureExists, importBytes, importFixture, utf8 } from './fixtures'
import type { BuildResult } from '../../../src/core/import/pipeline'

interface Shift {
  readonly staff: number
  readonly start: number
  readonly end: number
  readonly endVoiceEntryIndex: number
}

/**
 * Counts from OSMD's reader plus the positions OSMD would engrave displaced, following its
 * calculator rule: a shift covers timestamps start ≤ t ≤ end, except voice entries at the end
 * timestamp from `endVoiceEntryIndex` on (only when that index is > 0).
 */
async function osmdCounts(xml: string) {
  const div = document.createElement('div')
  document.body.appendChild(div)
  const osmd = new OpenSheetMusicDisplay(div, { autoResize: false, backend: 'svg', drawTitle: false })
  await osmd.load(xml)
  const sheet = osmd.Sheet
  const shifts: Shift[] = []
  sheet.SourceMeasures.forEach((m) => {
    m.StaffLinkedExpressions.forEach((list, staff) => {
      for (const e of list) {
        const s = e.OctaveShiftStart
        if (!s) continue
        const end = s.ParentEndMultiExpression?.AbsoluteTimestamp.RealValue ?? Infinity
        shifts.push({
          staff,
          start: s.ParentStartMultiExpression.AbsoluteTimestamp.RealValue,
          end,
          endVoiceEntryIndex: s.endVoiceEntryIndex,
        })
      }
    })
  })
  let notes = 0
  const displaced: string[] = []
  sheet.SourceMeasures.forEach((m, occ) => {
    for (const container of m.VerticalSourceStaffEntryContainers) {
      container.StaffEntries.forEach((entry, staff) => {
        if (!entry) return
        const t = m.AbsoluteTimestamp.RealValue + container.Timestamp.RealValue
        entry.VoiceEntries.forEach((ve, r) => {
          for (const n of ve.Notes) {
            if (n.isRest() || !n.Pitch) continue
            notes++
            const active = shifts.some(
              (s) =>
                s.staff === staff &&
                s.start <= t + 1e-9 &&
                t <= s.end + 1e-9 &&
                !(Math.abs(t - s.end) < 1e-9 && s.endVoiceEntryIndex > 0 && r >= s.endVoiceEntryIndex),
            )
            if (active) displaced.push(`${occ}|${staff}|${container.Timestamp.RealValue.toFixed(6)}`)
          }
        })
      })
    }
  })
  div.remove()
  return {
    measures: sheet.SourceMeasures.length,
    notes,
    shifts: shifts.length,
    displaced: displaced.sort(),
    repetitions: sheet.Repetitions.length,
  }
}

function expectMatches(result: BuildResult, counts: Awaited<ReturnType<typeof osmdCounts>>) {
  const model = result.package.model
  expect(counts.measures).toBe(model.occurrences.length)
  expect(counts.notes).toBe(model.notes.length)
  expect(counts.shifts).toBe(model.ottavas.length)
  expect(counts.repetitions).toBeLessThanOrEqual(1)
  const displaced = model.notes
    .filter((n) => n.ottavaShift !== 0)
    .map((n) => `${n.occ}|${n.staff}|${(n.onsetInMeasure.n / n.onsetInMeasure.d).toFixed(6)}`)
    .sort()
  expect(counts.displaced).toEqual(displaced)
}

const fixtures = readdirSync(SCORES).filter((f) => f.endsWith('.musicxml') && f !== 'malformed.musicxml')

describe('OSMD 2.2.1 reads the render XML as the model describes it', () => {
  it.each(fixtures)('%s', async (name) => {
    const result = await importFixture(name)
    expectMatches(result, await osmdCounts(result.package.renderXml))
  })

  it('the original repeats fixture has a repetition OSMD would unfold; the render XML has none', async () => {
    const original = await osmdCounts(readFileSync(`${SCORES}/repeats.musicxml`, 'utf8'))
    expect(original.repetitions).toBeGreaterThan(1)
  })

  it('a 120-measure generated score', async () => {
    const result = await importBytes('long.musicxml', utf8(generateLongScore(120)))
    expectMatches(result, await osmdCounts(result.package.renderXml))
  })

  it.skipIf(!fixtureExists(REFERENCE_PIECE))('the supplied reference piece', async () => {
    const result = await importBytes('reference-piece.musicxml', new Uint8Array(readFileSync(REFERENCE_PIECE)))
    expectMatches(result, await osmdCounts(result.package.renderXml))
  })
})
