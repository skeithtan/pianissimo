import { describe, expect, it } from 'vitest'
import { buildScore } from '../../core/engine/testkit'
import { rat } from '../../core/music/rational'
import { clampPassage, passageSummary, rangeText, selectionTimeline, startPlan } from './selection'

const score = buildScore({
  notes: [
    { at: 0, midi: 60 },
    { at: 4, midi: 62 },
    { at: 8, midi: 48, hand: 'L' },
  ],
  bars: 3,
  tempo: { bpm: 60, unit: rat(3, 8) },
  passes: [
    { number: '1', pass: 1 },
    { number: '1', pass: 2 },
    { number: '2', pass: 1 },
  ],
})
const ok = { hasOutput: true, accompanimentAllowed: true, hasTempo: true }

describe('selection', () => {
  it('describes hands, bars with repeat passes and tempo with its beat unit', () => {
    expect(rangeText(score, null)).toBe('Whole piece')
    expect(rangeText(score, { fromOcc: 1, toOcc: 1 })).toBe('Bar 1 (pass 2)')
    expect(rangeText(score, { fromOcc: 0, toOcc: 2 })).toBe('Bars 1–2')
    const summary = passageSummary(score, score.tempo, {
      hands: 'right',
      range: { fromOcc: 0, toOcc: 1 },
      multiplier: 0.5,
    })
    expect(summary).toBe('Right hand · Bars 1–1 (pass 2) · 50% (♩. = 30)')
  })

  it('clamps passages to the piece', () => {
    expect(clampPassage(score, { fromOcc: 5, toOcc: -2 })).toEqual({ fromOcc: 0, toOcc: 2 })
    expect(clampPassage(score, null)).toBeNull()
  })

  it('plans reading, scored and Preview starts with plain reasons', () => {
    const sel = { hands: 'both' as const, range: null, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, sel), sel, ok)).toEqual({
      action: 'reading',
      enabled: true,
      reason: null,
    })
    expect(startPlan(selectionTimeline(score, score.tempo, sel), sel, { ...ok, hasTempo: false })).toMatchObject({
      enabled: false,
      reason: 'Set a practice tempo so the score can follow the timing.',
    })
    const left = { hands: 'left' as const, range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 }
    const plan = startPlan(selectionTimeline(score, score.tempo, left), left, ok)
    expect(plan).toMatchObject({ action: 'scored', enabled: false })
    expect(plan.reason).toMatch(/Left hand has no notes/)
    const preview = { hands: 'none' as const, range: null, multiplier: 1 }
    const previewTimeline = selectionTimeline(score, score.tempo, preview)
    expect(startPlan(previewTimeline, preview, ok)).toEqual({ action: 'listen', enabled: true, reason: null })
    // Nothing can play (no piano and no device sound): Listen says why.
    const none = {
      ...ok,
      hasOutput: false,
      noOutputReason: 'No piano is connected and this browser cannot play sound.',
    }
    expect(startPlan(previewTimeline, preview, none).reason).toBe(
      'No piano is connected and this browser cannot play sound. Listen is not available.',
    )
    const right = { hands: 'right' as const, range: null, multiplier: 1 }
    const rightTimeline = selectionTimeline(score, score.tempo, right)
    expect(startPlan(rightTimeline, right, { ...ok, accompanimentAllowed: false }).reason).toMatch(/echo/)
    expect(startPlan(rightTimeline, right, none).reason).toMatch(
      /^One-hand practice needs the piano or this device .* cannot play sound\.$/,
    )
  })
})
