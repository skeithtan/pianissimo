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

  it('plans play-through with the reading blockers and never a scored one (P12)', () => {
    const play = { playThrough: true }
    const sel = { hands: 'both' as const, range: null, multiplier: 1 }
    const timeline = selectionTimeline(score, score.tempo, sel)
    expect(startPlan(timeline, sel, ok, play)).toEqual({ action: 'play', enabled: true, reason: null })
    expect(startPlan(timeline, sel, { ...ok, hasTempo: false }, play)).toMatchObject({ action: 'play', enabled: false })
    const right = { hands: 'right' as const, range: null, multiplier: 1 }
    const rightTimeline = selectionTimeline(score, score.tempo, right)
    expect(startPlan(rightTimeline, right, { ...ok, hasOutput: false }, play)).toMatchObject({
      action: 'play',
      enabled: false,
    })
    expect(startPlan(rightTimeline, right, { ...ok, accompanimentAllowed: false }, play).reason).toMatch(
      /^One-hand play-through needs/,
    )
    // A passage with a scored blocker (the left hand has no notes in bars 1–2) still plays through
    // the whole piece, which has left-hand notes.
    const left = { hands: 'left' as const, range: null, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, left), left, ok, play)).toMatchObject({
      action: 'play',
      enabled: true,
    })
    // Hands off stays Listen.
    const preview = { hands: 'none' as const, range: null, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, preview), preview, ok, play).action).toBe('listen')
  })

  it('plans Keep time as a scored attempt over the whole piece or the loop, with the scored blockers', () => {
    const keep = { rhythm: true }
    const sel = { hands: 'both' as const, range: null, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, sel), sel, ok, keep)).toEqual({
      action: 'scored',
      enabled: true,
      reason: null,
    })
    expect(startPlan(selectionTimeline(score, score.tempo, sel), sel, { ...ok, hasTempo: false }, keep)).toMatchObject({
      action: 'scored',
      enabled: false,
    })
    const loop = { hands: 'both' as const, range: { fromOcc: 2, toOcc: 2 }, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, loop), loop, ok, keep).action).toBe('scored')
    const preview = { hands: 'none' as const, range: null, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, preview), preview, ok, keep).action).toBe('listen')
  })
})

describe('start plans without a piano input (microphone follower, DECISIONS P15)', () => {
  const both = { hands: 'both', range: null, multiplier: 1 } as const
  const right = { hands: 'right', range: null, multiplier: 1 } as const
  const timeline = selectionTimeline(score, score.tempo, both)
  const rightTimeline = selectionTimeline(score, score.tempo, right)
  const noInput = { ...ok, hasInput: false }

  it('blocks reading and scored practice with a reason', () => {
    expect(startPlan(timeline, both, noInput, { mic: true })).toMatchObject({
      action: 'reading',
      enabled: false,
      reason: 'Reading needs a connected piano. Play through follows the microphone instead.',
    })
    expect(startPlan(timeline, both, noInput, { mic: true, rhythm: true })).toMatchObject({
      action: 'scored',
      enabled: false,
      reason: expect.stringContaining('Scored practice needs a connected piano'),
    })
  })

  it('allows play-through with both hands only, and only with the microphone', () => {
    expect(startPlan(timeline, both, noInput, { playThrough: true, mic: true })).toEqual({
      action: 'play',
      enabled: true,
      reason: null,
    })
    expect(startPlan(rightTimeline, right, noInput, { playThrough: true, mic: true })).toMatchObject({
      action: 'play',
      enabled: false,
      reason: 'One-hand play-through needs the piano: the microphone follows both hands only.',
    })
    expect(startPlan(timeline, both, noInput, { playThrough: true })).toMatchObject({
      action: 'play',
      enabled: false,
      reason: 'Play-through needs a connected piano.',
    })
  })

  it('changes nothing with a piano connected', () => {
    expect(startPlan(timeline, both, { ...ok, hasInput: true }, { mic: true })).toEqual({
      action: 'reading',
      enabled: true,
      reason: null,
    })
    expect(startPlan(timeline, both, ok, { playThrough: true, mic: true })).toEqual({
      action: 'play',
      enabled: true,
      reason: null,
    })
  })
})
