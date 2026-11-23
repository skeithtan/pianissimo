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

  it('plans reading, scored and Listen starts with plain reasons', () => {
    const sel = { hands: 'both' as const, range: null, multiplier: 1 }
    const timeline = selectionTimeline(score, score.tempo, sel)
    expect(startPlan(timeline, sel, 'wait', ok)).toEqual({ action: 'reading', enabled: true, reason: null })
    expect(startPlan(timeline, sel, 'wait', { ...ok, hasTempo: false })).toMatchObject({
      enabled: false,
      reason: 'Set a practice tempo so the score can follow the timing.',
    })
    const left = { hands: 'left' as const, range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 }
    const plan = startPlan(selectionTimeline(score, score.tempo, left), left, 'wait', ok)
    expect(plan).toEqual({
      action: 'scored',
      enabled: false,
      reason: 'Left hand has no notes to play here. Choose other hands or bars.',
    })
    expect(startPlan(timeline, sel, 'listen', ok)).toEqual({ action: 'listen', enabled: true, reason: null })
    // Nothing can play (no piano and no device sound): Listen says why.
    const none = {
      ...ok,
      hasOutput: false,
      noOutputReason: 'No piano is connected and this browser cannot play sound.',
    }
    expect(startPlan(timeline, sel, 'listen', none).reason).toBe(
      'No piano is connected and this browser cannot play sound. Listen is not available.',
    )
    expect(startPlan(timeline, sel, 'listen', { ...ok, hasTempo: false }).reason).toBe(
      'Set a practice tempo to listen.',
    )
    const right = { hands: 'right' as const, range: null, multiplier: 1 }
    const rightTimeline = selectionTimeline(score, score.tempo, right)
    const places = { piano: true, device: true }
    expect(startPlan(rightTimeline, right, 'wait', { ...ok, accompanimentAllowed: false, otherHand: places })).toEqual({
      action: 'reading',
      enabled: false,
      reason: null,
      otherHand: places,
    })
    // "Connected piano" without one, where this device could play: the question still helps.
    expect(
      startPlan(rightTimeline, right, 'wait', { ...none, otherHand: { piano: false, device: true } }),
    ).toMatchObject({
      enabled: false,
      reason: null,
      otherHand: { device: true },
    })
    // Anything else that keeps it from starting is said first.
    const asks = { ...ok, accompanimentAllowed: false }
    expect(startPlan({ ...rightTimeline, groups: [] }, right, 'wait', asks)).toMatchObject({
      reason: expect.stringContaining('has no notes'),
    })
    expect(startPlan(rightTimeline, right, 'time', { ...asks, scorePlayback: true }).otherHand).toBeDefined()
    expect(startPlan(rightTimeline, right, 'wait', none).reason).toMatch(
      /^One-hand practice needs the piano or this device .* cannot play sound\.$/,
    )
  })

  it('Listen plays one hand with no output check, and says when that hand has nothing here', () => {
    const right = { hands: 'right' as const, range: null, multiplier: 1 }
    const unverified = { ...ok, accompanimentAllowed: false }
    expect(startPlan(selectionTimeline(score, score.tempo, right), right, 'listen', unverified)).toEqual({
      action: 'listen',
      enabled: true,
      reason: null,
    })
    const left = { hands: 'left' as const, range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, left), left, 'listen', ok)).toEqual({
      action: 'listen',
      enabled: false,
      reason: 'Left hand has no notes to play here. Choose other hands or bars.',
    })
  })

  it('plans Follow with the reading blockers and never a scored one (P12)', () => {
    const sel = { hands: 'both' as const, range: null, multiplier: 1 }
    const timeline = selectionTimeline(score, score.tempo, sel)
    expect(startPlan(timeline, sel, 'follow', ok)).toEqual({ action: 'play', enabled: true, reason: null })
    expect(startPlan(timeline, sel, 'follow', { ...ok, hasTempo: false })).toMatchObject({
      action: 'play',
      enabled: false,
    })
    const right = { hands: 'right' as const, range: null, multiplier: 1 }
    const rightTimeline = selectionTimeline(score, score.tempo, right)
    expect(startPlan(rightTimeline, right, 'follow', { ...ok, hasOutput: false })).toMatchObject({
      action: 'play',
      enabled: false,
    })
    expect(startPlan(rightTimeline, right, 'follow', { ...ok, accompanimentAllowed: false })).toMatchObject({
      enabled: false,
      otherHand: { piano: true },
    })
    // A passage with a scored blocker (the left hand has no notes in bars 1–2) still plays through
    // the whole piece, which has left-hand notes.
    const left = { hands: 'left' as const, range: null, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, left), left, 'follow', ok)).toMatchObject({
      action: 'play',
      enabled: true,
    })
  })

  it('plans Keep time as a scored attempt over the whole piece or the loop, with the scored blockers', () => {
    const sel = { hands: 'both' as const, range: null, multiplier: 1 }
    const timeline = selectionTimeline(score, score.tempo, sel)
    expect(startPlan(timeline, sel, 'time', ok)).toEqual({ action: 'scored', enabled: true, reason: null })
    expect(startPlan(timeline, sel, 'time', { ...ok, hasTempo: false })).toMatchObject({
      action: 'scored',
      enabled: false,
    })
    const loop = { hands: 'both' as const, range: { fromOcc: 2, toOcc: 2 }, multiplier: 1 }
    expect(startPlan(selectionTimeline(score, score.tempo, loop), loop, 'time', ok).action).toBe('scored')
  })

  it('only Keep time’s Playback needs an output for both hands', () => {
    const sel = { hands: 'both' as const, range: null, multiplier: 1 }
    const timeline = selectionTimeline(score, score.tempo, sel)
    const playback = { ...ok, accompanimentAllowed: false, scorePlayback: true }
    expect(startPlan(timeline, sel, 'time', playback).reason).toMatch(/^Playback needs an echo-free output/)
    for (const mode of ['listen', 'wait', 'follow'] as const)
      expect(startPlan(timeline, sel, mode, playback).enabled).toBe(true)
  })
})

describe('start plans without a piano input', () => {
  const both = { hands: 'both', range: null, multiplier: 1 } as const
  const right = { hands: 'right', range: null, multiplier: 1 } as const
  const timeline = selectionTimeline(score, score.tempo, both)
  const rightTimeline = selectionTimeline(score, score.tempo, right)
  const noInput = { ...ok, hasInput: false }

  it('Wait and Keep time name themselves, also before any other reason, with or without a microphone', () => {
    for (const ctx of [noInput, { ...noInput, mic: true }, { ...noInput, hasTempo: false }]) {
      expect(startPlan(timeline, both, 'wait', ctx)).toEqual({
        action: 'reading',
        enabled: false,
        reason: 'Wait needs a connected piano.',
      })
      expect(startPlan(timeline, both, 'time', ctx)).toEqual({
        action: 'scored',
        enabled: false,
        reason: 'Keep time needs a connected piano.',
      })
    }
    const loop = { ...right, range: { fromOcc: 0, toOcc: 0 } }
    expect(startPlan(selectionTimeline(score, score.tempo, loop), loop, 'wait', noInput)).toEqual({
      action: 'scored',
      enabled: false,
      reason: 'Wait needs a connected piano.',
    })
  })

  it('Follow takes the microphone with any hand, and needs one of the two (DECISIONS P15, P22)', () => {
    expect(startPlan(timeline, both, 'follow', { ...noInput, mic: true })).toEqual({
      action: 'play',
      enabled: true,
      reason: null,
    })
    // One hand: the app plays nothing, so no output or echo test is needed.
    const silentRoute = { ...noInput, hasOutput: false, accompanimentAllowed: false, mic: true }
    expect(startPlan(rightTimeline, right, 'follow', silentRoute)).toEqual({
      action: 'play',
      enabled: true,
      reason: null,
    })
    expect(startPlan(timeline, both, 'follow', noInput)).toEqual({
      action: 'play',
      enabled: false,
      reason: 'Follow needs a connected piano or a microphone.',
    })
  })

  it('Listen needs neither', () => {
    expect(startPlan(timeline, both, 'listen', noInput)).toEqual({ action: 'listen', enabled: true, reason: null })
  })

  it('keeps the real blockers of Follow through the microphone: tempo, notes', () => {
    const mic = { ...noInput, mic: true }
    expect(startPlan(timeline, both, 'follow', { ...mic, hasTempo: false })).toMatchObject({
      enabled: false,
      reason: 'Set a practice tempo so the score can follow the timing.',
    })
    expect(startPlan({ ...rightTimeline, groups: [] }, right, 'follow', mic)).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('has no notes to play here'),
    })
  })

  it('with a piano, one hand following the piano still needs a verified echo-free output', () => {
    const unverified = { ...ok, accompanimentAllowed: false }
    expect(startPlan(rightTimeline, right, 'follow', unverified)).toMatchObject({
      enabled: false,
      reason: null,
      otherHand: { piano: true },
    })
    expect(startPlan(rightTimeline, right, 'follow', { ...unverified, mic: true })).toMatchObject({ enabled: true })
  })

  it('changes nothing with a piano connected', () => {
    expect(startPlan(timeline, both, 'wait', { ...ok, hasInput: true, mic: true })).toEqual({
      action: 'reading',
      enabled: true,
      reason: null,
    })
    expect(startPlan(timeline, both, 'follow', { ...ok, mic: true })).toEqual({
      action: 'play',
      enabled: true,
      reason: null,
    })
  })
})
